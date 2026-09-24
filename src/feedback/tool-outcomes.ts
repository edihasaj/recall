/**
 * Learn from commands that fail because they do not exist in a repo.
 *
 * Agents guess commands. Across Edi's transcripts they ran `pnpm docs:list`
 * or `npm run docs:list` 2,874 times, and only 20 of 155 repos define that
 * script. Each guess costs a tool call and tokens, and the next session makes
 * the same guess because nothing remembered the failure.
 *
 * Only "not available" failures are learned: a missing package script, an
 * unknown command, a missing make target. A failing test is normal work and
 * teaches nothing about the repo. A command must fail that way in at least two
 * sessions and never succeed in between. When it later succeeds (someone added
 * the script), the memory is retired.
 */

import { and, eq } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { activityEvents } from "../db/schema.js";
import { appendEvidence, createMemory, queryMemories, rejectMemory } from "../models/memory.js";
import { recordAudit } from "../audit/trail.js";
import { redactSensitiveText } from "../security/redaction.js";

const UNAVAILABLE = [
  /\bMissing script\b/i,
  /ERR_PNPM_NO_SCRIPT/,
  /\bNo such script\b/i,
  /\bScript not found\b/i,
  /\bcommand "?[\w:.-]+"? not found\b/i,
  /\bcommand not found\b/i,
  /\bNo rule to make target\b/i,
  /\bunknown (?:command|script)\b/i,
  /\bis not recognized as an internal or external command\b/i,
  /\berror: (?:no such command|unrecognized subcommand)\b/i,
  /\bnpm (?:ERR!|error) Missing script\b/i,
];

const PACKAGE_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "uv", "poetry"]);
const SUBCOMMAND_RUNNERS = new Set(["run", "exec", "x", "dlx"]);
const TARGET_RUNNERS = new Set(["make", "just", "cargo", "go", "npx", "bunx", "uvx"]);

/** Error text that says the command does not exist, as opposed to failing. */
export function isUnavailableFailure(error: string | undefined): boolean {
  return Boolean(error) && UNAVAILABLE.some((pattern) => pattern.test(error!));
}

/**
 * A stable name for "the same command": `pnpm docs:list`, `npm run lint`,
 * `make deploy`. Flags, env assignments, paths and arguments after the target
 * are dropped so `pnpm docs:list 2>/dev/null` and `pnpm docs:list --json` match.
 */
export function commandSignature(command: string | undefined): string | null {
  if (!command) return null;
  // Skip leading `cd dir &&` hops: the command that can be missing comes after.
  const segments = command.split(/&&|\|\||;|\||\n/).map((part) => part.trim()).filter(Boolean);
  const first = segments.find((part) => !/^(?:cd|pushd)\s/.test(part)) ?? "";
  const tokens = first.split(/\s+/)
    .filter((token) => token && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) && !/^\d?>/.test(token));
  if (tokens.length === 0) return null;
  const head = tokens[0].replace(/^.*\//, "");
  const args = tokens.slice(1).filter((token) => !token.startsWith("-") || token === "-m");

  let words: string[];
  if (PACKAGE_RUNNERS.has(head)) {
    words = SUBCOMMAND_RUNNERS.has(args[0] ?? "") ? [head, ...args.slice(0, 2)] : [head, ...args.slice(0, 1)];
  } else if (TARGET_RUNNERS.has(head)) {
    words = [head, ...args.slice(0, 1)];
  } else if (/^python3?$/.test(head)) {
    words = args[0] === "-m" ? [head, ...args.slice(0, 2)] : [head, ...args.slice(0, 1)];
  } else {
    // An unknown command fails on its name alone ("command not found").
    words = [head];
  }
  const signature = words.join(" ").slice(0, 120);
  return /^[\w./:@-]+(?: [\w./:@-]+)*$/.test(signature) ? signature : null;
}

const SHELL_TOOLS = new Set(["bash", "shell", "exec_command", "local_shell", "exec", "powershell"]);

export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name.toLowerCase());
}

/**
 * Exit code and error text from a hook payload. Claude Code reports failures
 * through PostToolUseFailure with an "Exit code N" first line; Codex sends one
 * PostToolUse whose tool_response carries the exit code as a field or as
 * "Process exited with code N" text.
 */
export function toolOutcomeFromPayload(payload: {
  hook_event_name?: string;
  error?: unknown;
  tool_response?: unknown;
}): { exit_code: number; error?: string } {
  const codeIn = (text: string) =>
    text.match(/(?:^|\n)\s*exit code:?\s*(-?\d+)|process exited with code\s*(-?\d+)/i);
  if (payload.hook_event_name === "PostToolUseFailure" || typeof payload.error === "string") {
    const error = typeof payload.error === "string" ? payload.error : "";
    const match = codeIn(error);
    return { exit_code: match ? Number(match[1] ?? match[2]) || 1 : 1, error };
  }
  const response = payload.tool_response;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const fields = response as Record<string, unknown>;
    const code = [fields.exit_code, fields.exitCode, fields.returncode, fields.code].find((v) => typeof v === "number");
    if (typeof code === "number") {
      const text = [fields.stderr, fields.output, fields.stdout].find((v) => typeof v === "string") as string | undefined;
      return code === 0 ? { exit_code: 0 } : { exit_code: code, error: text?.slice(-2000) };
    }
  }
  const text = typeof response === "string"
    ? response
    : Array.isArray(response)
      ? response.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n")
      : "";
  const match = codeIn(text);
  const code = match ? Number(match[1] ?? match[2]) : 0;
  return code === 0 ? { exit_code: 0 } : { exit_code: code, error: text.slice(-2000) };
}

export interface ToolOutcome {
  repo: string | null;
  session_id: string;
  command?: string;
  exit_code: number;
  error?: string;
}

function memoryText(signature: string, error: string): string {
  const reason = error.split("\n").map((line) => line.trim())
    .find((line) => line && !/^exit code \d+$/i.test(line)) ?? "not available";
  return `\`${signature}\` does not work in this repo (${redactSensitiveText(reason).slice(0, 140)}). Do not run it; check the repo's scripts or docs for the right command.`;
}

function learnedMemories(db: RecallDb, repo: string, signature: string) {
  return queryMemories(db, { repo })
    .filter((m) => m.source === "tool_outcome" && m.status !== "rejected")
    .filter((m) => m.evidence.some((e) => e.type === "tool_outcome" && commandSignature(e.command) === signature));
}

/** Sessions in this repo where the command failed as unavailable, since its last success. */
function failingSessions(db: RecallDb, repo: string, signature: string): Set<string> {
  const rows = db.select({ session: activityEvents.session_id, result: activityEvents.result, at: activityEvents.created_at })
    .from(activityEvents)
    .where(and(eq(activityEvents.repo, repo), eq(activityEvents.event_type, "session_event")))
    .all()
    .filter((row) => (row.result as { tool_call?: unknown })?.tool_call)
    .sort((a, b) => a.at.localeCompare(b.at));
  const sessions = new Set<string>();
  for (const row of rows) {
    const result = row.result as { tool_call: { input_summary?: string; exit_code?: number }; tool_error?: string };
    if (commandSignature(result.tool_call.input_summary) !== signature) continue;
    if (result.tool_call.exit_code === 0) sessions.clear();
    else if (isUnavailableFailure(result.tool_error)) sessions.add(row.session ?? "unknown");
  }
  return sessions;
}

export const MIN_FAILING_SESSIONS = 2;

/**
 * Record what one tool call teaches. Call after the tool event is stored.
 * Returns the memory created, reinforced, or retired, if any.
 */
export function learnFromToolOutcome(
  db: RecallDb,
  outcome: ToolOutcome,
): { action: "created" | "reinforced" | "retired"; memory_id: string } | null {
  if (!outcome.repo) return null;
  const signature = commandSignature(outcome.command);
  if (!signature) return null;
  const existing = learnedMemories(db, outcome.repo, signature);

  if (outcome.exit_code === 0) {
    // The command works now, so the warning is wrong.
    const first = existing[0];
    for (const memory of existing) {
      rejectMemory(db, memory.id, "tool_outcome");
      recordAudit(db, memory.id, "contradiction_resolved", "tool_outcome", `\`${signature}\` succeeded in session ${outcome.session_id}`);
    }
    return first ? { action: "retired", memory_id: first.id } : null;
  }

  if (!isUnavailableFailure(outcome.error)) return null;
  const evidence = {
    type: "tool_outcome" as const,
    session: outcome.session_id,
    command: redactSensitiveText(outcome.command ?? signature).slice(0, 200),
    exit_code: outcome.exit_code,
    error: redactSensitiveText(outcome.error ?? "").slice(0, 300),
    timestamp: new Date().toISOString(),
  };

  if (existing.length > 0) {
    const memory = existing[0];
    if (!memory.evidence.some((e) => e.type === "tool_outcome" && e.session === outcome.session_id)) {
      appendEvidence(db, memory.id, evidence);
    }
    return { action: "reinforced", memory_id: memory.id };
  }

  if (failingSessions(db, outcome.repo, signature).size < MIN_FAILING_SESSIONS) return null;
  const id = createMemory(db, {
    type: "gotcha",
    text: memoryText(signature, outcome.error ?? ""),
    scope: "repo",
    repo: outcome.repo,
    source: "tool_outcome",
    confidence: 0.8,
    evidence: [evidence],
  });
  recordAudit(db, id, "created", "tool_outcome", `\`${signature}\` failed as unavailable in ${MIN_FAILING_SESSIONS}+ sessions`);
  return { action: "created", memory_id: id };
}

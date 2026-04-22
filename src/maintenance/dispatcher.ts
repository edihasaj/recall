import type { RecallDb } from "../db/client.js";
import type { MaintenanceTask, MaintenanceTaskKind } from "../types.js";
import {
  TaskClaimConflictError,
  claimTask,
  listTasks,
  releaseTask,
  submitTask,
} from "./tasks.js";
import { callLlm, LlmCredentialError, type LlmProvider } from "../llm/client.js";
import { getApiKey } from "../credentials/keychain.js";

const DISPATCH_AGENT = "recall:dispatcher";
const DEFAULT_LEASE_SECONDS = 120;

export interface DispatchOptions {
  provider?: LlmProvider;
  model?: string;
  maxTasks?: number;
  kinds?: MaintenanceTaskKind[];
  repo?: string;
  dryRun?: boolean;
}

export interface DispatchOutcome {
  task_id: string;
  kind: MaintenanceTaskKind;
  repo: string | null;
  status: "applied" | "rejected" | "released" | "skipped";
  reason?: string;
  target_id?: string;
  changed_fields?: string[];
  prompt_tokens?: number;
  completion_tokens?: number;
  cost_usd?: number | null;
  duration_ms?: number;
}

export interface DispatchReport {
  provider: LlmProvider | null;
  model: string | null;
  dry_run: boolean;
  attempted: number;
  applied: number;
  rejected: number;
  released: number;
  outcomes: DispatchOutcome[];
}

export async function dispatchPendingTasks(
  db: RecallDb,
  options: DispatchOptions = {},
): Promise<DispatchReport> {
  const provider = resolveProvider(options.provider);
  const report: DispatchReport = {
    provider,
    model: null,
    dry_run: Boolean(options.dryRun),
    attempted: 0,
    applied: 0,
    rejected: 0,
    released: 0,
    outcomes: [],
  };
  if (!provider) return report;

  const pending = listTasks(db, {
    status: "pending",
    kinds: options.kinds,
    repo: options.repo,
    limit: options.maxTasks ?? 5,
  });

  for (const task of pending) {
    if (options.dryRun) {
      report.outcomes.push({
        task_id: task.id,
        kind: task.kind,
        repo: task.repo,
        status: "skipped",
        reason: "dry-run",
      });
      continue;
    }
    report.attempted += 1;
    const outcome = await runSingle(db, task, provider, options.model);
    report.outcomes.push(outcome);
    if (outcome.status === "applied") report.applied += 1;
    else if (outcome.status === "rejected") report.rejected += 1;
    else if (outcome.status === "released") report.released += 1;
    if (outcome.prompt_tokens != null && !report.model) {
      // remember the model the first successful call used, for display
      const last = report.outcomes[report.outcomes.length - 1];
      report.model = (last as DispatchOutcome & { model?: string }).task_id ? options.model ?? null : null;
    }
  }

  return report;
}

async function runSingle(
  db: RecallDb,
  task: MaintenanceTask,
  provider: LlmProvider,
  model?: string,
): Promise<DispatchOutcome> {
  let claimed: MaintenanceTask;
  try {
    const claim = claimTask(db, task.id, DISPATCH_AGENT, DEFAULT_LEASE_SECONDS);
    claimed = claim.task;
  } catch (err) {
    if (err instanceof TaskClaimConflictError) {
      return {
        task_id: task.id,
        kind: task.kind,
        repo: task.repo,
        status: "skipped",
        reason: err.reason,
      };
    }
    throw err;
  }

  const prompt = buildPrompt(claimed);
  if (!prompt) {
    releaseTask(db, claimed.id, DISPATCH_AGENT);
    return {
      task_id: claimed.id,
      kind: claimed.kind,
      repo: claimed.repo,
      status: "released",
      reason: "no prompt builder",
    };
  }

  try {
    const llmResult = await callLlm(db, {
      provider,
      model,
      system: prompt.system,
      user: prompt.user,
      max_output_tokens: prompt.max_output_tokens,
      task_kind: claimed.kind,
      task_id: claimed.id,
      repo: claimed.repo,
    });

    const parsed = parseJson(llmResult.text);
    if (!parsed) {
      releaseTask(db, claimed.id, DISPATCH_AGENT);
      return {
        task_id: claimed.id,
        kind: claimed.kind,
        repo: claimed.repo,
        status: "released",
        reason: "llm did not return valid JSON",
        prompt_tokens: llmResult.usage.prompt_tokens,
        completion_tokens: llmResult.usage.completion_tokens,
        cost_usd: llmResult.usage.cost_usd,
        duration_ms: llmResult.duration_ms,
      };
    }

    const submit = submitTask(db, claimed.id, DISPATCH_AGENT, parsed);
    if (submit.status === "applied") {
      return {
        task_id: claimed.id,
        kind: claimed.kind,
        repo: claimed.repo,
        status: "applied",
        target_id: submit.target_id,
        changed_fields: submit.changed_fields,
        prompt_tokens: llmResult.usage.prompt_tokens,
        completion_tokens: llmResult.usage.completion_tokens,
        cost_usd: llmResult.usage.cost_usd,
        duration_ms: llmResult.duration_ms,
      };
    }
    return {
      task_id: claimed.id,
      kind: claimed.kind,
      repo: claimed.repo,
      status: "rejected",
      reason: submit.reason,
      prompt_tokens: llmResult.usage.prompt_tokens,
      completion_tokens: llmResult.usage.completion_tokens,
      cost_usd: llmResult.usage.cost_usd,
      duration_ms: llmResult.duration_ms,
    };
  } catch (err) {
    releaseTask(db, claimed.id, DISPATCH_AGENT);
    const reason = err instanceof LlmCredentialError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
    return {
      task_id: claimed.id,
      kind: claimed.kind,
      repo: claimed.repo,
      status: "released",
      reason,
    };
  }
}

function resolveProvider(preferred?: LlmProvider): LlmProvider | null {
  const candidates: LlmProvider[] = preferred
    ? [preferred]
    : ["anthropic", "openai"];
  for (const provider of candidates) {
    if (getApiKey(provider)) return provider;
  }
  return null;
}

function parseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // Strip code fences if present.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // Some models return a leading sentence before the JSON. Try to locate the first {.
    const first = stripped.indexOf("{");
    const last = stripped.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(stripped.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

interface Prompt {
  system: string;
  user: string;
  max_output_tokens?: number;
}

function buildPrompt(task: MaintenanceTask): Prompt | null {
  switch (task.kind) {
    case "refine_candidate":
      return buildRefineCandidatePrompt(task);
    case "summarize_history":
      return buildSummarizeHistoryPrompt(task);
    case "merge_duplicates":
      return buildMergeDuplicatesPrompt(task);
    case "summarize_session":
      return buildSummarizeSessionPrompt(task);
    case "synthesize_repo":
      return buildSynthesizeRepoPrompt(task);
    default:
      return null;
  }
}

const JSON_ONLY = "Respond with a single JSON object matching the required schema, no prose, no markdown fences.";

function buildRefineCandidatePrompt(task: MaintenanceTask): Prompt {
  const payload = task.payload as {
    memory_id?: string;
    text?: string;
    current_scope?: string;
    current_path_scope?: string | null;
    repo?: string | null;
    repetition_count?: number;
  };
  const system = [
    "You refine candidate memories in a coding-agent memory store.",
    "Keep only durable rules/commands/gotchas. Clamp scope tighter when the evidence is path-specific.",
    JSON_ONLY,
  ].join(" ");
  const user = [
    `Current memory text: ${JSON.stringify(payload.text ?? "")}`,
    `Current scope: ${payload.current_scope ?? "repo"}`,
    `Current path_scope: ${JSON.stringify(payload.current_path_scope ?? null)}`,
    `Repo: ${JSON.stringify(payload.repo ?? null)}`,
    `Repetition count: ${payload.repetition_count ?? 0}`,
    "",
    'Return JSON: {"refined_text": string, "scope": "session"|"path"|"repo"|"team", "path_scope": string|null, "rationale": string}',
  ].join("\n");
  return { system, user };
}

function buildSummarizeHistoryPrompt(task: MaintenanceTask): Prompt {
  const payload = task.payload as {
    current_text?: string;
    kind?: string;
    repo?: string | null;
  };
  const system = [
    "You compress activity snippets in a coding-agent memory store.",
    "Keep the essential facts; drop filler. <= 3 short sentences.",
    JSON_ONLY,
  ].join(" ");
  const user = [
    `Kind: ${payload.kind ?? "unknown"}`,
    `Repo: ${JSON.stringify(payload.repo ?? null)}`,
    `Current text: ${JSON.stringify(payload.current_text ?? "")}`,
    "",
    'Return JSON: {"summary_text": string, "tags": [string, ...]}',
  ].join("\n");
  return { system, user };
}

function buildMergeDuplicatesPrompt(task: MaintenanceTask): Prompt {
  const payload = task.payload as {
    cluster?: Array<{ id: string; text: string; confidence?: number; scope?: string; path_scope?: string | null }>;
    repo?: string | null;
  };
  const system = [
    "You pick the best memory among near-duplicates in a coding-agent memory store.",
    "Choose the single winning id. You may also rewrite the winner's text for clarity, and tighten its scope if evidence supports it.",
    JSON_ONLY,
  ].join(" ");
  const user = [
    `Repo: ${JSON.stringify(payload.repo ?? null)}`,
    `Cluster:`,
    JSON.stringify(payload.cluster ?? [], null, 2),
    "",
    'Return JSON: {"winner_id": uuid, "winner_text"?: string, "winner_scope"?: "session"|"path"|"repo"|"team", "winner_path_scope"?: string|null, "rationale"?: string}',
  ].join("\n");
  return { system, user };
}

function buildSummarizeSessionPrompt(task: MaintenanceTask): Prompt {
  const payload = task.payload as { events?: unknown[]; session_id?: string; repo?: string | null };
  const system = [
    "You condense a coding-agent session into a brief durable summary.",
    "<= 5 short bullet points; no filler.",
    JSON_ONLY,
  ].join(" ");
  const user = [
    `Session: ${payload.session_id ?? "unknown"}`,
    `Repo: ${JSON.stringify(payload.repo ?? null)}`,
    `Events: ${JSON.stringify(payload.events ?? [], null, 2).slice(0, 12_000)}`,
    "",
    'Return JSON: {"summary_text": string}',
  ].join("\n");
  return { system, user };
}

function buildSynthesizeRepoPrompt(task: MaintenanceTask): Prompt {
  const payload = task.payload as { repo?: string | null; memories?: unknown[] };
  const system = [
    "You synthesize a concise repo-level summary from the stable memory set.",
    "Focus on commands, rules, gotchas, and decisions that repeat across sessions.",
    JSON_ONLY,
  ].join(" ");
  const user = [
    `Repo: ${JSON.stringify(payload.repo ?? null)}`,
    `Memory set: ${JSON.stringify(payload.memories ?? [], null, 2).slice(0, 12_000)}`,
    "",
    'Return JSON: {"summary_text": string}',
  ].join("\n");
  return { system, user };
}

export function formatDispatchReport(report: DispatchReport): string {
  const lines: string[] = [
    "# Recall Maintenance Dispatch",
    `Provider:   ${report.provider ?? "(none — no API key)"}`,
    `Dry run:    ${report.dry_run ? "yes" : "no"}`,
    `Attempted:  ${report.attempted}`,
    `Applied:    ${report.applied}`,
    `Rejected:   ${report.rejected}`,
    `Released:   ${report.released}`,
  ];
  if (report.outcomes.length > 0) {
    lines.push("", "## Outcomes");
    for (const o of report.outcomes) {
      const cost = o.cost_usd != null ? ` $${o.cost_usd.toFixed(4)}` : "";
      const tokens = o.prompt_tokens != null ? ` tokens=${(o.prompt_tokens ?? 0) + (o.completion_tokens ?? 0)}` : "";
      const reason = o.reason ? ` — ${o.reason}` : "";
      lines.push(`  ${o.task_id.slice(0, 8)} ${o.kind.padEnd(20)} ${o.status.padEnd(10)}${tokens}${cost}${reason}`);
    }
  }
  return lines.join("\n");
}

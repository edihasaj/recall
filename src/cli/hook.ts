import { listActivityEvents, createActivityEvent } from "../models/activity.js";
import { initDb } from "../db/client.js";
import { inferRepoSlugFromPath } from "../repo/discovery.js";
import type { RecallDb } from "../db/client.js";
import type { ActivitySource } from "../types.js";
import type { RecentToolCall } from "../agents/types.js";
import {
  endSessionLifecycle,
  startSessionLifecycle,
} from "../session/lifecycle.js";

const DEFAULT_DAEMON_ORIGIN = `http://127.0.0.1:${process.env.RECALL_PORT ?? "7890"}`;
const DEFAULT_DAEMON_TIMEOUT_MS = 25;
const MAX_PROMPT_TEXT_LENGTH = 8_192;
const MAX_PREV_ASSISTANT_LENGTH = 2_048;
const MAX_TOOL_INPUT_SUMMARY_LENGTH = 1_024;
const MAX_RECENT_TOOL_CALLS = 3;

export interface PromptHookInput {
  text: string;
  repo?: string;
  repo_path?: string;
  session_id?: string;
  path?: string;
  prev_assistant_turn?: string;
  recent_tool_calls?: readonly RecentToolCall[];
  agent?: string;
}

export interface ToolHookInput {
  name: string;
  exit_code: number;
  repo?: string;
  repo_path?: string;
  session_id?: string;
  path?: string;
  input_summary?: string;
  agent?: string;
}

export interface SessionStartHookInput {
  session_id: string;
  repo?: string;
  repo_path?: string;
  path?: string;
  agent: string;
}

export interface SessionEndHookInput {
  session_id: string;
  repo?: string;
  repo_path?: string;
  path?: string;
  turn_count?: number;
  agent?: string;
}

export interface HookRuntimeOptions {
  db?: RecallDb;
  source?: ActivitySource;
}

export interface HookExecutionOptions extends HookRuntimeOptions {
  daemonOrigin?: string;
  daemonTimeoutMs?: number;
}

export interface HookResult {
  event:
    | "prompt_submitted"
    | "tool_invoked"
    | "session_started"
    | "session_ended";
  session_id: string;
  repo: string | null;
  transport: "daemon" | "fallback" | "direct";
  recent_tool_calls?: RecentToolCall[];
}

interface ClaudeCodeHookPayload {
  cwd?: string;
  hook_event_name?: string;
  permission_mode?: string;
  prompt?: string;
  reason?: string;
  session_id?: string;
  source?: string;
  tool_input?: Record<string, unknown>;
  tool_name?: string;
  transcript_path?: string;
}

export async function executePromptHook(
  input: PromptHookInput,
  opts: HookExecutionOptions = {},
): Promise<HookResult> {
  const daemonResult = await postHookToDaemon<HookResult>(
    "/hook/prompt",
    input,
    opts,
  );
  if (daemonResult) return daemonResult;
  const result = await handlePromptHook(input, {
    db: opts.db,
    source: opts.source ?? "cli",
  });
  return { ...result, transport: "fallback" };
}

export async function executeToolHook(
  input: ToolHookInput,
  opts: HookExecutionOptions = {},
): Promise<HookResult> {
  const daemonResult = await postHookToDaemon<HookResult>(
    "/hook/tool",
    input,
    opts,
  );
  if (daemonResult) return daemonResult;
  const result = await handleToolHook(input, {
    db: opts.db,
    source: opts.source ?? "cli",
  });
  return { ...result, transport: "fallback" };
}

export async function executeSessionStartHook(
  input: SessionStartHookInput,
  opts: HookExecutionOptions = {},
): Promise<HookResult> {
  const daemonResult = await postHookToDaemon<HookResult>(
    "/hook/session-start",
    input,
    opts,
  );
  if (daemonResult) return daemonResult;
  const result = await handleSessionStartHook(input, {
    db: opts.db,
    source: opts.source ?? "cli",
  });
  return { ...result, transport: "fallback" };
}

export async function executeSessionEndHook(
  input: SessionEndHookInput,
  opts: HookExecutionOptions = {},
): Promise<HookResult> {
  const daemonResult = await postHookToDaemon<HookResult>(
    "/hook/session-end",
    input,
    opts,
  );
  if (daemonResult) return daemonResult;
  const result = await handleSessionEndHook(input, {
    db: opts.db,
    source: opts.source ?? "cli",
  });
  return { ...result, transport: "fallback" };
}

export async function handlePromptHook(
  input: PromptHookInput,
  opts: HookRuntimeOptions = {},
): Promise<HookResult> {
  const text = truncateText(requireNonEmpty(input.text, "text"), MAX_PROMPT_TEXT_LENGTH);
  const db = opts.db ?? initDb();
  const sessionId = input.session_id?.trim() || "hook";
  const repo = resolveRepo(input.repo, input.repo_path);
  const recentToolCalls = normalizeRecentToolCalls(
    input.recent_tool_calls ?? loadRecentToolCalls(db, sessionId),
  );

  createActivityEvent(db, {
    session_id: sessionId,
    repo,
    path: input.path ?? null,
    source: opts.source ?? "cli",
    event_type: "session_event",
    request: {
      client: input.agent ?? "hook",
      name: "prompt_submitted",
      repo_path: input.repo_path ?? null,
    },
    result: {
      text,
      prev_assistant_turn: truncateOptionalText(
        input.prev_assistant_turn,
        MAX_PREV_ASSISTANT_LENGTH,
      ),
      recent_tool_calls: recentToolCalls,
      submitted_at: new Date().toISOString(),
    },
  });

  return {
    event: "prompt_submitted",
    session_id: sessionId,
    repo,
    recent_tool_calls: recentToolCalls,
    transport: "direct",
  };
}

export async function handleToolHook(
  input: ToolHookInput,
  opts: HookRuntimeOptions = {},
): Promise<HookResult> {
  const name = requireNonEmpty(input.name, "name");
  const db = opts.db ?? initDb();
  const sessionId = input.session_id?.trim() || "hook";
  const repo = resolveRepo(input.repo, input.repo_path);
  const toolCall = {
    name,
    input_summary: truncateOptionalText(input.input_summary, MAX_TOOL_INPUT_SUMMARY_LENGTH),
    exit_code: input.exit_code,
  } satisfies RecentToolCall;

  createActivityEvent(db, {
    session_id: sessionId,
    repo,
    path: input.path ?? null,
    source: opts.source ?? "cli",
    event_type: "session_event",
    request: {
      client: input.agent ?? "hook",
      name: "tool_invoked",
      repo_path: input.repo_path ?? null,
    },
    result: {
      tool_call: toolCall,
      invoked_at: new Date().toISOString(),
    },
  });

  return {
    event: "tool_invoked",
    session_id: sessionId,
    repo,
    recent_tool_calls: [toolCall],
    transport: "direct",
  };
}

export async function handleSessionStartHook(
  input: SessionStartHookInput,
  opts: HookRuntimeOptions = {},
): Promise<HookResult> {
  const db = opts.db ?? initDb();
  const result = startSessionLifecycle(db, {
    session_id: requireNonEmpty(input.session_id, "session_id"),
    client: requireNonEmpty(input.agent, "agent"),
    repo: input.repo ?? null,
    repo_path: input.repo_path ?? null,
    path: input.path ?? null,
    meta: {
      hook_event: "session_started",
      started_at: new Date().toISOString(),
    },
  });

  return {
    event: "session_started",
    session_id: result.session_id,
    repo: result.repo,
    transport: "direct",
  };
}

export async function handleSessionEndHook(
  input: SessionEndHookInput,
  opts: HookRuntimeOptions = {},
): Promise<HookResult> {
  const db = opts.db ?? initDb();
  const sessionId = requireNonEmpty(input.session_id, "session_id");
  const repo = resolveRepo(input.repo, input.repo_path);

  endSessionLifecycle(db, {
    session_id: sessionId,
    client: input.agent ?? "hook",
    repo,
    repo_path: input.repo_path ?? null,
    path: input.path ?? null,
    payload: {
      ended_at: new Date().toISOString(),
      turn_count: input.turn_count ?? null,
    },
  });

  return {
    event: "session_ended",
    session_id: sessionId,
    repo,
    transport: "direct",
  };
}

export function parseRecentToolCallsOption(value?: string): RecentToolCall[] | undefined {
  if (!value) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("recent-tools must be valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("recent-tools must be a JSON array");
  }

  return normalizeRecentToolCalls(
    parsed.map((entry) => {
      if (!entry || typeof entry !== "object") {
        throw new Error("recent-tools entries must be JSON objects");
      }
      const item = entry as Record<string, unknown>;
      return {
        name: requireNonEmpty(String(item.name ?? ""), "recent tool name"),
        input_summary:
          typeof item.input_summary === "string"
            ? truncateText(item.input_summary, MAX_TOOL_INPUT_SUMMARY_LENGTH)
            : undefined,
        exit_code:
          typeof item.exit_code === "number"
            ? item.exit_code
            : typeof item.exit_code === "string"
              ? parseInteger(item.exit_code, "recent tool exit_code")
              : undefined,
      } satisfies RecentToolCall;
    }),
  );
}

export function parseInteger(value: string, field: string): number {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be an integer`);
  }
  return parsed;
}

export async function readClaudeCodePromptInputFromStdin(): Promise<PromptHookInput> {
  const payload = await readClaudeCodeHookPayloadFromStdin();
  return {
    agent: "claude-code",
    path: extractClaudeToolPath(payload.tool_input),
    repo_path: payload.cwd,
    session_id: payload.session_id,
    text: requireNonEmpty(payload.prompt ?? "", "prompt"),
  };
}

export async function readClaudeCodeToolInputFromStdin(): Promise<ToolHookInput> {
  const payload = await readClaudeCodeHookPayloadFromStdin();
  return {
    agent: "claude-code",
    exit_code: 0,
    input_summary: summarizeClaudeToolInput(payload.tool_name, payload.tool_input),
    name: requireNonEmpty(payload.tool_name ?? "", "tool_name"),
    path: extractClaudeToolPath(payload.tool_input),
    repo_path: payload.cwd,
    session_id: payload.session_id,
  };
}

export async function readClaudeCodeSessionStartInputFromStdin(): Promise<SessionStartHookInput> {
  const payload = await readClaudeCodeHookPayloadFromStdin();
  return {
    agent: "claude-code",
    path: extractClaudeToolPath(payload.tool_input),
    repo_path: payload.cwd,
    session_id: requireNonEmpty(payload.session_id ?? "", "session_id"),
  };
}

export async function readClaudeCodeSessionEndInputFromStdin(): Promise<SessionEndHookInput> {
  const payload = await readClaudeCodeHookPayloadFromStdin();
  return {
    agent: "claude-code",
    path: extractClaudeToolPath(payload.tool_input),
    repo_path: payload.cwd,
    session_id: requireNonEmpty(payload.session_id ?? "", "session_id"),
  };
}

async function postHookToDaemon<T>(
  path: string,
  body: unknown,
  opts: HookExecutionOptions,
): Promise<T | null> {
  const origin = opts.daemonOrigin ?? DEFAULT_DAEMON_ORIGIN;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.daemonTimeoutMs ?? DEFAULT_DAEMON_TIMEOUT_MS,
  );

  try {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (response.status === 404 || response.status === 405) {
      return null;
    }

    if (!response.ok) {
      const payload = await safeJson(response);
      throw new Error(
        typeof payload?.error === "string"
          ? payload.error
          : `hook request failed with status ${response.status}`,
      );
    }

    return await response.json() as T;
  } catch (error) {
    if (isFallbackableDaemonError(error)) {
      return null;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readClaudeCodeHookPayloadFromStdin(): Promise<ClaudeCodeHookPayload> {
  const raw = await readStdinText();
  if (raw.trim().length === 0) {
    throw new Error("Claude Code hook stdin was empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Claude Code hook stdin must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Claude Code hook stdin must be a JSON object");
  }

  return parsed as ClaudeCodeHookPayload;
}

function loadRecentToolCalls(
  db: RecallDb,
  sessionId: string,
): RecentToolCall[] {
  const toolCalls: RecentToolCall[] = [];

  for (const event of listActivityEvents(db, {
    session_id: sessionId,
    event_type: "session_event",
    limit: 25,
  })) {
    if (event.request.name !== "tool_invoked") continue;
    const toolCall = event.result.tool_call;
    if (!toolCall || typeof toolCall !== "object") continue;
    const input = toolCall as Record<string, unknown>;
    const name = input.name;
    if (typeof name !== "string" || name.trim().length === 0) continue;
    toolCalls.push({
        name: name.trim(),
        input_summary:
          typeof input.input_summary === "string"
            ? truncateText(input.input_summary, MAX_TOOL_INPUT_SUMMARY_LENGTH)
            : undefined,
        exit_code:
          typeof input.exit_code === "number"
            ? input.exit_code
            : undefined,
      });
  }

  return toolCalls.slice(0, MAX_RECENT_TOOL_CALLS).reverse();
}

function normalizeRecentToolCalls(
  toolCalls: readonly RecentToolCall[],
): RecentToolCall[] {
  return [...toolCalls]
    .slice(-MAX_RECENT_TOOL_CALLS)
    .map((toolCall) => ({
      name: truncateText(requireNonEmpty(toolCall.name, "recent tool name"), 256),
      input_summary: truncateOptionalText(
        toolCall.input_summary,
        MAX_TOOL_INPUT_SUMMARY_LENGTH,
      ),
      exit_code: toolCall.exit_code,
    }));
}

function summarizeClaudeToolInput(
  toolName?: string,
  toolInput?: Record<string, unknown>,
): string | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;

  if (typeof toolInput.file_path === "string" && toolInput.file_path.trim().length > 0) {
    return truncateText(toolInput.file_path.trim(), MAX_TOOL_INPUT_SUMMARY_LENGTH);
  }

  if (toolName === "Bash" && typeof toolInput.command === "string") {
    return truncateText(toolInput.command.trim(), MAX_TOOL_INPUT_SUMMARY_LENGTH);
  }

  if (typeof toolInput.path === "string" && toolInput.path.trim().length > 0) {
    return truncateText(toolInput.path.trim(), MAX_TOOL_INPUT_SUMMARY_LENGTH);
  }

  const serialized = JSON.stringify(toolInput);
  return serialized && serialized !== "{}"
    ? truncateText(serialized, MAX_TOOL_INPUT_SUMMARY_LENGTH)
    : undefined;
}

function extractClaudeToolPath(toolInput?: Record<string, unknown>): string | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  if (typeof toolInput.file_path === "string" && toolInput.file_path.trim().length > 0) {
    return toolInput.file_path.trim();
  }
  if (typeof toolInput.path === "string" && toolInput.path.trim().length > 0) {
    return toolInput.path.trim();
  }
  return undefined;
}

function resolveRepo(repo?: string, repoPath?: string): string | null {
  return repo?.trim() || inferRepoSlugFromPath(repoPath) || null;
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
}

function readStdinText(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

function truncateOptionalText(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  return truncateText(value, limit);
}

function truncateText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function isFallbackableDaemonError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  return /\bECONNREFUSED\b|\bENOTFOUND\b|\bEHOSTUNREACH\b/i.test(error.message);
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

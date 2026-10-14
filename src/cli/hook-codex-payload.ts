import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { and, desc, eq, gte, isNotNull, lte, ne, sql } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { activityEvents } from "../db/schema.js";
import { tagActivitySource } from "../types.js";

/**
 * Codex `Stop` payload normalization for `recall hook session-end --codex-stdin`.
 *
 * Codex rust-v0.162.1 (`codex-rs/hooks/src/schema.rs`, `StopCommandInput`)
 * writes a Claude-Code-shaped object to the hook's stdin: `session_id` (the
 * thread id), `turn_id`, `transcript_path`, `cwd`, `hook_event_name: "Stop"`,
 * `model`, `permission_mode`, `stop_hook_active` and `last_assistant_message`
 * (string | null). `session_id` is required by that schema, so the common
 * path is the Claude Code path. This module covers payloads that do not match
 * it (other Codex builds, notify bridges, manual probes), in order:
 *   1. alternate id keys (`thread_id`, `conversationId`, nested envelopes);
 *   2. the thread id embedded in the rollout `transcript_path` filename;
 *   3. the single unambiguous open `hook:codex` session for the same cwd;
 * and otherwise skips quietly — an unattributable Stop is not a Recall failure
 * and must never make the hook exit non-zero or look like a crash.
 */

const SESSION_ID_KEYS = [
  "session_id",
  "sessionId",
  "session-id",
  "thread_id",
  "threadId",
  "conversation_id",
  "conversationId",
] as const;

/** Containers worth descending into. Only identity containers may use a bare `id`. */
const CONTAINER_KEYS = ["session", "thread", "conversation", "payload", "data"] as const;
const IDENTITY_CONTAINERS: ReadonlySet<string> = new Set(["session", "thread", "conversation"]);
const MAX_CONTAINER_DEPTH = 2;

/** Prompt/tool hooks record this placeholder when their payload had no session id. */
const PLACEHOLDER_SESSION_ID = "hook";
export const DEFAULT_RECENT_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Another session active this close to the Stop makes the cwd fallback a
 * guess. Replaying the 140 real Codex Stops in the 2026-10-13 snapshot with
 * their ids removed: "most recent session for cwd" picked the wrong session
 * 11 times; this guard picked it 0 times (43 resolved, 97 refused), and still
 * 0 times when the Stop is delivered twice.
 */
export const DEFAULT_SESSION_AMBIGUITY_WINDOW_MS = 2 * 60 * 1000;
const MAX_CANDIDATE_SESSIONS = 64;

const DEFAULT_HOOK_LOG_MAX_BYTES = 1024 * 1024;

/**
 * Codex rollout files are named `rollout-<local timestamp>-<thread id>.jsonl`
 * (optionally `.zst`-compressed, live or archived); the thread id is the
 * hook `session_id`.
 */
const ROLLOUT_THREAD_ID = /(?:^|[\\/])rollout-[^\\/]*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;

export interface CodexSessionIdMatch {
  session_id: string;
  /** Dotted key path the id was read from, e.g. `session_id` or `payload.thread.id`. */
  key_path: string;
}

/**
 * Read a session id from a Codex hook payload. `session_id` wins; the
 * alternates exist for other id spellings and nested envelopes. `turn_id` is
 * deliberately not a candidate: one session has many turns, and keying on it
 * would scatter a session's injections across phantom sessions.
 */
export function extractCodexSessionId(payload: object): CodexSessionIdMatch | null {
  return findSessionId(payload as Record<string, unknown>, [], false, 0);
}

function findSessionId(
  record: Record<string, unknown>,
  path: readonly string[],
  allowBareId: boolean,
  depth: number,
): CodexSessionIdMatch | null {
  for (const key of SESSION_ID_KEYS) {
    const value = nonEmptyString(record[key]);
    if (value) return { session_id: value, key_path: [...path, key].join(".") };
  }
  if (allowBareId) {
    const value = nonEmptyString(record.id);
    if (value) return { session_id: value, key_path: [...path, "id"].join(".") };
  }
  if (depth >= MAX_CONTAINER_DEPTH) return null;
  for (const key of CONTAINER_KEYS) {
    const nested = record[key];
    if (!isPlainRecord(nested)) continue;
    const match = findSessionId(nested, [...path, key], IDENTITY_CONTAINERS.has(key), depth + 1);
    if (match) return match;
  }
  return null;
}

/** Thread id from a Codex rollout `transcript_path`, or null for any other path. */
export function extractCodexTranscriptSessionId(transcriptPath: unknown): string | null {
  const value = nonEmptyString(transcriptPath);
  if (!value) return null;
  return ROLLOUT_THREAD_ID.exec(value)?.[1] ?? null;
}

export interface RecentCodexSessionQuery {
  /** The payload's `cwd`; matched exactly against the `repo_path` prompt/tool hooks recorded. */
  cwd: string;
  agent?: string;
  now?: Date;
  maxAgeMs?: number;
  ambiguityWindowMs?: number;
}

export type RecentCodexSessionLookup =
  | { status: "found"; session_id: string }
  | { status: "none" }
  | { status: "ambiguous"; candidate_count: number };

/**
 * The open `hook:<agent>` session a Stop without an id belongs to, if exactly
 * one plausibly does. A session is open when its latest hook row for `cwd` is
 * not a `session_end` (Stop fires per turn, so a later prompt reopens it).
 * The most recently active open session wins unless any other session — open
 * or just closed — was active inside the ambiguity window: Codex users run
 * parallel threads in one checkout, and a just-closed rival is what a
 * duplicate Stop looks like. Rows after `now` are ignored so a replay against
 * a snapshot answers "what would have resolved at that time".
 */
export function findRecentCodexSession(
  db: RecallDb,
  query: RecentCodexSessionQuery,
): RecentCodexSessionLookup {
  const now = query.now ?? new Date();
  const maxAgeMs = query.maxAgeMs ?? DEFAULT_RECENT_SESSION_MAX_AGE_MS;
  const ambiguityWindowMs = query.ambiguityWindowMs ?? DEFAULT_SESSION_AMBIGUITY_WINDOW_MS;
  const since = new Date(now.getTime() - maxAgeMs).toISOString();
  const source = tagActivitySource("hook", query.agent ?? "codex");
  const lastAt = sql<string>`max(${activityEvents.created_at})`;

  // SQLite fills a bare column in a max() aggregate from the max row, so
  // `event_type` is each session's latest event.
  const sessions = db
    .select({
      session_id: activityEvents.session_id,
      last_at: lastAt,
      last_event: activityEvents.event_type,
    })
    .from(activityEvents)
    .where(and(
      eq(activityEvents.source, source),
      isNotNull(activityEvents.session_id),
      ne(activityEvents.session_id, PLACEHOLDER_SESSION_ID),
      ne(activityEvents.session_id, ""),
      gte(activityEvents.created_at, since),
      lte(activityEvents.created_at, now.toISOString()),
      sql`json_extract(${activityEvents.request}, '$.repo_path') = ${query.cwd}`,
    ))
    .groupBy(activityEvents.session_id)
    .orderBy(desc(lastAt))
    .limit(MAX_CANDIDATE_SESSIONS)
    .all();

  const top = sessions.find((session) => session.last_event !== "session_end");
  const topId = nonEmptyString(top?.session_id);
  if (!top || !topId) return { status: "none" };

  const rivalCutoff = now.getTime() - ambiguityWindowMs;
  const rivals = sessions.filter((session) =>
    session.session_id !== top.session_id && Date.parse(session.last_at) >= rivalCutoff,
  );
  if (rivals.length > 0) return { status: "ambiguous", candidate_count: rivals.length + 1 };
  return { status: "found", session_id: topId };
}

export type CodexSessionEndUnresolvedReason =
  | "no_session_id_no_cwd"
  | "no_recent_session_for_cwd"
  | "ambiguous_recent_sessions";

export interface CodexSessionEndResolved {
  status: "resolved";
  session_id: string;
  /** Payload key path, `transcript_path`, or `recent_session:<cwd>` for the DB fallback. */
  resolved_via: string;
}

export interface CodexSessionEndUnresolved {
  status: "unresolved";
  reason: CodexSessionEndUnresolvedReason;
  agent: string;
  cwd: string | null;
  hook_event_name: string | null;
  turn_id: string | null;
  /** Key names only — values may contain prompt text. */
  payload_keys: string[];
  max_age_ms: number;
  /** Sessions competing for the Stop when `reason` is `ambiguous_recent_sessions`. */
  candidate_count?: number;
}

export type CodexSessionEndResolution = CodexSessionEndResolved | CodexSessionEndUnresolved;

export interface ResolveCodexSessionEndOptions {
  agent?: string;
  /** Opened lazily: a payload that carries its own id never touches the DB. */
  getDb: () => RecallDb;
  now?: Date;
  maxAgeMs?: number;
  ambiguityWindowMs?: number;
}

export function resolveCodexSessionEndSessionId(
  payload: object,
  opts: ResolveCodexSessionEndOptions,
): CodexSessionEndResolution {
  const direct = extractCodexSessionId(payload);
  if (direct) {
    return { status: "resolved", session_id: direct.session_id, resolved_via: direct.key_path };
  }

  const record = payload as Record<string, unknown>;
  const fromTranscript = extractCodexTranscriptSessionId(record.transcript_path);
  if (fromTranscript) {
    return { status: "resolved", session_id: fromTranscript, resolved_via: "transcript_path" };
  }

  const agent = opts.agent ?? "codex";
  const cwd = nonEmptyString(record.cwd);
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_RECENT_SESSION_MAX_AGE_MS;
  const details = {
    agent,
    cwd,
    hook_event_name: nonEmptyString(record.hook_event_name),
    turn_id: nonEmptyString(record.turn_id),
    payload_keys: Object.keys(record).sort(),
    max_age_ms: maxAgeMs,
  };
  if (!cwd) {
    return { status: "unresolved", reason: "no_session_id_no_cwd", ...details };
  }

  const recent = findRecentCodexSession(opts.getDb(), {
    cwd,
    agent,
    now: opts.now,
    maxAgeMs,
    ambiguityWindowMs: opts.ambiguityWindowMs,
  });
  if (recent.status === "found") {
    return { status: "resolved", session_id: recent.session_id, resolved_via: `recent_session:${cwd}` };
  }
  if (recent.status === "ambiguous") {
    return {
      status: "unresolved",
      reason: "ambiguous_recent_sessions",
      candidate_count: recent.candidate_count,
      ...details,
    };
  }
  return { status: "unresolved", reason: "no_recent_session_for_cwd", ...details };
}

/**
 * Session id for a Codex Stop read from stdin. Notes every non-standard
 * resolution in hook-debug.log, and exits 0 (via
 * `exitCodexSessionEndUnresolved`) when nothing resolves.
 */
export function resolveCodexSessionIdOrExit(
  payload: object,
  opts: ResolveCodexSessionEndOptions,
): string {
  const resolution = resolveCodexSessionEndSessionId(payload, opts);
  if (resolution.status === "unresolved") exitCodexSessionEndUnresolved(resolution);
  if (resolution.resolved_via !== "session_id") {
    appendHookDebugLog(
      `session-end resolved (${opts.agent ?? "codex"}): session_id=${resolution.session_id} resolved_via=${resolution.resolved_via}`,
    );
  }
  return resolution.session_id;
}

export function hookDebugLogPath(): string {
  // Same directory as hook-errors.log (safeHookAction in cli.ts), so one
  // place holds every hook-side note regardless of RECALL_DATA_DIR.
  return join(homedir(), ".recall", "logs", "hook-debug.log");
}

/** Best-effort append; rotation mirrors hook-errors.log (`RECALL_HOOK_LOG_MAX_BYTES`). */
export function appendHookDebugLog(line: string): void {
  try {
    const logPath = hookDebugLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    rotateIfOversized(logPath);
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // A debug note must never turn into a hook failure.
  }
}

function rotateIfOversized(logPath: string): void {
  const configured = process.env.RECALL_HOOK_LOG_MAX_BYTES;
  const maxBytes = configured === undefined ? DEFAULT_HOOK_LOG_MAX_BYTES : Number.parseInt(configured, 10);
  if (!(maxBytes > 0)) return;
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;
  const rotated = `${logPath}.1`;
  rmSync(rotated, { force: true });
  renameSync(logPath, rotated);
}

export function formatCodexSessionEndUnresolved(details: CodexSessionEndUnresolved): string {
  const hours = details.max_age_ms / 3_600_000;
  const window = Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
  const why = details.reason === "no_session_id_no_cwd"
    ? "payload has no session id and no cwd"
    : details.reason === "ambiguous_recent_sessions"
      ? `payload has no session id and ${details.candidate_count ?? "several"} ${details.agent} sessions were active in cwd`
      : `payload has no session id and no open ${details.agent} session for cwd in the last ${window}`;
  return [
    `session-end skipped (${details.agent}): ${why}`,
    `reason=${details.reason}`,
    `cwd=${JSON.stringify(details.cwd)}`,
    `hook_event_name=${JSON.stringify(details.hook_event_name)}`,
    `turn_id=${JSON.stringify(details.turn_id)}`,
    `payload_keys=${details.payload_keys.join(",")}`,
  ].join(" ");
}

/**
 * Default handling for a Codex Stop that no session claims: one debug line,
 * exit 0, nothing on stdout/stderr. Throwing instead would route through
 * `safeHookAction`, which logs a stack trace to hook-errors.log and warns on
 * stderr as if Recall had crashed — wrong for a skip.
 */
export function exitCodexSessionEndUnresolved(details: CodexSessionEndUnresolved): never {
  appendHookDebugLog(formatCodexSessionEndUnresolved(details));
  process.exit(0);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

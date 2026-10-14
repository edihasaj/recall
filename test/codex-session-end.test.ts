import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import {
  extractCodexSessionId,
  extractCodexTranscriptSessionId,
  findRecentCodexSession,
  formatCodexSessionEndUnresolved,
  resolveCodexSessionEndSessionId,
  type CodexSessionEndUnresolved,
} from "../src/cli/hook-codex-payload.js";

const tsxEntry = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const cliEntry = resolve(process.cwd(), "src/cli.ts");
const fixturePath = resolve(process.cwd(), "test/fixtures/codex/stop-hook-input.json");
const CLI_TEST_TIMEOUT_MS = 60_000;
const NOW = new Date("2026-10-13T12:00:00.000Z");
const CWD = "/Users/example/Projects/example";

// Required keys of `stop.command.input` in codex-rs rust-v0.162.1
// (codex-rs/hooks/src/schema.rs, StopCommandInput).
const CODEX_STOP_REQUIRED_KEYS = [
  "cwd",
  "hook_event_name",
  "last_assistant_message",
  "model",
  "permission_mode",
  "session_id",
  "stop_hook_active",
  "transcript_path",
  "turn_id",
];

function loadFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
}

const openDbs: RecallDb[] = [];

function freshDb(dir = mkdtempSync(join(tmpdir(), "recall-codex-stop-"))): RecallDb {
  const db = initStandaloneDb(join(dir, "recall.db"));
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.$client.close();
});

function seed(db: RecallDb, row: {
  session_id: string;
  at: Date | string;
  event_type?: string;
  source?: string;
  repo_path?: string | null;
}) {
  const createdAt = typeof row.at === "string" ? row.at : row.at.toISOString();
  db.$client.prepare(
    `insert into activity_events (id, session_id, source, event_type, request, result, created_at)
     values (?, ?, ?, ?, ?, '{}', ?)`,
  ).run(
    randomUUID(),
    row.session_id,
    row.source ?? "hook:codex",
    row.event_type ?? "session_event",
    JSON.stringify({ client: "codex", name: "tool_invoked", repo_path: row.repo_path === undefined ? CWD : row.repo_path }),
    createdAt,
  );
}

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

const MIN = 60_000;

describe("Codex Stop payload shape", () => {
  it("fixture matches the codex-rs 0.162.1 StopCommandInput required keys", () => {
    expect(Object.keys(loadFixture()).sort()).toEqual([...CODEX_STOP_REQUIRED_KEYS].sort());
  });

  it("resolves the standard payload from session_id without opening the DB", () => {
    const resolution = resolveCodexSessionEndSessionId(loadFixture(), {
      getDb: () => { throw new Error("DB must not be opened"); },
    });
    expect(resolution).toEqual({
      status: "resolved",
      session_id: "01a1f000-0000-7000-8000-00000000c0de",
      resolved_via: "session_id",
    });
  });

  it("reads alternate and nested id keys but never turn_id or a bare top-level id", () => {
    expect(extractCodexSessionId({ thread_id: "t-1" })).toEqual({ session_id: "t-1", key_path: "thread_id" });
    expect(extractCodexSessionId({ conversationId: "c-1" })).toEqual({ session_id: "c-1", key_path: "conversationId" });
    expect(extractCodexSessionId({ payload: { thread: { id: "n-1" } } }))
      .toEqual({ session_id: "n-1", key_path: "payload.thread.id" });
    expect(extractCodexSessionId({ session_id: "  ", thread_id: "t-2" }))
      .toEqual({ session_id: "t-2", key_path: "thread_id" });
    expect(extractCodexSessionId({ turn_id: "turn-1", id: "x" })).toBeNull();
    expect(extractCodexSessionId({ payload: { id: "x" } })).toBeNull();
  });

  it("extracts the thread id from rollout transcript paths only", () => {
    const id = "01a1f000-0000-7000-8000-00000000c0de";
    expect(extractCodexTranscriptSessionId(`/h/.codex/sessions/2026/10/13/rollout-2026-10-13T14-00-00-${id}.jsonl`)).toBe(id);
    expect(extractCodexTranscriptSessionId(`/h/.codex/archived_sessions/rollout-2026-10-13T14-00-00-${id}.jsonl.zst`)).toBe(id);
    expect(extractCodexTranscriptSessionId(`C:\\Users\\e\\.codex\\sessions\\rollout-2026-10-13T14-00-00-${id}.jsonl`)).toBe(id);
    expect(extractCodexTranscriptSessionId(`/h/.claude/projects/x/${id}.jsonl`)).toBeNull();
    expect(extractCodexTranscriptSessionId("/h/notes/rollout-plan.jsonl")).toBeNull();
    expect(extractCodexTranscriptSessionId(null)).toBeNull();
  });

  it("resolves from transcript_path before touching the DB", () => {
    const { session_id: _drop, ...payload } = loadFixture();
    const resolution = resolveCodexSessionEndSessionId(payload, {
      getDb: () => { throw new Error("DB must not be opened"); },
    });
    expect(resolution).toEqual({
      status: "resolved",
      session_id: "01a1f000-0000-7000-8000-00000000c0de",
      resolved_via: "transcript_path",
    });
  });
});

describe("findRecentCodexSession", () => {
  it("returns the single open session for cwd", () => {
    const db = freshDb();
    seed(db, { session_id: "s-open", at: ago(30_000) });
    expect(findRecentCodexSession(db, { cwd: CWD, now: NOW })).toEqual({ status: "found", session_id: "s-open" });
  });

  it("does not resolve to a session whose latest row is session_end", () => {
    const db = freshDb();
    seed(db, { session_id: "s-closed", at: ago(10 * MIN) });
    seed(db, { session_id: "s-closed", at: ago(9 * MIN), event_type: "session_end" });
    expect(findRecentCodexSession(db, { cwd: CWD, now: NOW })).toEqual({ status: "none" });
  });

  it("picks an open session over an older closed one outside the window", () => {
    const db = freshDb();
    seed(db, { session_id: "s-closed", at: ago(20 * MIN), event_type: "session_end" });
    seed(db, { session_id: "s-open", at: ago(30_000) });
    expect(findRecentCodexSession(db, { cwd: CWD, now: NOW })).toEqual({ status: "found", session_id: "s-open" });
  });

  it("refuses when two sessions were active inside the ambiguity window", () => {
    const db = freshDb();
    seed(db, { session_id: "s-a", at: ago(20_000) });
    seed(db, { session_id: "s-b", at: ago(60_000) });
    expect(findRecentCodexSession(db, { cwd: CWD, now: NOW })).toEqual({ status: "ambiguous", candidate_count: 2 });
  });

  it("refuses when a just-closed rival exists (duplicate Stop)", () => {
    const db = freshDb();
    seed(db, { session_id: "s-old-open", at: ago(10 * MIN) });
    seed(db, { session_id: "s-just-stopped", at: ago(40_000) });
    seed(db, { session_id: "s-just-stopped", at: ago(1_000), event_type: "session_end" });
    expect(findRecentCodexSession(db, { cwd: CWD, now: NOW })).toEqual({ status: "ambiguous", candidate_count: 2 });
  });

  it("resolves when the runner-up is older than the ambiguity window", () => {
    const db = freshDb();
    seed(db, { session_id: "s-recent", at: ago(30_000) });
    seed(db, { session_id: "s-stale", at: ago(5 * MIN) });
    expect(findRecentCodexSession(db, { cwd: CWD, now: NOW })).toEqual({ status: "found", session_id: "s-recent" });
  });

  it("ignores other cwds, other agents, placeholders, stale rows and rows after now", () => {
    const db = freshDb();
    seed(db, { session_id: "s-other-cwd", at: ago(10_000), repo_path: "/elsewhere" });
    seed(db, { session_id: "s-claude", at: ago(10_000), source: "hook:claude-code" });
    seed(db, { session_id: "hook", at: ago(10_000) });
    seed(db, { session_id: "s-stale", at: ago(25 * 60 * MIN) });
    seed(db, { session_id: "s-future", at: new Date(NOW.getTime() + MIN) });
    expect(findRecentCodexSession(db, { cwd: CWD, now: NOW })).toEqual({ status: "none" });
  });
});

describe("resolveCodexSessionEndSessionId fallbacks", () => {
  const bare = { cwd: CWD, hook_event_name: "Stop", turn_id: "turn-3", last_assistant_message: "secret reply text" };

  it("falls back to the single open session for cwd", () => {
    const db = freshDb();
    seed(db, { session_id: "s-open", at: ago(30_000) });
    expect(resolveCodexSessionEndSessionId(bare, { getDb: () => db, now: NOW })).toEqual({
      status: "resolved",
      session_id: "s-open",
      resolved_via: `recent_session:${CWD}`,
    });
  });

  it("reports no cwd, no session and ambiguity as unresolved reasons", () => {
    const db = freshDb();
    expect(resolveCodexSessionEndSessionId({ hook_event_name: "Stop" }, { getDb: () => db, now: NOW }))
      .toMatchObject({ status: "unresolved", reason: "no_session_id_no_cwd" });
    expect(resolveCodexSessionEndSessionId(bare, { getDb: () => db, now: NOW }))
      .toMatchObject({ status: "unresolved", reason: "no_recent_session_for_cwd", cwd: CWD, turn_id: "turn-3" });
    seed(db, { session_id: "s-a", at: ago(20_000) });
    seed(db, { session_id: "s-b", at: ago(40_000) });
    expect(resolveCodexSessionEndSessionId(bare, { getDb: () => db, now: NOW }))
      .toMatchObject({ status: "unresolved", reason: "ambiguous_recent_sessions", candidate_count: 2 });
  });

  it("formats the skip note with key names only, never payload values", () => {
    const db = freshDb();
    const resolution = resolveCodexSessionEndSessionId(bare, { getDb: () => db, now: NOW });
    expect(resolution.status).toBe("unresolved");
    const line = formatCodexSessionEndUnresolved(resolution as CodexSessionEndUnresolved);
    expect(line).toContain("reason=no_recent_session_for_cwd");
    expect(line).toContain("payload_keys=cwd,hook_event_name,last_assistant_message,turn_id");
    expect(line).not.toContain("secret reply text");
  });
});

// End-to-end through `recall hook session-end` with an isolated HOME, data
// dir and a closed daemon port, so the direct fallback path runs and nothing
// touches the live install.
describe("recall hook session-end (CLI)", () => {
  let home: string;
  let dataDir: string;
  let cwd: string;
  let port: number;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "recall-codex-stop-home-"));
    dataDir = mkdtempSync(join(tmpdir(), "recall-codex-stop-data-"));
    cwd = mkdtempSync(join(tmpdir(), "recall-codex-stop-cwd-"));
    port = await freePort();
  });

  function runHook(args: string[], payload: unknown) {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("RECALL_")) env[key] = value;
    }
    Object.assign(env, {
      HOME: home,
      RECALL_DATA_DIR: dataDir,
      RECALL_PORT: String(port),
      RECALL_HOOK_DAEMON_TIMEOUT_MS: "2000",
      RECALL_EMBEDDINGS_DISABLED: "true",
      RECALL_LLM_CAPTURE_DISABLED: "true",
      RECALL_REPO_ROOTS: "/nonexistent-recall-test-repo-roots",
    });
    return spawnSync(process.execPath, [tsxEntry, cliEntry, "hook", "session-end", ...args], {
      env,
      cwd,
      input: JSON.stringify(payload),
      encoding: "utf8",
    });
  }

  function prepareDb(seedRows?: (db: RecallDb) => void) {
    const db = initStandaloneDb(join(dataDir, "recall.db"));
    seedRows?.(db);
    db.$client.close();
  }

  function sessionEnds(): Array<{ session_id: string; source: string }> {
    const db = initStandaloneDb(join(dataDir, "recall.db"));
    try {
      return db.$client
        .prepare("select session_id, source from activity_events where event_type = 'session_end' order by created_at")
        .all() as Array<{ session_id: string; source: string }>;
    } finally {
      db.$client.close();
    }
  }

  const errorsLog = () => join(home, ".recall", "logs", "hook-errors.log");
  const debugLog = () => join(home, ".recall", "logs", "hook-debug.log");

  it("Claude Code: records session_end from session_id (unchanged)", () => {
    prepareDb();
    const result = runHook(["--agent", "claude-code", "--claude-code-stdin"], {
      session_id: "cc-session-1",
      cwd,
      hook_event_name: "Stop",
    });
    expect(result.status).toBe(0);
    expect(sessionEnds()).toEqual([{ session_id: "cc-session-1", source: "hook:claude-code" }]);
    expect(existsSync(errorsLog())).toBe(false);
    expect(existsSync(debugLog())).toBe(false);
  }, CLI_TEST_TIMEOUT_MS);

  it("Claude Code: a payload without session_id still fails through safeHookAction (unchanged)", () => {
    prepareDb();
    const result = runHook(["--agent", "claude-code", "--claude-code-stdin"], { cwd, hook_event_name: "Stop" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("session-end hook hit a snag");
    expect(readFileSync(errorsLog(), "utf8")).toContain("session_id is required");
    expect(sessionEnds()).toEqual([]);
  }, CLI_TEST_TIMEOUT_MS);

  it("Codex: records session_end from the real Stop payload shape", () => {
    prepareDb();
    const result = runHook(["--agent", "codex", "--codex-stdin"], { ...loadFixture(), cwd });
    expect(result.status).toBe(0);
    expect(sessionEnds()).toEqual([{ session_id: "01a1f000-0000-7000-8000-00000000c0de", source: "hook:codex" }]);
    expect(existsSync(errorsLog())).toBe(false);
    expect(existsSync(debugLog())).toBe(false);
  }, CLI_TEST_TIMEOUT_MS);

  it("Codex: resolves an alternate id key and notes it", () => {
    prepareDb();
    const { session_id: _drop, transcript_path: _path, ...rest } = loadFixture();
    const result = runHook(["--agent", "codex", "--codex-stdin"], { ...rest, cwd, thread_id: "thread-alt-1" });
    expect(result.status).toBe(0);
    expect(sessionEnds()).toEqual([{ session_id: "thread-alt-1", source: "hook:codex" }]);
    expect(readFileSync(debugLog(), "utf8")).toContain("resolved_via=thread_id");
    expect(existsSync(errorsLog())).toBe(false);
  }, CLI_TEST_TIMEOUT_MS);

  it("Codex: without any id, resolves to the single open session for cwd", () => {
    prepareDb((db) => {
      db.$client.prepare(
        `insert into activity_events (id, session_id, source, event_type, request, result, created_at)
         values (?, 'codex-open-1', 'hook:codex', 'session_event', ?, '{}', ?)`,
      ).run(
        randomUUID(),
        JSON.stringify({ client: "codex", name: "prompt_submitted", repo_path: cwd }),
        new Date(Date.now() - 30_000).toISOString(),
      );
    });
    const result = runHook(["--agent", "codex", "--codex-stdin"], {
      cwd,
      hook_event_name: "Stop",
      turn_id: "turn-9",
      last_assistant_message: null,
    });
    expect(result.status).toBe(0);
    expect(sessionEnds()).toEqual([{ session_id: "codex-open-1", source: "hook:codex" }]);
    expect(readFileSync(debugLog(), "utf8")).toContain("resolved_via=recent_session:");
    expect(existsSync(errorsLog())).toBe(false);
  }, CLI_TEST_TIMEOUT_MS);

  it("Codex: without any id or open session, exits 0 with a debug note and no error", () => {
    prepareDb();
    const result = runHook(["--agent", "codex", "--codex-stdin"], {
      cwd,
      hook_event_name: "Stop",
      turn_id: "turn-9",
      last_assistant_message: "private text",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("hit a snag");
    expect(sessionEnds()).toEqual([]);
    expect(existsSync(errorsLog())).toBe(false);
    const note = readFileSync(debugLog(), "utf8");
    expect(note).toContain("session-end skipped (codex)");
    expect(note).toContain("reason=no_recent_session_for_cwd");
    expect(note).not.toContain("private text");
  }, CLI_TEST_TIMEOUT_MS);
});

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

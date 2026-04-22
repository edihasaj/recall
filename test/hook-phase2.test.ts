import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { closeDb, initStandaloneDb } from "../src/db/client.js";
import { listActivityEvents } from "../src/models/activity.js";
import {
  executeToolHook,
  handlePromptHook,
  handleSessionEndHook,
  handleSessionStartHook,
  handleToolHook,
  parseRecentToolCallsOption,
} from "../src/cli/hook.js";

let dbCounter = 0;

beforeEach(() => {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
});

afterEach(() => {
  closeDb();
});

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-hook-db-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

function makeRepo(root: string, remote: string) {
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], {
    cwd: root,
    stdio: "ignore",
  });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: {
        test: "vitest run",
      },
    }),
  );
}

describe("phase 2 hook handlers", () => {
  it("stores tool context and reuses it on the next prompt", async () => {
    const db = freshDb();

    await handleToolHook(
      {
        session_id: "sess-1",
        repo: "edihasaj/recall",
        name: "Edit",
        exit_code: 0,
        input_summary: "update src/cli.ts",
      },
      { db },
    );
    await handleToolHook(
      {
        session_id: "sess-1",
        repo: "edihasaj/recall",
        name: "Write",
        exit_code: 0,
        input_summary: "create src/cli/hook.ts",
      },
      { db },
    );

    const result = await handlePromptHook(
      {
        session_id: "sess-1",
        repo: "edihasaj/recall",
        text: "do phase 2",
        prev_assistant_turn: "phase 2 first",
      },
      { db },
    );

    expect(result.recent_tool_calls).toEqual([
      {
        name: "Edit",
        input_summary: "update src/cli.ts",
        exit_code: 0,
      },
      {
        name: "Write",
        input_summary: "create src/cli/hook.ts",
        exit_code: 0,
      },
    ]);

    const promptEvent = listActivityEvents(db, {
      session_id: "sess-1",
      event_type: "session_event",
      limit: 1,
    })[0];
    expect(promptEvent.request.name).toBe("prompt_submitted");
    expect(promptEvent.result.text).toBe("do phase 2");
    expect(promptEvent.result.recent_tool_calls).toEqual(result.recent_tool_calls);
  });

  it("records session start and end through the existing lifecycle", async () => {
    const db = freshDb();
    const repoRoot = mkdtempSync(join(tmpdir(), "recall-hook-repo-"));
    makeRepo(repoRoot, "https://github.com/edihasaj/hook-phase2.git");

    const started = await handleSessionStartHook(
      {
        session_id: "sess-2",
        agent: "codex",
        repo_path: repoRoot,
      },
      { db },
    );
    const ended = await handleSessionEndHook(
      {
        session_id: "sess-2",
        repo_path: repoRoot,
        turn_count: 4,
      },
      { db },
    );

    expect(started.repo).toBe("edihasaj/hook-phase2");
    expect(ended.repo).toBe("edihasaj/hook-phase2");

    const events = listActivityEvents(db, { session_id: "sess-2" });
    const baseTypes = events
      .map((event) => event.event_type)
      .filter((t) => t !== "feedback")
      .sort();
    expect(baseTypes).toEqual(["scan", "session_end", "session_start"]);
    const sessionEnd = events.find((e) => e.event_type === "session_end")!;
    expect(sessionEnd.result.turn_count).toBe(4);
    const artifact = readFileSync(join(repoRoot, ".recall", "context.md"), "utf-8");
    expect(artifact).toContain("edihasaj/hook-phase2");
  });

  it("falls back to direct sqlite writes when the daemon is unavailable", async () => {
    const db = freshDb();

    const result = await executeToolHook(
      {
        session_id: "sess-3",
        repo: "edihasaj/recall",
        name: "Edit",
        exit_code: 0,
      },
      {
        db,
        daemonOrigin: "http://127.0.0.1:1",
        daemonTimeoutMs: 10,
      },
    );

    expect(result.transport).toBe("fallback");
    const events = listActivityEvents(db, {
      session_id: "sess-3",
      event_type: "session_event",
    });
    expect(events).toHaveLength(1);
    expect(events[0].request.name).toBe("tool_invoked");
  });

  it("keeps hook handlers under the phase 2 warm-db latency budgets", async () => {
    const db = freshDb();

    await handlePromptHook(
      { session_id: "warm", repo: "edihasaj/recall", text: "warm prompt" },
      { db },
    );
    await handleToolHook(
      { session_id: "warm", repo: "edihasaj/recall", name: "Edit", exit_code: 0 },
      { db },
    );
    await handleSessionStartHook(
      { session_id: "warm-start", agent: "codex" },
      { db },
    );
    await handleSessionEndHook(
      { session_id: "warm-end", turn_count: 1 },
      { db },
    );

    const promptStart = performance.now();
    await handlePromptHook(
      { session_id: "bench", repo: "edihasaj/recall", text: "bench prompt" },
      { db },
    );
    const promptMs = performance.now() - promptStart;

    const toolStart = performance.now();
    await handleToolHook(
      { session_id: "bench", repo: "edihasaj/recall", name: "Edit", exit_code: 0 },
      { db },
    );
    const toolMs = performance.now() - toolStart;

    const sessionStart = performance.now();
    await handleSessionStartHook(
      { session_id: "bench-start", agent: "codex" },
      { db },
    );
    const sessionStartMs = performance.now() - sessionStart;

    const sessionEnd = performance.now();
    await handleSessionEndHook(
      { session_id: "bench-end", turn_count: 2 },
      { db },
    );
    const sessionEndMs = performance.now() - sessionEnd;

    expect(promptMs).toBeLessThan(80);
    expect(toolMs).toBeLessThan(30);
    expect(sessionStartMs).toBeLessThan(50);
    expect(sessionEndMs).toBeLessThan(50);
  });

  it("parses recent tool calls from CLI JSON", () => {
    expect(
      parseRecentToolCallsOption(
        JSON.stringify([
          { name: "Edit", input_summary: "foo", exit_code: 0 },
          { name: "Write", exit_code: "1" },
        ]),
      ),
    ).toEqual([
      { name: "Edit", input_summary: "foo", exit_code: 0 },
      { name: "Write", exit_code: 1 },
    ]);
  });
});

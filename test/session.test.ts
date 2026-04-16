import { beforeEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { listActivityEvents } from "../src/models/activity.js";
import {
  endSessionLifecycle,
  recordSessionLifecycleEvent,
  startSessionLifecycle,
} from "../src/session/lifecycle.js";

let dbCounter = 0;

beforeEach(() => {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
});

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-session-db-"));
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

describe("session lifecycle", () => {
  it("bootstraps unseen repo on session start and records session events", () => {
    const db = freshDb();
    const repoRoot = mkdtempSync(join(tmpdir(), "recall-session-repo-"));
    makeRepo(repoRoot, "https://github.com/edihasaj/session-start.git");

    const started = startSessionLifecycle(db, {
      session_id: "sess-1",
      client: "codex",
      repo_path: repoRoot,
      meta: { argv: ["codex"] },
    });
    expect(started.repo).toBe("edihasaj/session-start");
    expect(started.bootstrap_status).toBe("bootstrapped");
    expect(started.created_ids.length).toBeGreaterThan(0);
    const artifact = readFileSync(join(repoRoot, ".recall", "context.md"), "utf-8");
    expect(artifact).toContain("# Recall Context");
    expect(artifact).toContain("edihasaj/session-start");
    const excludePath = execFileSync(
      "git",
      ["-C", repoRoot, "rev-parse", "--git-path", "info/exclude"],
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    expect(readFileSync(excludePath, "utf-8")).toContain(".recall/");

    recordSessionLifecycleEvent(db, {
      session_id: "sess-1",
      client: "codex",
      repo_path: repoRoot,
      name: "prompt_submitted",
      payload: { prompts: 1 },
    });

    endSessionLifecycle(db, {
      session_id: "sess-1",
      client: "codex",
      repo_path: repoRoot,
      payload: { exit_code: 0 },
    });

    const events = listActivityEvents(db, { session_id: "sess-1" });
    expect(events.map((event) => event.event_type).sort()).toEqual([
      "scan",
      "session_end",
      "session_event",
      "session_start",
    ].sort());
    expect(events[0].result.exit_code).toBe(0);
  }, 10_000);

  it("does not rescan known repos on later session starts", () => {
    const db = freshDb();
    const repoRoot = mkdtempSync(join(tmpdir(), "recall-session-repeat-"));
    makeRepo(repoRoot, "https://github.com/edihasaj/session-repeat.git");

    startSessionLifecycle(db, {
      session_id: "sess-1",
      client: "claude",
      repo_path: repoRoot,
    });
    const second = startSessionLifecycle(db, {
      session_id: "sess-2",
      client: "claude",
      repo_path: repoRoot,
    });

    expect(second.bootstrap_status).toBe("already_known");
    expect(second.created_ids).toHaveLength(0);
    const scanEvents = listActivityEvents(db, {
      repo: "edihasaj/session-repeat",
      event_type: "scan",
    });
    expect(scanEvents).toHaveLength(1);
  });
});

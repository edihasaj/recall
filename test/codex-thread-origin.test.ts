import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, initStandaloneDb } from "../src/db/client.js";
import { handlePromptHook } from "../src/cli/hook.js";
import { isAutomatedCodexThread, readCodexThreadSource } from "../src/cli/codex-thread-origin.js";
import { listActivityEvents } from "../src/models/activity.js";

const dir = mkdtempSync(join(tmpdir(), "recall-codex-origin-"));

function rollout(name: string, source: unknown, extra: Record<string, unknown> = {}): string {
  const path = join(dir, `rollout-2026-10-28T10-00-00-${name}.jsonl`);
  const meta = {
    timestamp: "2026-10-28T09:00:00.000Z",
    type: "session_meta",
    payload: { id: name, source, base_instructions: { text: "x".repeat(120_000) }, ...extra },
  };
  writeFileSync(path, `${JSON.stringify(meta)}\n{"type":"event_msg"}\n`);
  return path;
}

describe("codex thread origin", () => {
  it("reads the session_meta source past a large first line", () => {
    expect(readCodexThreadSource(rollout("exec", "exec"))).toBe("exec");
    expect(readCodexThreadSource(rollout("desktop", "vscode"))).toBe("vscode");
    expect(readCodexThreadSource(rollout("child", {
      subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1 } },
    }, { thread_source: "subagent" }))).toBe("subagent");
  });

  it("flags exec, subagent and mcp threads only on positive evidence", () => {
    expect(isAutomatedCodexThread(rollout("exec2", "exec"))).toBe(true);
    expect(isAutomatedCodexThread(rollout("mcp", "mcp"))).toBe(true);
    expect(isAutomatedCodexThread(rollout("child2", { subagent: { thread_spawn: {} } }))).toBe(true);
    expect(isAutomatedCodexThread(rollout("cli", "cli"))).toBe(false);
    expect(isAutomatedCodexThread(rollout("desktop2", "vscode"))).toBe(false);
    expect(isAutomatedCodexThread(join(dir, "missing.jsonl"))).toBe(false);
    expect(isAutomatedCodexThread(undefined)).toBe(false);
    expect(isAutomatedCodexThread(join(dir, "rollout.jsonl.zst"))).toBe(false);
  });
});

describe("prompt hook for automated threads", () => {
  beforeEach(() => { process.env.RECALL_EMBEDDINGS_DISABLED = "true"; });
  afterEach(() => {
    closeDb();
    delete process.env.RECALL_EMBEDDINGS_DISABLED;
  });

  const brief = "Do not use uv. Install tools globally and never change deployment files.";
  const corrections = (db: ReturnType<typeof initStandaloneDb>, sessionId: string) =>
    listActivityEvents(db, { session_id: sessionId, event_type: "correction" });

  it("does not learn corrections from a task brief written by another agent", async () => {
    const db = initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-origin-db-")), "recall.db"));
    await handlePromptHook({ session_id: "worker", repo: "edihasaj/recall", agent: "codex", text: brief, automated: true }, { db });
    expect(corrections(db, "worker")).toHaveLength(0);
    const prompt = listActivityEvents(db, { session_id: "worker", event_type: "session_event" })
      .find((event) => event.request.name === "prompt_submitted");
    expect(prompt?.request.automated).toBe(true);

    await handlePromptHook({ session_id: "typed", repo: "edihasaj/recall", agent: "codex", text: brief }, { db });
    expect(corrections(db, "typed").length).toBeGreaterThan(0);
  });
});

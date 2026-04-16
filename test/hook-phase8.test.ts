import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { getHookCallStats, listHookCalls } from "../src/hooks/calls.js";
import { handlePromptHook, handleToolHook } from "../src/cli/hook.js";

let dbCounter = 0;

function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-hook-phase8-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

describe("phase 8 hook telemetry", () => {
  it("records successful hook calls and reports aggregate stats", async () => {
    const db = freshDb();

    await handlePromptHook(
      { session_id: "sess-1", repo: "edihasaj/recall", text: "phase 8", agent: "codex" },
      { db },
    );
    await handleToolHook(
      { session_id: "sess-1", repo: "edihasaj/recall", name: "Edit", exit_code: 0, agent: "codex" },
      { db },
    );

    const calls = listHookCalls(db);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.ok)).toBe(true);

    const stats = getHookCallStats(db, { agent: "codex" });
    expect(stats.map((row) => row.event).sort()).toEqual(["prompt_submitted", "tool_invoked"]);
    expect(stats.every((row) => row.ok_calls === 1)).toBe(true);
  });

  it("records failed hook calls too", async () => {
    const db = freshDb();

    await expect(
      handleToolHook(
        { session_id: "sess-2", repo: "edihasaj/recall", name: "   ", exit_code: 0, agent: "codex" },
        { db },
      ),
    ).rejects.toThrow("name is required");

    const calls = listHookCalls(db);
    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBe(false);
    const stats = getHookCallStats(db, { agent: "codex" });
    expect(stats[0].error_calls).toBe(1);
  });
});

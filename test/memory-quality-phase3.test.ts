import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory, getMemory, getMemoryFeedback } from "../src/models/memory.js";
import { compileContext } from "../src/compiler/context.js";
import { handlePromptHook, handleToolHook } from "../src/cli/hook.js";

let dbCounter = 0;

function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-memory-quality-p3-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

describe("memory quality phase 3 outcome-after-injection", () => {
  it("tracks injected memories once per memory/session", () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Use pnpm",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });

    const first = compileContext(db, {
      repo: "edihasaj/recall",
      session_id: "sess-1",
    });
    const second = compileContext(db, {
      repo: "edihasaj/recall",
      session_id: "sess-1",
    });

    expect(first.memories_included).toEqual([memoryId]);
    expect(second.memories_included).toEqual([memoryId]);
    const rows = db.$client
      .prepare("select count(*) as count from memory_injections where session_id = ? and memory_id = ?")
      .get("sess-1", memoryId) as { count: number };
    expect(rows.count).toBe(1);
  });

  it("marks followed when a relevant tool runs after injection", async () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Use pnpm",
      scope: "path",
      path_scope: "src/**",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });

    compileContext(db, {
      repo: "edihasaj/recall",
      path: "src/cli.ts",
      session_id: "sess-2",
    });

    await handleToolHook(
      {
        session_id: "sess-2",
        repo: "edihasaj/recall",
        name: "Edit",
        path: "src/cli.ts",
        exit_code: 0,
        agent: "codex",
      },
      { db, source: "cli" },
    );

    const feedback = getMemoryFeedback(db, memoryId);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].outcome).toBe("followed");
    expect(getMemory(db, memoryId)!.confidence).toBeCloseTo(0.85);
  });

  it("leaves outcome unresolved when the next prompt has no relevant tool activity", async () => {
    // Honest signaling (Phase 2.3): we don't know whether a non-applicable
    // prompt means the memory was ignored or simply wasn't relevant, so leave
    // it unresolved instead of writing a misleading "ignored".
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Use pnpm",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });

    compileContext(db, {
      repo: "edihasaj/recall",
      session_id: "sess-3",
    });

    await handlePromptHook(
      {
        session_id: "sess-3",
        repo: "edihasaj/recall",
        text: "thanks, keep going",
        agent: "codex",
      },
      { db, source: "cli" },
    );

    const feedback = getMemoryFeedback(db, memoryId);
    expect(feedback).toHaveLength(0);
    expect(getMemory(db, memoryId)!.confidence).toBeCloseTo(0.8);
  });

  it("marks contradicted when the next prompt repeats the same correction", async () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Do not use npm. Use pnpm instead.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });

    compileContext(db, {
      repo: "edihasaj/recall",
      session_id: "sess-4",
    });

    await handlePromptHook(
      {
        session_id: "sess-4",
        repo: "edihasaj/recall",
        text: "don't use npm, use pnpm",
        agent: "codex",
      },
      { db, source: "cli" },
    );

    const feedback = getMemoryFeedback(db, memoryId);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].outcome).toBe("contradicted");
    expect(getMemory(db, memoryId)!.confidence).toBeCloseTo(0.55);
  });
});

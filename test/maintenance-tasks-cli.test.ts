import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { initStandaloneDb } from "../src/db/client.js";
import { memoryMaintenanceTasks } from "../src/db/schema.js";
import {
  claimTask,
  deleteTask,
  getTaskStats,
  insertTaskIdempotent,
  submitTask,
} from "../src/maintenance/tasks.js";
import { createMemory } from "../src/models/memory.js";

let dbCounter = 0;
function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-mmt-cli-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

describe("maintenance tasks — CLI helpers (phase 5)", () => {
  it("getTaskStats groups by kind and status", () => {
    const db = freshDb();
    insertTaskIdempotent(db, { kind: "summarize_history", target: "a", repo: "r", payload: {} });
    insertTaskIdempotent(db, { kind: "summarize_history", target: "b", repo: "r", payload: {} });
    insertTaskIdempotent(db, { kind: "refine_candidate", target: "c", repo: "r", payload: {} });

    const stats = getTaskStats(db);
    expect(stats.total).toBe(3);
    expect(stats.by_status.pending).toBe(3);
    expect(stats.by_kind.summarize_history).toBe(2);
    expect(stats.by_kind.refine_candidate).toBe(1);
    expect(stats.pending_oldest_created_at).toBeTruthy();
    expect(stats.mean_completion_ms).toBeNull();
  });

  it("getTaskStats counts last-24h completions and mean latency", () => {
    const db = freshDb();
    const memId = createMemory(db, {
      type: "rule", text: "x", scope: "repo", path_scope: null,
      repo: "r", source: "user_correction", confidence: 0.5,
    });
    const taskId = insertTaskIdempotent(db, {
      kind: "refine_candidate",
      target: memId,
      repo: "r",
      payload: { memory_id: memId },
    })!;
    claimTask(db, taskId, "claude-code");
    submitTask(db, taskId, "claude-code", {
      refined_text: "x refined",
      scope: "path",
      path_scope: "src/",
    });

    const stats = getTaskStats(db);
    expect(stats.by_status.completed).toBe(1);
    expect(stats.completed_last_24h).toBe(1);
    expect(stats.mean_completion_ms).not.toBeNull();
  });

  it("deleteTask removes a task by id", () => {
    const db = freshDb();
    const id = insertTaskIdempotent(db, {
      kind: "summarize_history",
      target: "a",
      repo: "r",
      payload: {},
    })!;

    expect(deleteTask(db, id)).toBe(true);
    const row = db.select().from(memoryMaintenanceTasks)
      .where(eq(memoryMaintenanceTasks.id, id)).get();
    expect(row).toBeUndefined();
  });

  it("deleteTask returns false when id is unknown", () => {
    const db = freshDb();
    expect(deleteTask(db, "00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { initStandaloneDb } from "../src/db/client.js";
import { memories } from "../src/db/schema.js";
import { createMemory, getMemory } from "../src/models/memory.js";
import {
  claimTask,
  insertTaskIdempotent,
  submitTask,
} from "../src/maintenance/tasks.js";
import { rollbackMemory, getAuditTrail } from "../src/audit/trail.js";
import {
  computeMaintenanceMetrics,
  computeMetrics,
  formatMetricsReport,
} from "../src/eval/harness.js";

let dbCounter = 0;
function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-mmt-eval-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

function seedRefineAndComplete(
  db: ReturnType<typeof initStandaloneDb>,
  text: string,
): string {
  const memId = createMemory(db, {
    type: "rule",
    text,
    scope: "repo",
    path_scope: null,
    repo: "r",
    source: "user_correction",
    confidence: 0.5,
  });
  const taskId = insertTaskIdempotent(db, {
    kind: "refine_candidate",
    target: memId,
    repo: "r",
    payload: { memory_id: memId },
  })!;
  claimTask(db, taskId, "claude-code");
  submitTask(db, taskId, "claude-code", {
    refined_text: `${text} (refined)`,
    scope: "path",
    path_scope: "src/",
  });
  return memId;
}

describe("phase 7 — maintenance eval metrics", () => {
  it("returns undefined when no maintenance tasks exist", () => {
    const db = freshDb();
    expect(computeMaintenanceMetrics(db)).toBeUndefined();
  });

  it("counts completed/abandoned and computes mean completion latency", () => {
    const db = freshDb();
    seedRefineAndComplete(db, "rule one");
    seedRefineAndComplete(db, "rule two");

    const metrics = computeMaintenanceMetrics(db)!;
    expect(metrics.total_completed).toBe(2);
    expect(metrics.total_abandoned).toBe(0);
    expect(metrics.completed_by_kind.refine_candidate).toBe(2);
    expect(metrics.mean_completion_ms).not.toBeNull();
    expect(metrics.merge_precision).toBeNull();
  });

  it("tracks merge rollbacks against merge-touched memories", () => {
    const db = freshDb();
    // Seed 5 merge clusters (winner + loser), refine 5 times for merge_precision gate.
    const winnerIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const w = createMemory(db, {
        type: "rule", text: `winner-${i}`, scope: "repo", path_scope: null,
        repo: "r", source: "user_correction", confidence: 0.9,
      });
      const l = createMemory(db, {
        type: "rule", text: `loser-${i}`, scope: "repo", path_scope: null,
        repo: "r", source: "user_correction", confidence: 0.5,
      });
      db.update(memories).set({ status: "active" }).where(eq(memories.id, w)).run();

      const taskId = insertTaskIdempotent(db, {
        kind: "merge_duplicates",
        target: [w, l].sort()[0],
        repo: "r",
        payload: {
          repo: "r",
          type: "rule",
          candidates: [w, l].map((id) => ({ id, text: "x", scope: "repo", path_scope: null })),
        },
      })!;
      claimTask(db, taskId, "claude-code");
      submitTask(db, taskId, "claude-code", {
        winner_id: w,
        winner_text: `winner-${i} merged`,
        winner_scope: "repo",
      });
      winnerIds.push(w);
    }

    // Roll back the first winner; should show up in merge_rollbacks.
    const audit = getAuditTrail(db, winnerIds[0]);
    const edited = audit.find((e) => e.action === "edited")!;
    expect(rollbackMemory(db, winnerIds[0], edited.id, "human")).toBe(true);

    const metrics = computeMaintenanceMetrics(db)!;
    expect(metrics.completed_by_kind.merge_duplicates).toBe(5);
    expect(metrics.merge_rollbacks).toBe(1);
    expect(metrics.merge_precision).not.toBeNull();
    expect(metrics.merge_precision!).toBeLessThan(1);
    expect(metrics.merge_precision!).toBeGreaterThan(0);
  });

  it("formatMetricsReport appends a Maintenance section", () => {
    const db = freshDb();
    seedRefineAndComplete(db, "rule");

    const metrics = computeMetrics(db);
    const report = formatMetricsReport(metrics);
    expect(report).toMatch(/## Maintenance/);
    expect(report).toMatch(/Completed tasks:/);
    expect(report).toMatch(/refine_candidate=1/);
  });
});

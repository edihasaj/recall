import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq } from "drizzle-orm";
import { initStandaloneDb } from "../src/db/client.js";
import { historySnippets, memoryMaintenanceTasks } from "../src/db/schema.js";
import { createMemory } from "../src/models/memory.js";
import {
  DEFAULT_ENQUEUE_CONFIG,
  abandonOverAttemptTasks,
  applyBacklogCaps,
  enqueueMaintenanceTasks,
  hasActiveTaskForTarget,
  insertTaskIdempotent,
  listTasks,
  produceRefineCandidateTasks,
  produceSummarizeHistoryTasks,
  sweepExpiredLeases,
} from "../src/maintenance/tasks.js";
import { randomUUID } from "node:crypto";

let dbCounter = 0;
function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-maintenance-tasks-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

function insertSnippet(db: ReturnType<typeof initStandaloneDb>, repo: string) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(historySnippets).values({
    id,
    repo,
    session_id: `sess-${id}`,
    kind: "session_summary",
    text: "raw template text",
    source_activity_ids: [] as any,
    created_at: now,
    updated_at: now,
  }).run();
  return id;
}

describe("tier-2 maintenance tasks — phase 1", () => {
  it("insertTaskIdempotent rejects a second open task for the same target", () => {
    const db = freshDb();
    const id1 = insertTaskIdempotent(db, {
      kind: "refine_candidate",
      target: "mem-1",
      repo: "test/repo",
      payload: { memory_id: "mem-1" },
    });
    const id2 = insertTaskIdempotent(db, {
      kind: "refine_candidate",
      target: "mem-1",
      repo: "test/repo",
      payload: { memory_id: "mem-1" },
    });
    expect(id1).toBeTruthy();
    expect(id2).toBeNull();
    expect(hasActiveTaskForTarget(db, "refine_candidate", "mem-1")).toBe(true);
  });

  it("different kinds on the same target don't collide", () => {
    const db = freshDb();
    const a = insertTaskIdempotent(db, {
      kind: "refine_candidate",
      target: "mem-1",
      repo: "test/repo",
      payload: {},
    });
    const b = insertTaskIdempotent(db, {
      kind: "merge_duplicates",
      target: "mem-1",
      repo: "test/repo",
      payload: {},
    });
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
  });

  it("produceRefineCandidateTasks enqueues weakly-scoped candidates above threshold", async () => {
    const db = freshDb();

    const weak = createMemory(db, {
      type: "rule",
      text: "always use strict mode",
      scope: "repo",
      path_scope: null,
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.5,
    });
    db.update((await import("../src/db/schema.js")).memories)
      .set({ repetition_count: 2, status: "candidate" })
      .where(eq((await import("../src/db/schema.js")).memories.id, weak)).run();

    const alreadyScoped = createMemory(db, {
      type: "rule",
      text: "use pytest for new python tests",
      scope: "path",
      path_scope: "tests/",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.5,
    });
    db.update((await import("../src/db/schema.js")).memories)
      .set({ repetition_count: 5, status: "candidate" })
      .where(eq((await import("../src/db/schema.js")).memories.id, alreadyScoped)).run();

    const noRepeat = createMemory(db, {
      type: "rule",
      text: "one-off thing",
      scope: "repo",
      path_scope: null,
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.5,
    });
    db.update((await import("../src/db/schema.js")).memories)
      .set({ repetition_count: 0, status: "candidate" })
      .where(eq((await import("../src/db/schema.js")).memories.id, noRepeat)).run();

    const count = produceRefineCandidateTasks(db, {
      refine_min_repetition: DEFAULT_ENQUEUE_CONFIG.refine_min_repetition,
    });
    expect(count).toBe(1);

    const tasks = listTasks(db, { kinds: ["refine_candidate"] });
    expect(tasks).toHaveLength(1);
    expect((tasks[0].payload as any).memory_id).toBe(weak);
    expect(tasks[0].priority).toBeGreaterThan(0);
    expect(tasks[0].repo).toBe("test/repo");
  });

  it("produceSummarizeHistoryTasks enqueues recent snippets once", () => {
    const db = freshDb();
    const s1 = insertSnippet(db, "test/repo");
    const s2 = insertSnippet(db, "test/repo");

    const first = produceSummarizeHistoryTasks(db, {
      summary_max_age_days: DEFAULT_ENQUEUE_CONFIG.summary_max_age_days,
    });
    expect(first).toBe(2);

    const second = produceSummarizeHistoryTasks(db, {
      summary_max_age_days: DEFAULT_ENQUEUE_CONFIG.summary_max_age_days,
    });
    expect(second).toBe(0);

    const tasks = listTasks(db, { kinds: ["summarize_history"] });
    expect(tasks.map((t) => (t.payload as any).snippet_id).sort()).toEqual([s1, s2].sort());
  });

  it("sweepExpiredLeases returns leased tasks to pending and bumps attempts", () => {
    const db = freshDb();
    const id = insertTaskIdempotent(db, {
      kind: "summarize_history",
      target: "snip-1",
      repo: null,
      payload: {},
    })!;

    const pastIso = new Date(Date.now() - 60_000).toISOString();
    db.update(memoryMaintenanceTasks)
      .set({
        status: "claimed",
        claimed_by: "agent-x",
        claimed_at: pastIso,
        claim_expires_at: pastIso,
      })
      .where(eq(memoryMaintenanceTasks.id, id)).run();

    const changed = sweepExpiredLeases(db);
    expect(changed).toBe(1);

    const row = db.select().from(memoryMaintenanceTasks)
      .where(eq(memoryMaintenanceTasks.id, id)).get()!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.claimed_by).toBeNull();
  });

  it("abandonOverAttemptTasks flips to abandoned when attempts >= max_attempts", () => {
    const db = freshDb();
    const id = insertTaskIdempotent(db, {
      kind: "summarize_history",
      target: "snip-1",
      repo: null,
      payload: {},
      max_attempts: 2,
    })!;
    db.update(memoryMaintenanceTasks)
      .set({ attempts: 2 })
      .where(eq(memoryMaintenanceTasks.id, id)).run();

    const changed = abandonOverAttemptTasks(db);
    expect(changed).toBe(1);

    const row = db.select().from(memoryMaintenanceTasks)
      .where(eq(memoryMaintenanceTasks.id, id)).get()!;
    expect(row.status).toBe("abandoned");
    expect(row.failure_reason).toBe("max_attempts_exceeded");
  });

  it("applyBacklogCaps drops lowest-priority pending over per-kind cap", () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) {
      insertTaskIdempotent(db, {
        kind: "summarize_history",
        target: `snip-${i}`,
        repo: null,
        payload: { i },
        priority: i,
      });
    }
    const dropped = applyBacklogCaps(db, { max_pending: 100, max_per_kind: 3 });
    expect(dropped).toBe(2);

    const remaining = listTasks(db, { kinds: ["summarize_history"] });
    expect(remaining).toHaveLength(3);
    const priorities = remaining.map((t) => t.priority).sort((a, b) => a - b);
    expect(priorities).toEqual([2, 3, 4]);
  });

  it("enqueueMaintenanceTasks runs producers + sweep + caps and reports counts", async () => {
    const db = freshDb();

    const mem = createMemory(db, {
      type: "rule",
      text: "ship green builds only",
      scope: "repo",
      path_scope: null,
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.5,
    });
    db.update((await import("../src/db/schema.js")).memories)
      .set({ repetition_count: 1, status: "candidate" })
      .where(eq((await import("../src/db/schema.js")).memories.id, mem)).run();
    insertSnippet(db, "test/repo");

    const result = await enqueueMaintenanceTasks(db);
    expect(result.tasks_enqueued).toBe(2);
    expect(result.per_kind.refine_candidate).toBe(1);
    expect(result.per_kind.summarize_history).toBe(1);
    expect(result.expired_leases_swept).toBe(0);
    expect(result.dropped_over_cap).toBe(0);

    const again = await enqueueMaintenanceTasks(db);
    expect(again.tasks_enqueued).toBe(0);
  });
});

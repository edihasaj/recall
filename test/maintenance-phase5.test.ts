import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";
import { createActivityEvent, listActivityEvents } from "../src/models/activity.js";
import { recordFeedback, getMemoryFeedback } from "../src/models/memory.js";
import { flushEmbeddingJobs, loadEmbeddingConfigFromEnv, verifyEmbeddings } from "../src/embeddings/embeddings.js";
import { runMaintenanceCycle, pruneOldActivityEvents, pruneOldFeedbackEvents, runSqliteMaintenance } from "../src/maintenance/lifecycle.js";
import { activityEvents, feedbackEvents } from "../src/db/schema.js";
import { removeMemoryFtsRow } from "../src/vector/sqlite-fts.js";
import { removeMemoryVecRow } from "../src/vector/sqlite-vec.js";

let dbCounter = 0;

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-maintenance-phase5-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

function installEmbeddingMock() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input: string | string[] };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const data = inputs.map((text, index) => ({
      index,
      embedding: text.toLowerCase().includes("pnpm")
        ? [1, 0, 0]
        : [0, 0, 1],
    }));

    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }));
}

afterEach(async () => {
  await flushEmbeddingJobs();
  vi.unstubAllGlobals();
  delete process.env.RECALL_EMBEDDINGS_ENABLED;
  delete process.env.OPENAI_API_KEY;
  delete process.env.RECALL_EMBEDDING_DIMS;
  delete process.env.RECALL_EMBEDDING_VERSION;
});

describe("phase 5 maintenance lifecycle", () => {
  it("prunes old activity and feedback rows by retention", () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Use pnpm",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });

    createActivityEvent(db, {
      session_id: "s1",
      repo: "test/repo",
      source: "cli",
      event_type: "query",
    });
    const feedbackId = recordFeedback(db, memoryId, "s1", true, "followed");

    const oldDate = new Date(Date.now() - (120 * 86_400_000)).toISOString();
    db.update(activityEvents)
      .set({ created_at: oldDate })
      .where(eq(activityEvents.session_id, "s1"))
      .run();
    db.update(feedbackEvents)
      .set({ timestamp: oldDate })
      .where(eq(feedbackEvents.id, feedbackId))
      .run();

    expect(pruneOldActivityEvents(db, 90)).toBe(1);
    expect(pruneOldFeedbackEvents(db, 90)).toBe(1);
    expect(listActivityEvents(db, {})).toHaveLength(0);
    expect(getMemoryFeedback(db, memoryId)).toHaveLength(0);
  });

  it("repairs embedding index drift during maintenance", async () => {
    const db = freshDb();
    installEmbeddingMock();
    process.env.RECALL_EMBEDDINGS_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.RECALL_EMBEDDING_DIMS = "3";
    process.env.RECALL_EMBEDDING_VERSION = "test-v1";

    const memoryId = createMemory(db, {
      type: "rule",
      text: "Use pnpm",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });

    await flushEmbeddingJobs();

    const config = loadEmbeddingConfigFromEnv()!;
    removeMemoryVecRow(db, memoryId, config);
    removeMemoryFtsRow(db, memoryId);

    const before = verifyEmbeddings(db, config);
    expect(before.index_drift).toBe(1);
    expect(before.lexical_drift).toBe(1);

    const result = await runMaintenanceCycle(db, {
      enabled: true,
      interval_seconds: 300,
      stale_days: 90,
      min_health_score: 0.2,
      activity_retention_days: 90,
      feedback_retention_days: 180,
      signal_retention_days: 180,
      history_session_retention_days: 30,
    });

    expect(result.vector_rows_rebuilt).toBe(1);
    expect(result.lexical_rows_rebuilt).toBe(1);

    const after = verifyEmbeddings(db, config);
    expect(after.index_drift).toBe(0);
    expect(after.lexical_drift).toBe(0);
  });

  it("runs sqlite analyze/checkpoint/optimize and guarded vacuum", () => {
    const db = freshDb();
    const sqlite = db.$client;

    sqlite.exec(`
      create table if not exists maintenance_junk (
        id integer primary key,
        payload text not null
      );
    `);

    const insert = sqlite.prepare("insert into maintenance_junk (payload) values (?)");
    const insertMany = sqlite.transaction(() => {
      for (let i = 0; i < 300; i++) {
        insert.run("x".repeat(2000));
      }
    });
    insertMany();
    sqlite.exec("delete from maintenance_junk;");

    const result = runSqliteMaintenance(db, {
      sqlite_analyze_enabled: true,
      sqlite_optimize_enabled: true,
      sqlite_wal_checkpoint_enabled: true,
      sqlite_vacuum_enabled: true,
      sqlite_vacuum_min_free_pages: 1,
      sqlite_vacuum_min_free_ratio: 0,
    });

    expect(result.analyze_ran).toBe(true);
    expect(result.optimize_ran).toBe(true);
    expect(result.checkpoint_ran).toBe(true);
    expect(result.vacuum_ran).toBe(true);
    expect(result.page_count).toBeGreaterThan(0);
    expect(result.freelist_count).toBeGreaterThan(0);
  });
});

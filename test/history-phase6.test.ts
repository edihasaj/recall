import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { initStandaloneDb } from "../src/db/client.js";
import { historySnippets } from "../src/db/schema.js";
import { createActivityEvent } from "../src/models/activity.js";
import { listHistorySnippets } from "../src/history/snippets.js";
import { runMaintenanceCycle } from "../src/maintenance/lifecycle.js";
import { searchHistorySnippets } from "../src/history/retrieval.js";
import { flushEmbeddingJobs } from "../src/embeddings/embeddings.js";

let dbCounter = 0;

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-history-phase6-"));
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

describe("phase 6 history retrieval", () => {
  it("rolls up completed sessions into history snippets", async () => {
    const db = freshDb();

    createActivityEvent(db, {
      session_id: "sess-1",
      repo: "test/repo",
      source: "daemon",
      event_type: "session_start",
      request: { client: "codex" },
      result: {},
    });
    createActivityEvent(db, {
      session_id: "sess-1",
      repo: "test/repo",
      source: "daemon",
      event_type: "correction",
      request: { text: "don't use npm, use pnpm" },
      result: {},
    });
    createActivityEvent(db, {
      session_id: "sess-1",
      repo: "test/repo",
      source: "daemon",
      event_type: "session_end",
      request: {},
      result: { exit_code: 0 },
    });

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

    expect(result.history_snippets_created).toBe(1);
    expect(result.history_summaries_created).toBeGreaterThanOrEqual(1);
    const snippets = listHistorySnippets(db, { repo: "test/repo" });
    expect(snippets.some((snippet) => snippet.kind === "session_summary")).toBe(true);
    expect(snippets.some((snippet) => snippet.kind === "correction_summary")).toBe(true);
  });

  it("searches history snippets independently from memories", async () => {
    const db = freshDb();
    installEmbeddingMock();
    process.env.RECALL_EMBEDDINGS_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.RECALL_EMBEDDING_DIMS = "3";
    process.env.RECALL_EMBEDDING_VERSION = "test-v1";

    createActivityEvent(db, {
      session_id: "sess-2",
      repo: "test/repo",
      source: "daemon",
      event_type: "correction",
      request: { text: "don't use npm, use pnpm" },
      result: {},
    });
    createActivityEvent(db, {
      session_id: "sess-2",
      repo: "test/repo",
      source: "daemon",
      event_type: "session_end",
      request: {},
      result: { exit_code: 0 },
    });

    await runMaintenanceCycle(db, {
      enabled: true,
      interval_seconds: 300,
      stale_days: 90,
      min_health_score: 0.2,
      activity_retention_days: 90,
      feedback_retention_days: 180,
      signal_retention_days: 180,
      history_session_retention_days: 30,
    });

    const results = await searchHistorySnippets(db, "pnpm", {
      repo: "test/repo",
      limit: 5,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].snippet.text).toContain("pnpm");
    expect(results.some((result) => result.snippet.kind === "correction_summary")).toBe(true);
  });

  it("archives old session summaries after repo summaries exist", async () => {
    const db = freshDb();

    createActivityEvent(db, {
      session_id: "sess-3",
      repo: "test/repo",
      source: "daemon",
      event_type: "correction",
      request: { text: "don't use npm, use pnpm" },
      result: {},
    });
    createActivityEvent(db, {
      session_id: "sess-3",
      repo: "test/repo",
      source: "daemon",
      event_type: "session_end",
      request: {},
      result: { exit_code: 0 },
    });

    await runMaintenanceCycle(db, {
      enabled: true,
      interval_seconds: 300,
      stale_days: 90,
      min_health_score: 0.2,
      activity_retention_days: 90,
      feedback_retention_days: 180,
      signal_retention_days: 180,
      history_session_retention_days: 30,
    });

    const session = listHistorySnippets(db, {
      repo: "test/repo",
      kind: "session_summary",
      limit: 10,
    })[0]!;

    db.update(historySnippets)
      .set({ created_at: new Date(Date.now() - 40 * 86_400_000).toISOString() })
      .where(eq(historySnippets.id, session.id))
      .run();

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

    expect(result.history_session_deleted).toBe(1);
    const activeSessions = listHistorySnippets(db, {
      repo: "test/repo",
      kind: "session_summary",
    });
    expect(activeSessions).toHaveLength(0);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { initStandaloneDb } from "../src/db/client.js";
import { historySnippetEmbeddings, historySnippets } from "../src/db/schema.js";
import { createActivityEvent } from "../src/models/activity.js";
import { createHistorySnippet, listHistorySnippets } from "../src/history/snippets.js";
import { runMaintenanceCycle } from "../src/maintenance/lifecycle.js";
import { searchHistorySnippets } from "../src/history/retrieval.js";
import { flushEmbeddingJobs, loadEmbeddingConfigFromEnv } from "../src/embeddings/embeddings.js";
import { installMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";
import { rebuildHistoryVecIndex } from "../src/vector/sqlite-vec-history.js";

let dbCounter = 0;

function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-history-phase6-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

function installEmbeddingMock() {
  installMockEmbeddingProvider((text) => (
    text.toLowerCase().includes("pnpm") ? [1, 0, 0] : [0, 0, 1]
  ));
}

afterEach(async () => {
  await flushEmbeddingJobs();
  vi.restoreAllMocks();
  delete process.env.RECALL_EMBEDDINGS_DISABLED;
  delete process.env.RECALL_EMBEDDING_DIMS;
  delete process.env.RECALL_EMBEDDING_VERSION;
});

describe("phase 6 history retrieval", () => {
  it("dedupes history snippets by structural key", () => {
    const db = freshDb();
    const first = createHistorySnippet(db, {
      repo: "r",
      session_id: "s",
      kind: "session_summary",
      text: "Repo: r\nEvent types: session_start",
    });
    const second = createHistorySnippet(db, {
      repo: "r",
      session_id: "s",
      kind: "session_summary",
      text: "Repo: r\nEvent types:   session_start.",
    });

    expect(second).toBe(first);
    expect(listHistorySnippets(db, { repo: "r" })).toHaveLength(1);
  });

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

  it("rolls up durable prompt decisions into searchable history", async () => {
    const db = freshDb();

    createActivityEvent(db, {
      session_id: "sess-decisions",
      repo: "test/repo",
      source: "hook:codex",
      event_type: "session_event",
      request: { client: "codex", name: "prompt_submitted" },
      result: { text: "we should go with sqlite instead of postgres for the runtime database" },
    });
    createActivityEvent(db, {
      session_id: "sess-decisions",
      repo: "test/repo",
      source: "hook:codex",
      event_type: "session_event",
      request: { client: "codex", name: "prompt_submitted" },
      result: { text: "make the memory cleanup self healing in the daemon" },
    });
    createActivityEvent(db, {
      session_id: "sess-decisions",
      repo: "test/repo",
      source: "hook:codex",
      event_type: "session_event",
      request: { client: "codex", name: "prompt_submitted" },
      result: { text: "do phase 3" },
    });
    createActivityEvent(db, {
      session_id: "sess-decisions",
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

    const session = listHistorySnippets(db, {
      repo: "test/repo",
      kind: "session_summary",
    })[0]!;
    expect(session.text).toContain("Decisions:");
    expect(session.text).toContain("Prefer sqlite over postgres");
    expect(session.text).toContain("User direction: make the memory cleanup self healing in the daemon.");
    expect(session.text).toContain("User direction: do phase 3.");

    const decisionSummary = listHistorySnippets(db, {
      repo: "test/repo",
      kind: "decision_summary",
    })[0]!;
    expect(decisionSummary.text).toContain("Frequent user decisions");
    expect(decisionSummary.text).toContain("sqlite");
    expect(decisionSummary.text).toContain("self healing");
    expect(decisionSummary.text).toContain("do phase 3");

    const results = await searchHistorySnippets(db, "self healing daemon", {
      repo: "test/repo",
    });
    expect(results.some((item) => item.snippet.kind === "decision_summary")).toBe(true);
  });

  it("searches history snippets independently from memories", async () => {
    const db = freshDb();
    delete process.env.RECALL_EMBEDDINGS_DISABLED;
    installEmbeddingMock();
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

  it("refuses to rebuild a mixed-dimension history vec index", async () => {
    const db = freshDb();
    delete process.env.RECALL_EMBEDDINGS_DISABLED;
    installEmbeddingMock();
    process.env.RECALL_EMBEDDING_DIMS = "3";
    process.env.RECALL_EMBEDDING_VERSION = "test-v1";

    createActivityEvent(db, {
      session_id: "sess-4",
      repo: "test/repo",
      source: "daemon",
      event_type: "correction",
      request: { text: "don't use npm, use pnpm" },
      result: {},
    });
    createActivityEvent(db, {
      session_id: "sess-4",
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

    const snippetIds = listHistorySnippets(db, { repo: "test/repo", limit: 10 }).map((snippet) => snippet.id);
    expect(snippetIds.length).toBeGreaterThan(1);

    db.update(historySnippetEmbeddings)
      .set({ index_dimensions: 4 })
      .where(eq(historySnippetEmbeddings.snippet_id, snippetIds[0]))
      .run();

    const config = loadEmbeddingConfigFromEnv()!;
    expect(() => rebuildHistoryVecIndex(db, config, { repo: "test/repo" })).toThrow(
      /mixed history embedding dimensions: 4, 3|mixed history embedding dimensions: 3, 4/,
    );
  });
});

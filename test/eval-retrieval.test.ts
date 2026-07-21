import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";
import { flushEmbeddingJobs } from "../src/embeddings/embeddings.js";
import {
  formatRetrievalEvalReport,
  formatValueRetrievalEvalReport,
  runRetrievalEval,
  runValueRetrievalEval,
  summarizeValueRetrievalEval,
} from "../src/eval/retrieval.js";
import { installMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";
import { recordMemoryValueEvent } from "../src/models/memory-value.js";
import { computeQualityReport, recordQualitySnapshot } from "../src/maintenance/quality.js";

let dbCounter = 0;

function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-eval-retrieval-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

function installEmbeddingMock() {
  installMockEmbeddingProvider((text) => (
    text.toLowerCase().includes("pytest") ? [1, 0, 0] : [0, 0, 1]
  ));
}

afterEach(async () => {
  await flushEmbeddingJobs();
  vi.restoreAllMocks();
  delete process.env.RECALL_EMBEDDINGS_DISABLED;
  delete process.env.RECALL_EMBEDDING_DIMS;
  delete process.env.RECALL_EMBEDDING_VERSION;
});

describe("retrieval eval runner", () => {
  it("shows hybrid improvement over baseline on fixture cases", async () => {
    const db = freshDb();
    delete process.env.RECALL_EMBEDDINGS_DISABLED;
    installEmbeddingMock();
    process.env.RECALL_EMBEDDING_DIMS = "3";
    process.env.RECALL_EMBEDDING_VERSION = "test-v1";

    createMemory(db, {
      type: "rule",
      text: "Use strict mode",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.95,
    });
    createMemory(db, {
      type: "command",
      text: "Run pytest -q",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.7,
    });

    await flushEmbeddingJobs();

    const report = await runRetrievalEval(db, {
      cases: [
        {
          name: "pytest command wins with query text",
          repo: "test/repo",
          query_text: "pytest -q",
          max_lines: 1,
          expected_all_texts: ["Run pytest -q"],
          forbidden_texts: ["Use strict mode"],
        },
      ],
    });

    expect(report.summary.total_cases).toBe(1);
    expect(report.summary.baseline_passed).toBe(0);
    expect(report.summary.hybrid_passed).toBe(1);
    expect(report.summary.improved_cases).toBe(1);

    const text = formatRetrievalEvalReport(report);
    expect(text).toContain("Improved:        1");
  });

  it("builds retrieval eval cases from value telemetry", async () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "command",
      text: "Run pytest -q",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });
    recordMemoryValueEvent(db, {
      memory_id: memoryId,
      session_id: "sess-value-eval",
      repo: "test/repo",
      event_type: "retrieval_miss",
      source: "cli",
      evidence: {
        query_text: "pytest -q",
        correction_text: "Always run pytest -q.",
        matched_memory_text: "Run pytest -q",
      },
    });

    const report = await runValueRetrievalEval(db, {
      sinceIso: "1970-01-01T00:00:00.000Z",
    });

    expect(report.generated_cases).toBe(1);
    expect(report.skipped_events).toBe(0);
    expect(report.source_events).toEqual({ retrieval_miss: 1, used: 0 });
    expect(report.retrieval.summary.hybrid_passed).toBe(1);
    expect(report.retrieval.cases[0].hybrid.included_texts).toContain("Run pytest -q");

    const text = formatValueRetrievalEvalReport(report);
    expect(text).toContain("# Value Retrieval Eval");
    expect(text).toContain("Generated cases: 1");
    expect(text).toContain("retrieval_miss=1 used=0");
  });

  it("builds value eval cases from used completion evidence", async () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Use pnpm for package commands.",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });
    recordMemoryValueEvent(db, {
      memory_id: memoryId,
      session_id: "sess-used-eval",
      repo: "test/repo",
      event_type: "used",
      source: "cli",
      saved_tokens_estimate: 7,
      evidence: {
        completion_excerpt: "Used pnpm for package commands.",
        matched_memory_text: "Use pnpm for package commands.",
      },
    });

    const report = await runValueRetrievalEval(db, {
      sinceIso: "1970-01-01T00:00:00.000Z",
      repo: "test/repo",
    });

    expect(report.generated_cases).toBe(1);
    expect(report.source_events).toEqual({ retrieval_miss: 0, used: 1 });
    expect(report.retrieval.summary.hybrid_expected_any_hit_rate).toBe(1);
  });

  it("recovers used memory through normalized lexical fallback when FTS is too strict", async () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "always run pytest -q before handoff",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });
    recordMemoryValueEvent(db, {
      memory_id: memoryId,
      session_id: "sess-used-paraphrase",
      repo: "test/repo",
      event_type: "used",
      source: "cli",
      saved_tokens_estimate: 8,
      evidence: {
        completion_excerpt: "Ran pytest -q before handing off.",
        matched_memory_text: "always run pytest -q before handoff",
      },
    });

    const report = await runValueRetrievalEval(db, {
      sinceIso: "1970-01-01T00:00:00.000Z",
      repo: "test/repo",
    });

    expect(report.generated_cases).toBe(1);
    expect(report.retrieval.summary.hybrid_passed).toBe(1);
    expect(report.retrieval.cases[0].hybrid.included_texts).toContain("always run pytest -q before handoff");
  });

  it("compares provider runs in one report", async () => {
    const db = freshDb();
    delete process.env.RECALL_EMBEDDINGS_DISABLED;
    installMockEmbeddingProvider((text, _purpose, config) => {
      const normalized = text.toLowerCase();
      if (config.provider === "multilingual-e5") {
        return normalized.includes("strict") || normalized.includes("python checks")
          ? [1, 0, 0]
          : [0, 0, 1];
      }
      if (config.provider === "bge-small-en-v1.5") {
        return normalized.includes("pytest") || normalized.includes("python checks")
          ? [1, 0, 0]
          : [0, 0, 1];
      }
      return normalized.includes("pytest") || normalized.includes("python checks")
        ? [1, 0, 0]
        : [0, 0, 1];
    });
    process.env.RECALL_EMBEDDING_DIMS = "3";
    process.env.RECALL_EMBEDDING_VERSION = "test-v1";

    createMemory(db, {
      type: "command",
      text: "Run pytest -q",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.7,
    });
    createMemory(db, {
      type: "rule",
      text: "Use strict mode",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.95,
    });

    await flushEmbeddingJobs();

    const report = await runRetrievalEval(db, {
      cases: [
        {
          name: "provider comparison changes semantic ranking",
          repo: "test/repo",
          query_text: "python checks",
          max_lines: 1,
          expected_any_texts: ["Run pytest -q"],
          forbidden_texts: [],
        },
      ],
    }, {
      providers: ["nomic", "multilingual-e5", "bge-small-en-v1.5"],
    });

    expect(report.provider_reports).toHaveLength(3);
    expect(report.provider_reports[0].provider).toBe("nomic");
    expect(report.provider_reports[0].metrics.recall_at_k).toBe(1);
    expect(report.provider_reports[0].metrics.mrr).toBe(1);
    expect(report.provider_reports[1].provider).toBe("multilingual-e5");
    expect(report.provider_reports[1].metrics.recall_at_k).toBe(0);
    expect(report.provider_reports[2].provider).toBe("bge-small-en-v1.5");
    expect(report.provider_reports[2].metrics.recall_at_k).toBe(1);

    const text = formatRetrievalEvalReport(report);
    expect(text).toContain("## Provider Comparison");
    expect(text).toContain("- nomic:");
    expect(text).toContain("- multilingual-e5:");
    expect(text).toContain("- bge-small-en-v1.5:");
  });

  it("persists value retrieval eval metrics into quality snapshots", async () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "command",
      text: "Run pytest -q",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });
    recordMemoryValueEvent(db, {
      memory_id: memoryId,
      session_id: "sess-value-snapshot",
      repo: "test/repo",
      event_type: "used",
      source: "cli",
      evidence: {
        completion_excerpt: "Ran pytest -q.",
        matched_memory_text: "Run pytest -q",
      },
    });

    const evalReport = await runValueRetrievalEval(db, {
      sinceIso: "1970-01-01T00:00:00.000Z",
    });
    const qualityReport = computeQualityReport(db, {
      sinceIso: "1970-01-01T00:00:00.000Z",
    });
    const snapshot = recordQualitySnapshot(
      db,
      qualityReport,
      "value-eval",
      summarizeValueRetrievalEval(evalReport),
    );

    expect(snapshot.value_eval_cases).toBe(1);
    expect(snapshot.value_eval_hybrid_passed).toBe(1);
    expect(snapshot.value_eval_recall_at_k).toBe(1);
    expect(snapshot.value_eval_mrr).toBe(1);
    expect(snapshot.value_eval_override_rate).toBe(0);
    expect(snapshot.value_eval_skipped_events).toBe(0);
  });
});

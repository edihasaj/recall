import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";
import { flushEmbeddingJobs } from "../src/embeddings/embeddings.js";
import { formatRetrievalEvalReport, runRetrievalEval } from "../src/eval/retrieval.js";
import { installMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";

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
      providers: ["nomic", "multilingual-e5"],
    });

    expect(report.provider_reports).toHaveLength(2);
    expect(report.provider_reports[0].provider).toBe("nomic");
    expect(report.provider_reports[0].metrics.recall_at_k).toBe(1);
    expect(report.provider_reports[0].metrics.mrr).toBe(1);
    expect(report.provider_reports[1].provider).toBe("multilingual-e5");
    expect(report.provider_reports[1].metrics.recall_at_k).toBe(0);

    const text = formatRetrievalEvalReport(report);
    expect(text).toContain("## Provider Comparison");
    expect(text).toContain("- nomic:");
    expect(text).toContain("- multilingual-e5:");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";
import { flushEmbeddingJobs } from "../src/embeddings/embeddings.js";
import { formatRetrievalEvalReport, runRetrievalEval } from "../src/eval/retrieval.js";

let dbCounter = 0;

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-eval-retrieval-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

function installEmbeddingMock() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input: string | string[] };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const data = inputs.map((text, index) => ({
      index,
      embedding: text.toLowerCase().includes("pytest")
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

describe("retrieval eval runner", () => {
  it("shows hybrid improvement over baseline on fixture cases", async () => {
    const db = freshDb();
    installEmbeddingMock();
    process.env.RECALL_EMBEDDINGS_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
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
});

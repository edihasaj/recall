import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initStandaloneDb } from "../src/db/client.js";
import { hybridSearch } from "../src/embeddings/embeddings.js";
import { rerankMinScore, rerankPairs, resetRerankerCache, setRerankScorerForTests } from "../src/embeddings/reranker.js";
import { writeFileSync } from "node:fs";
import { createMemory } from "../src/models/memory.js";

afterEach(() => {
  setRerankScorerForTests(null);
  resetRerankerCache();
  vi.unstubAllEnvs();
});

function freshDb() {
  return initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-rerank-")), "recall.db"));
}

it("hybridSearch reorders by the reranker's scores and keeps them", async () => {
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
  vi.stubEnv("RECALL_RERANK", "true");
  const db = freshDb();
  const repo = "fixture/rerank";
  const first = createMemory(db, { repo, type: "rule", scope: "repo", source: "user_correction", confidence: 0.9,
    text: "Deploy the web app with the deploy script." });
  const second = createMemory(db, { repo, type: "rule", scope: "repo", source: "user_correction", confidence: 0.9,
    text: "Deploy docs only after the web app deploy finishes." });
  setRerankScorerForTests(async (_query, documents) =>
    documents.map((document) => (document.startsWith("Deploy docs") ? 0.9 : 0.2)));

  const results = await hybridSearch(db, "deploy web app", null, { repo, limit: 5 });

  expect(results.map((result) => result.memory.id)).toEqual([second, first]);
  expect(results.map((result) => result.score)).toEqual([0.9, 0.2]);
});

it("the injection cutoff follows the model unless overridden", () => {
  expect(rerankMinScore()).toBe(0.0003); // default ms-marco model
  const dir = mkdtempSync(join(tmpdir(), "recall-rerank-model-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ recall_rerank_min_score: 0.02 }));
  vi.stubEnv("RECALL_RERANK_MODEL", dir);
  expect(rerankMinScore()).toBe(0.02);
  vi.stubEnv("RECALL_RERANK_MODEL", "someone/other-reranker");
  expect(rerankMinScore()).toBe(0.5);
  vi.stubEnv("RECALL_RERANK_MIN_SCORE", "0.1");
  expect(rerankMinScore()).toBe(0.1);
});

// Regression: the text-classification pipeline's softmax over a single-output
// model returned 1.0 for every pair, so re-ranking silently did nothing.
// Opt-in: downloads the default reranker (about 25 MB).
it.skipIf(process.env.RECALL_TEST_REAL_EMBEDDINGS !== "true")(
  "the default reranker gives pairs different scores and ranks the relevant one first",
  async () => {
    const [relevant, unrelated] = await rerankPairs("How do I install dependencies?", [
      "Use pnpm, not npm, to install dependencies in this repository.",
      "The office cat is called Miso.",
    ]);
    expect(relevant).toBeGreaterThan(unrelated);
    expect(relevant).toBeLessThan(1);
    expect(unrelated).toBeGreaterThan(0);
  },
  120_000,
);

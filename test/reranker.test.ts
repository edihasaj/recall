import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initStandaloneDb } from "../src/db/client.js";
import { compileContextHybrid } from "../src/compiler/context.js";
import { hybridSearch } from "../src/embeddings/embeddings.js";
import { rerankMinScore, rerankPairs, resetRerankerCache, setRerankScorerForTests } from "../src/embeddings/reranker.js";
import { writeFileSync } from "node:fs";
import { createMemory } from "../src/models/memory.js";
import { setLlmJudgeForTests } from "../src/embeddings/llm-judge.js";
import { AutoModelForSequenceClassification, AutoTokenizer, BertTokenizer, Tensor, type PreTrainedModel } from "@huggingface/transformers";

afterEach(() => {
  setRerankScorerForTests(null);
  setLlmJudgeForTests(null);
  resetRerankerCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  { ratio: undefined, secondScore: 0.8, keep: true },
  { ratio: 0.9, secondScore: 0.8, keep: false },
  { ratio: 0.9, secondScore: 0.81, keep: true },
  { ratio: 0.9, secondScore: 0.82, keep: true },
  { ratio: 2, secondScore: 0.8, keep: true },
  { ratio: "0.9", secondScore: 0.8, keep: true },
])("applies the optional companion gate: $ratio, score $secondScore", async ({ ratio, secondScore, keep }) => {
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
  vi.stubEnv("RECALL_RERANK", "true");
  const dir = mkdtempSync(join(tmpdir(), "recall-rerank-companion-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ recall_rerank_min_score: 0.05, recall_rerank_companion_ratio: ratio }));
  vi.stubEnv("RECALL_RERANK_MODEL", dir);
  const db = freshDb();
  try {
    const repo = "fixture/companion";
    const base = { repo, type: "rule" as const, scope: "repo" as const, source: "user_correction" as const, confidence: 0.9 };
    const primary = createMemory(db, { ...base, text: "Staging load tests require a traffic cap." });
    const companion = createMemory(db, { ...base, text: "Staging load tests require an alert channel." });
    setRerankScorerForTests(async (_query, docs) => docs.map((d) => d.includes("traffic cap") ? 0.9 : secondScore));
    const pack = await compileContextHybrid(db, { repo, query_text: "staging load tests", session_id: "companion" });
    expect(pack.memories_included).toContain(primary);
    expect(pack.memories_included.includes(companion)).toBe(keep);
  } finally {
    db.$client.close();
  }
});

it("compares companions with the first selected memory, not a candidate excluded by the command budget", async () => {
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
  vi.stubEnv("RECALL_RERANK", "true");
  const dir = mkdtempSync(join(tmpdir(), "recall-budget-companion-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ recall_rerank_min_score: 0.05, recall_rerank_companion_ratio: 0.9 }));
  vi.stubEnv("RECALL_RERANK_MODEL", dir);
  const db = freshDb();
  try {
    const repo = "fixture/budget-companion";
    const base = { repo, type: "rule" as const, scope: "repo" as const, source: "user_correction" as const, confidence: 0.9 };
    const excluded = createMemory(db, { ...base, type: "command", text: "Staging load tests require a traffic cap." });
    const kept = createMemory(db, { ...base, text: "Staging load tests require an alert channel." });
    setRerankScorerForTests(async (_query, docs) => docs.map((d) => d.includes("traffic cap") ? 0.9 : 0.5));
    const pack = await compileContextHybrid(db, { repo, query_text: "staging load tests", session_id: "budget-companion", config: { max_commands: 0 } });
    expect(pack.memories_included).not.toContain(excluded);
    expect(pack.memories_included).toContain(kept);
  } finally {
    db.$client.close();
  }
});

it.each([true, false])("uses the judge verdict when available, and the local companion gate otherwise: %s", async (answers) => {
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
  vi.stubEnv("RECALL_RERANK", "true");
  vi.stubEnv("RECALL_RELEVANCE_LLM", "true");
  const dir = mkdtempSync(join(tmpdir(), "recall-judged-companion-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ recall_rerank_min_score: 0.05, recall_rerank_companion_ratio: 0.9 }));
  vi.stubEnv("RECALL_RERANK_MODEL", dir);
  const db = freshDb();
  try {
    const repo = "fixture/judged-companion";
    const base = { repo, type: "rule" as const, scope: "repo" as const, source: "user_correction" as const, confidence: 0.9 };
    const primary = createMemory(db, { ...base, text: "Staging load tests require a traffic cap." });
    const companion = createMemory(db, { ...base, text: "Staging load tests require an alert channel." });
    setRerankScorerForTests(async (_query, docs) => docs.map((d) => d.includes("traffic cap") ? 0.9 : 0.8));
    setLlmJudgeForTests(async (_query, memories) => answers ? new Map(memories.map((m) => [m.id, 3])) : null);
    const pack = await compileContextHybrid(db, { repo, query_text: "staging load tests", session_id: "judged-companion" });
    expect(pack.memories_included).toContain(primary);
    expect(pack.memories_included.includes(companion)).toBe(answers);
  } finally {
    db.$client.close();
  }
});

it.each([undefined, 0, 65, 32])("loads a model's batch setting %s and scores every pair once", async (setting) => {
  const dir = mkdtempSync(join(tmpdir(), "recall-rerank-batch-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ recall_rerank_batch_size: setting }));
  vi.stubEnv("RECALL_RERANK_MODEL", dir);
  const tokenizer = new BertTokenizer({
    model: { type: "WordPiece", unk_token: "[UNK]", vocab: {
      "[PAD]": 0, "[UNK]": 1, "[CLS]": 2, "[SEP]": 3, query: 4, memory: 5,
    } },
    pre_tokenizer: { type: "Whitespace" }, normalizer: null,
    decoder: { type: "WordPiece", prefix: "##", cleanup: true },
    post_processor: { type: "BertProcessing", cls: ["[CLS]", 2], sep: ["[SEP]", 3] },
    added_tokens: [{ id: 0, content: "[PAD]", special: true }, { id: 1, content: "[UNK]", special: true },
      { id: 2, content: "[CLS]", special: true }, { id: 3, content: "[SEP]", special: true }],
  }, { tokenizer_class: "BertTokenizer", pad_token: "[PAD]", unk_token: "[UNK]",
    cls_token: "[CLS]", sep_token: "[SEP]", model_max_length: 512 });
  const sizes: number[] = [];
  let offset = 0;
  const model = async (inputs: Record<string, Tensor>) => {
    const count = inputs.input_ids.dims[0];
    sizes.push(count);
    const values = Float32Array.from({ length: count }, () => offset++);
    return { logits: new Tensor("float32", values, [count, 1]) };
  };
  vi.spyOn(AutoTokenizer, "from_pretrained").mockResolvedValue(tokenizer);
  vi.spyOn(AutoModelForSequenceClassification, "from_pretrained").mockResolvedValue(model as unknown as PreTrainedModel);
  const scores = await rerankPairs("query", Array(50).fill("memory"));
  expect(sizes).toEqual(setting === 32 ? [32, 18] : [16, 16, 16, 2]);
  expect(scores).toHaveLength(50);
  expect(scores[0]).toBe(0.5);
  expect(scores[17]).toBeCloseTo(1 / (1 + Math.exp(-17)), 10);
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

it("a model can raise its cutoff with store size", () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-rerank-curve-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ recall_rerank_min_score: { 1000: 0.9, 100: 0.7 } }));
  vi.stubEnv("RECALL_RERANK_MODEL", dir);
  expect(rerankMinScore(10)).toBe(0.7); // flat below the first point
  expect(rerankMinScore(100)).toBe(0.7);
  expect(rerankMinScore(Math.round(10 ** 2.5))).toBeCloseTo(0.8, 3); // linear in log(size)
  expect(rerankMinScore(1000)).toBeCloseTo(0.9, 10);
  expect(rerankMinScore(50_000)).toBe(0.9); // flat beyond the last point
  vi.stubEnv("RECALL_RERANK_MIN_SCORE", "0.5");
  expect(rerankMinScore(50_000)).toBe(0.5); // the env override is a fixed cutoff
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

it("while re-ranking, any shared word makes a memory a candidate", async () => {
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
  const db = freshDb();
  const repo = "fixture/or-candidates";
  const id = createMemory(db, { repo, type: "gotcha", scope: "repo", source: "user_correction", confidence: 0.9,
    text: "Staging has no read replicas.", note: "load tests, traffic, benchmarks" });
  const request = "Can I hammer preprod with heavy traffic tonight?";
  setRerankScorerForTests(async (_query, documents) => documents.map(() => 0.9));
  vi.stubEnv("RECALL_RERANK", "false");
  expect((await hybridSearch(db, request, null, { repo })).map((r) => r.memory.id)).not.toContain(id);
  vi.stubEnv("RECALL_RERANK", "true");
  expect((await hybridSearch(db, request, null, { repo })).map((r) => r.memory.id)).toContain(id);
});

it("a memory the re-ranker scores below its cutoff is not injected on a word match", async () => {
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
  vi.stubEnv("RECALL_RERANK", "true");
  const db = freshDb();
  const repo = "fixture/final-verdict";
  const id = createMemory(db, { repo, type: "rule", scope: "repo", source: "user_correction", confidence: 0.9,
    text: "Feature flag new_checkout must stay off in the EU." });
  setRerankScorerForTests(async (_query, documents) => documents.map(() => 0.00001));
  const pack = await compileContextHybrid(db, { repo, session_id: "verdict", query_text: "What does the frozen lockfile flag do?" });
  expect(pack.memories_included).not.toContain(id);
});

it("while re-ranking, a word match the re-ranker did not keep is not injected", async () => {
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
  vi.stubEnv("RECALL_RERANK", "true");
  const db = freshDb();
  const repo = "fixture/no-bypass";
  const base = { repo, type: "rule" as const, scope: "repo" as const, source: "user_correction" as const, confidence: 0.9 };
  const kept = createMemory(db, { ...base, text: "Never point load tests at staging." });
  const overlap = createMemory(db, { ...base, text: "Staging deploys need a release note." });
  // The re-ranker keeps only the load-test rule; the other shares the word "staging".
  setRerankScorerForTests(async (_query, documents) => documents.map((d) => (d.startsWith("Never") ? 0.9 : 0.00001)));
  const pack = await compileContextHybrid(db, { repo, session_id: "bypass", query_text: "load tests against staging tonight" });
  expect(pack.memories_included).toContain(kept);
  expect(pack.memories_included).not.toContain(overlap);
});

it("a bigger store raises a size-aware cutoff in the pack", async () => {
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
  vi.stubEnv("RECALL_RERANK", "true");
  const dir = mkdtempSync(join(tmpdir(), "recall-rerank-curve-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ recall_rerank_min_score: { 1: 0.5, 100: 0.95 } }));
  vi.stubEnv("RECALL_RERANK_MODEL", dir);
  setRerankScorerForTests(async (_query, documents) => documents.map((d) => (d.startsWith("Never") ? 0.8 : 0.00001)));
  const db = freshDb();
  const repo = "fixture/size-aware";
  const base = { repo, type: "rule" as const, scope: "repo" as const, source: "user_correction" as const, confidence: 0.9 };
  const rule = createMemory(db, { ...base, text: "Never point load tests at staging." });
  const query = { repo, session_id: "size", query_text: "load tests against staging tonight" };
  expect((await compileContextHybrid(db, query)).memories_included).toContain(rule);
  for (let i = 0; i < 99; i++) createMemory(db, { ...base, text: `Service ${i} owns queue q${i} and alerts channel c${i}.` });
  expect((await compileContextHybrid(db, query)).memories_included).not.toContain(rule);
});

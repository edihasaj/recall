import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { compileContextHybrid } from "../src/compiler/context.js";
import { initStandaloneDb } from "../src/db/client.js";
import { bootstrapEmbeddings, hybridSearch, loadEmbeddingConfigFromEnv } from "../src/embeddings/embeddings.js";
import { resetRerankerCache, setRerankScorerForTests } from "../src/embeddings/reranker.js";
import { captureCorrectionFallback } from "../src/mcp/fallback.js";
import { createMemory, getMemory, setMemoryNote } from "../src/models/memory.js";
import { retrievalText } from "../src/models/retrieval-text.js";
import { searchMemoryFtsIndex } from "../src/vector/sqlite-fts.js";

afterEach(() => {
  setRerankScorerForTests(null);
  resetRerankerCache();
  vi.unstubAllEnvs();
});

function freshDb() {
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
  return initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-notes-")), "recall.db"));
}

const repo = "fixture/notes";
const replicas = {
  repo, type: "gotcha" as const, scope: "repo" as const, source: "user_correction" as const, confidence: 0.9,
  text: "Staging has no read replicas.",
};
const replicasNote = "load tests, heavy read queries, reporting jobs, connection pool sizing";

it("retrieval text joins the note the way the relevance models were trained", () => {
  expect(retrievalText({ text: "Staging has no read replicas.", note: "  load tests,\n reporting jobs " }))
    .toBe("Staging has no read replicas. Affects: load tests, reporting jobs");
  expect(retrievalText({ text: "Use pnpm.", note: "   " })).toBe("Use pnpm.");
});

it("a note makes a memory findable by words only the note contains", () => {
  const db = freshDb();
  const id = createMemory(db, { ...replicas, note: replicasNote });
  expect(getMemory(db, id)?.note).toBe(replicasNote);
  expect(searchMemoryFtsIndex(db, "reporting jobs", { repo }).map((m) => m.memory_id)).toEqual([id]);
});

it("setting a note later re-indexes the memory", () => {
  const db = freshDb();
  const id = createMemory(db, replicas);
  expect(searchMemoryFtsIndex(db, "reporting jobs", { repo })).toEqual([]);
  expect(setMemoryNote(db, id, replicasNote)).toBe(true);
  expect(searchMemoryFtsIndex(db, "reporting jobs", { repo }).map((m) => m.memory_id)).toEqual([id]);
  expect(setMemoryNote(db, "00000000-0000-4000-8000-000000000000", "x")).toBe(false);
});

// Regression: search built memories with its own row mapper, which dropped
// the note, so re-ranking scored memories without it.
it("search results carry the note", async () => {
  const db = freshDb();
  createMemory(db, { ...replicas, note: replicasNote });
  const [result] = await hybridSearch(db, "reporting jobs", null, { repo, limit: 5 });
  expect(result?.memory.note).toBe(replicasNote);
});

it("a repeat capture adds the note the first one lacked, and never replaces one", () => {
  const db = freshDb();
  const id = createMemory(db, replicas);
  expect(createMemory(db, { ...replicas, note: replicasNote })).toBe(id);
  expect(getMemory(db, id)?.note).toBe(replicasNote);
  createMemory(db, { ...replicas, note: "something else" });
  expect(getMemory(db, id)?.note).toBe(replicasNote);
});

it("capture_correction stores the agent's affects note on the captured memory", async () => {
  const db = freshDb();
  const result = await captureCorrectionFallback(db, {
    text: "don't use npm, use pnpm",
    repo,
    session_id: "notes-test",
    affects: "installing packages, lockfile changes, CI install steps",
  }, "mcp");
  expect(result.ids.length).toBeGreaterThan(0);
  for (const id of result.ids) {
    expect(getMemory(db, id)?.note).toBe("installing packages, lockfile changes, CI install steps");
  }
});

// Opt-in: runs the real all-MiniLM-L6-v2 embedding model (about 23 MB).
it.skipIf(process.env.RECALL_TEST_REAL_EMBEDDINGS !== "true")(
  "a memory the re-ranker vouches for is injected despite low vector similarity",
  async () => {
    const db = freshDb();
    vi.stubEnv("RECALL_EMBEDDING_PROVIDER", "all-MiniLM-L6-v2");
    vi.stubEnv("RECALL_EMBEDDING_MODEL", "Xenova/all-MiniLM-L6-v2");
    vi.stubEnv("RECALL_EMBEDDING_DIMS", "384");
    const id = createMemory(db, { ...replicas, note: replicasNote });
    vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "false");
    await bootstrapEmbeddings(db, loadEmbeddingConfigFromEnv()!);
    const request = { repo, session_id: "gate-test", query_text: "Can I hammer preprod with five hundred concurrent users tonight?" };

    vi.stubEnv("RECALL_RERANK", "false");
    expect((await compileContextHybrid(db, request)).memories_included).not.toContain(id);

    vi.stubEnv("RECALL_RERANK", "true");
    setRerankScorerForTests(async (_query, documents) => documents.map(() => 0.9));
    expect((await compileContextHybrid(db, request)).memories_included).toContain(id);

    setRerankScorerForTests(async (_query, documents) => documents.map(() => 0.1));
    expect((await compileContextHybrid(db, request)).memories_included).not.toContain(id);
  },
  120_000,
);

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import {
  flushEmbeddingJobs,
  hybridSearch,
  storeEmbedding,
  syncMemoryEmbedding,
  verifyEmbeddings,
} from "../src/embeddings/embeddings.js";
import { resetRerankerCache, setRerankScorerForTests } from "../src/embeddings/reranker.js";
import {
  confirmMemory,
  createMemory,
  getMemory,
  reactivateMemory,
  rejectMemory,
  setMemoryNote,
} from "../src/models/memory.js";
import { normalizeNote, retrievalText } from "../src/models/retrieval-text.js";
import type { EmbeddingConfig } from "../src/types.js";
import { searchMemoryFtsIndex } from "../src/vector/sqlite-fts.js";
import { installMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";

const databases: RecallDb[] = [];
const text = "Staging has no read replicas.";
const userNote = "load tests, reporting jobs";
const diagnostic = "cloud-dreaming: semantic_duplicate of macbook:abc123 (run deadbeef, 2026-10-13)";
const repo = "fixture/cloud-notes";
const config: EmbeddingConfig = {
  provider: "nomic",
  model: "nomic-ai/nomic-embed-text-v1.5",
  dimensions: 3,
  version: "test-v1",
  similarity_threshold: 0.8,
};

beforeEach(() => {
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
});

afterEach(async () => {
  await flushEmbeddingJobs();
  setRerankScorerForTests(null);
  resetRerankerCache();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const db of databases.splice(0)) db.$client.close();
});

function freshDb() {
  const db = initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-cloud-notes-")), "recall.db"));
  databases.push(db);
  return db;
}

function memoryWithNote(db: RecallDb, note: string) {
  return createMemory(db, {
    text,
    note,
    repo,
    type: "gotcha",
    scope: "repo",
    source: "user_correction",
    confidence: 0.9,
  });
}

it.each([
  [diagnostic, text],
  [`${userNote} | ${diagnostic}`, `${text} Affects: ${userNote}`],
  [`${diagnostic} | ${userNote} | cloud-dreaming: candidate_noise`, `${text} Affects: ${userNote}`],
  [`load tests | ${diagnostic} | reporting jobs`, `${text} Affects: load tests | reporting jobs`],
])("excludes reserved diagnostic segments from retrieval: %s", (note, expected) => {
  expect(retrievalText({ text, note })).toBe(expected);
  expect(normalizeNote(note)).toBe(note);
});

it("preserves literal mentions and pipe-separated user applicability text", () => {
  const note = "debug cloud-dreaming: status | note parsing | names|cloud-dreaming: literal";
  expect(retrievalText({ text, note })).toBe(`${text} Affects: ${note}`);
});

it("keeps reactivated memory diagnostics visible in storage but absent from keyword search", () => {
  const db = freshDb();
  const note = `${userNote} | ${diagnostic}`;
  const id = memoryWithNote(db, note);
  rejectMemory(db, id);
  expect(reactivateMemory(db, id, {
    type: "session_correction",
    session: "restore-fixture",
    timestamp: new Date().toISOString(),
    context: "user restored the rule",
  })).toBe(true);
  expect(confirmMemory(db, id)).toBe(true);
  expect(getMemory(db, id)).toMatchObject({ note, status: "active" });
  expect(searchMemoryFtsIndex(db, "reporting jobs", { repo }).map((row) => row.memory_id)).toEqual([id]);
  expect(searchMemoryFtsIndex(db, "deadbeef", { repo })).toEqual([]);
});

it("passes only applicability text to the re-ranker", async () => {
  const db = freshDb();
  const id = memoryWithNote(db, `${userNote} | ${diagnostic}`);
  const scorer = vi.fn(async (_query: string, documents: string[]) => documents.map(() => 0.9));
  vi.stubEnv("RECALL_RERANK", "true");
  setRerankScorerForTests(scorer);
  const result = await hybridSearch(db, "reporting jobs", null, { repo });
  expect(result[0]?.memory.id).toBe(id);
  expect(scorer).toHaveBeenCalledWith("reporting jobs", [`${text} Affects: ${userNote}`]);
});

it("excludes diagnostics from rejected correction embeddings used as rejection exemplars", async () => {
  const db = freshDb();
  const id = memoryWithNote(db, diagnostic);
  rejectMemory(db, id);
  const embedded: string[] = [];
  installMockEmbeddingProvider((document) => {
    embedded.push(document);
    return [1, 0, 0];
  });
  expect(await syncMemoryEmbedding(db, id, config)).toBe("stored");
  expect(getMemory(db, id)?.status).toBe("rejected");
  expect(embedded).toEqual([text]);
});

it("refreshes an old embedding containing diagnostic text and keeps later diagnostic changes hash-stable", async () => {
  const db = freshDb();
  const id = memoryWithNote(db, `${userNote} | ${diagnostic}`);
  const embedded: string[] = [];
  installMockEmbeddingProvider((document) => {
    embedded.push(document);
    return [1, 0, 0];
  });
  storeEmbedding(db, id, `${text} Affects: ${userNote} | ${diagnostic}`, Float32Array.from([0, 1, 0]), config);
  expect(verifyEmbeddings(db, config).stale).toBe(1);
  expect(await syncMemoryEmbedding(db, id, config)).toBe("updated");
  expect(embedded).toEqual([`${text} Affects: ${userNote}`]);
  expect(verifyEmbeddings(db, config).stale).toBe(0);

  setMemoryNote(db, id, `${userNote} | cloud-dreaming: candidate_noise (run 12345678)`);
  expect(await syncMemoryEmbedding(db, id, config)).toBe("skipped");
  expect(embedded).toEqual([`${text} Affects: ${userNote}`]);
});

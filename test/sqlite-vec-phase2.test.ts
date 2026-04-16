import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { initStandaloneDb } from "../src/db/client.js";
import { memoryEmbeddings } from "../src/db/schema.js";
import {
  flushEmbeddingJobs,
  loadEmbeddingConfigFromEnv,
  rebuildEmbeddingIndex,
  semanticSearch,
  verifyEmbeddings,
} from "../src/embeddings/embeddings.js";
import { createMemory, rejectMemory } from "../src/models/memory.js";
import { installMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";

let dbCounter = 0;

function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-sqlite-vec-phase2-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

function installEmbeddingMock() {
  installMockEmbeddingProvider((text) => vectorForText(text));
}

function vectorForText(text: string) {
  const normalized = text.toLowerCase();
  if (normalized.includes("pnpm")) return [1, 0, 0];
  if (normalized.includes("pytest")) return [0, 1, 0];
  return [0, 0, 1];
}

afterEach(async () => {
  await flushEmbeddingJobs();
  vi.restoreAllMocks();
  delete process.env.RECALL_EMBEDDINGS_DISABLED;
  delete process.env.RECALL_EMBEDDING_DIMS;
  delete process.env.RECALL_EMBEDDING_VERSION;
});

describe("sqlite-vec phase 2 index sync", () => {
  it("searches the derived sqlite-vec index within a repo slice", async () => {
    const db = freshDb();
    delete process.env.RECALL_EMBEDDINGS_DISABLED;
    installEmbeddingMock();
    process.env.RECALL_EMBEDDING_DIMS = "3";
    process.env.RECALL_EMBEDDING_VERSION = "test-v1";

    createMemory(db, {
      type: "rule",
      text: "Use pnpm as package manager",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });
    createMemory(db, {
      type: "command",
      text: "Run pytest -q",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });
    createMemory(db, {
      type: "rule",
      text: "Use pnpm in another repo",
      scope: "repo",
      repo: "other/repo",
      source: "user_correction",
      confidence: 0.8,
    });

    await flushEmbeddingJobs();

    const config = loadEmbeddingConfigFromEnv()!;
    const results = await semanticSearch(db, "pnpm", config, {
      repo: "test/repo",
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0].memory.repo).toBe("test/repo");
    expect(results[0].memory.text).toContain("pnpm");

    const verify = verifyEmbeddings(db, config, { repo: "test/repo" });
    expect(verify.eligible).toBe(2);
    expect(verify.stored).toBe(2);
    expect(verify.indexed).toBe(2);
    expect(verify.index_drift).toBe(0);

    const rebuilt = rebuildEmbeddingIndex(db, config, { repo: "test/repo" });
    expect(rebuilt.vector_rows).toBe(2);
    expect(rebuilt.lexical_rows).toBe(2);
  });

  it("removes vec index rows when memories become ineligible", async () => {
    const db = freshDb();
    delete process.env.RECALL_EMBEDDINGS_DISABLED;
    installEmbeddingMock();
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
    expect((await semanticSearch(db, "pnpm", config, { repo: "test/repo" }))).toHaveLength(1);

    rejectMemory(db, memoryId);
    await flushEmbeddingJobs();

    expect((await semanticSearch(db, "pnpm", config, { repo: "test/repo" }))).toHaveLength(0);
    const verify = verifyEmbeddings(db, config, { repo: "test/repo" });
    expect(verify.eligible).toBe(0);
    expect(verify.stored).toBe(0);
    expect(verify.indexed).toBe(0);
  });

  it("refuses to rebuild a mixed-dimension memory vec index", async () => {
    const db = freshDb();
    delete process.env.RECALL_EMBEDDINGS_DISABLED;
    installEmbeddingMock();
    process.env.RECALL_EMBEDDING_DIMS = "3";
    process.env.RECALL_EMBEDDING_VERSION = "test-v1";

    const memoryA = createMemory(db, {
      type: "rule",
      text: "Use pnpm",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });
    const memoryB = createMemory(db, {
      type: "command",
      text: "Run pytest -q",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });

    await flushEmbeddingJobs();

    db.update(memoryEmbeddings)
      .set({ dimensions: 4 })
      .where(eq(memoryEmbeddings.memory_id, memoryB))
      .run();

    const config = loadEmbeddingConfigFromEnv()!;
    expect(() => rebuildEmbeddingIndex(db, config, { repo: "test/repo" })).toThrow(
      /mixed memory embedding dimensions: 3, 4/,
    );

    void memoryA;
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { installMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";
import { resolveProvider } from "../src/embeddings/providers/index.js";
import {
  bootstrapEmbeddings,
  flushEmbeddingJobs,
  generateEmbedding,
  generateEmbeddings,
  loadEmbeddingConfigFromEnv,
  loadEmbedding,
} from "../src/embeddings/embeddings.js";
import { createMemory, rejectMemory } from "../src/models/memory.js";
import type { EmbeddingConfig } from "../src/types.js";

let dbCounter = 0;

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-embeddings-phase1-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

const config: EmbeddingConfig = {
  enabled: true,
  provider: "nomic",
  model: "nomic-ai/nomic-embed-text-v1.5",
  dimensions: 3,
  version: "test-v1",
  similarity_threshold: 0.8,
};

function installEmbeddingMock() {
  installMockEmbeddingProvider((text) => [text.length, 1, 1]);
}

afterEach(async () => {
  await flushEmbeddingJobs();
  vi.restoreAllMocks();
  delete process.env[["OPENAI", "API", "KEY"].join("_")];
  delete process.env.RECALL_EMBEDDINGS_DISABLED;
  delete process.env.RECALL_EMBEDDING_PROVIDER;
  delete process.env.RECALL_EMBEDDING_DIMS;
  delete process.env.RECALL_EMBEDDING_VERSION;
});

describe("phase 1 embedding lifecycle", () => {
  it("keeps nomic as the default provider and ignores legacy openai env", async () => {
    const legacyApiKeyEnv = ["OPENAI", "API", "KEY"].join("_");
    process.env[legacyApiKeyEnv] = "legacy-key";

    expect(loadEmbeddingConfigFromEnv()).toEqual({
      enabled: true,
      provider: "nomic",
      model: "nomic-ai/nomic-embed-text-v1.5",
      dimensions: 512,
      version: "v1",
      similarity_threshold: 0.8,
    });
  });

  it("resolves the nomic provider and delegates single and batch embedding calls", async () => {
    installEmbeddingMock();

    const provider = resolveProvider(config);

    expect(provider.metadata()).toEqual({
      model: "nomic-ai/nomic-embed-text-v1.5",
      dimensions: 3,
      version: "test-v1",
    });
    expect(Array.from(await generateEmbedding("abc", config))).toEqual([3, 1, 1]);
    expect((await generateEmbeddings(["a", "abcd"], config)).map((embedding) => Array.from(embedding))).toEqual([
      [1, 1, 1],
      [4, 1, 1],
    ]);
  });

  it("disables embeddings only through the kill switch", () => {
    process.env.RECALL_EMBEDDINGS_DISABLED = "true";

    expect(loadEmbeddingConfigFromEnv()).toBeNull();
  });

  it("bootstraps embeddings only for candidate and active memories", async () => {
    const db = freshDb();
    installEmbeddingMock();
    process.env.RECALL_EMBEDDINGS_DISABLED = "true";

    const activeId = createMemory(db, {
      type: "rule",
      text: "active memory",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });
    const candidateId = createMemory(db, {
      type: "decision",
      text: "candidate memory",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.45,
    });
    const transientId = createMemory(db, {
      type: "gotcha",
      text: "transient memory",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.2,
    });
    const rejectedId = createMemory(db, {
      type: "rule",
      text: "rejected memory",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.7,
    });
    rejectMemory(db, rejectedId);

    delete process.env.RECALL_EMBEDDINGS_DISABLED;
    const count = await bootstrapEmbeddings(db, config, { repo: "test/repo" });

    expect(count).toBe(2);
    expect(loadEmbedding(db, activeId)).not.toBeNull();
    expect(loadEmbedding(db, candidateId)).not.toBeNull();
    expect(loadEmbedding(db, transientId)).toBeNull();
    expect(loadEmbedding(db, rejectedId)).toBeNull();
  });

  it("removes stored embeddings when a memory is rejected", async () => {
    const db = freshDb();
    installEmbeddingMock();
    process.env.RECALL_EMBEDDING_DIMS = "3";
    process.env.RECALL_EMBEDDING_VERSION = "test-v1";

    const memoryId = createMemory(db, {
      type: "rule",
      text: "memory to reject",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });

    await flushEmbeddingJobs();
    expect(loadEmbedding(db, memoryId)).not.toBeNull();

    rejectMemory(db, memoryId);
    await flushEmbeddingJobs();

    expect(loadEmbedding(db, memoryId)).toBeNull();
  });
});

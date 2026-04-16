import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { resolveProvider } from "../src/embeddings/providers/index.js";
import {
  bootstrapEmbeddings,
  flushEmbeddingJobs,
  generateEmbedding,
  generateEmbeddings,
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
  provider: "openai",
  model: "text-embedding-3-small",
  api_key: "test-key",
  dimensions: 3,
  version: "test-v1",
  similarity_threshold: 0.8,
};

function mockEmbeddingFetch() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      input: string | string[];
    };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const data = inputs.map((text, index) => ({
      index,
      embedding: [text.length, index + 1, 1],
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

describe("phase 1 embedding lifecycle", () => {
  it("resolves the OpenAI provider and delegates single and batch embedding calls", async () => {
    mockEmbeddingFetch();

    const provider = resolveProvider(config);

    expect(provider.metadata()).toEqual({
      model: "text-embedding-3-small",
      dimensions: 3,
      version: "test-v1",
    });
    expect(Array.from(await generateEmbedding("abc", config))).toEqual([3, 1, 1]);
    expect((await generateEmbeddings(["a", "abcd"], config)).map((embedding) => Array.from(embedding))).toEqual([
      [1, 1, 1],
      [4, 2, 1],
    ]);
  });

  it("throws for providers without a registered implementation yet", () => {
    expect(() =>
      resolveProvider({
        ...config,
        provider: "local",
      }),
    ).toThrow(/Unsupported embedding provider: local/);
  });

  it("bootstraps embeddings only for candidate and active memories", async () => {
    const db = freshDb();
    mockEmbeddingFetch();

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

    const count = await bootstrapEmbeddings(db, config, { repo: "test/repo" });

    expect(count).toBe(2);
    expect(loadEmbedding(db, activeId)).not.toBeNull();
    expect(loadEmbedding(db, candidateId)).not.toBeNull();
    expect(loadEmbedding(db, transientId)).toBeNull();
    expect(loadEmbedding(db, rejectedId)).toBeNull();
  });

  it("removes stored embeddings when a memory is rejected", async () => {
    const db = freshDb();
    mockEmbeddingFetch();
    process.env.RECALL_EMBEDDINGS_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
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

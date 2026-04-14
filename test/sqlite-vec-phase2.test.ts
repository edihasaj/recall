import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import {
  flushEmbeddingJobs,
  loadEmbeddingConfigFromEnv,
  rebuildEmbeddingIndex,
  semanticSearch,
  verifyEmbeddings,
} from "../src/embeddings/embeddings.js";
import { createMemory, rejectMemory } from "../src/models/memory.js";

let dbCounter = 0;

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-sqlite-vec-phase2-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

function installEmbeddingMock() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      input: string | string[];
    };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];

    const data = inputs.map((text, index) => ({
      index,
      embedding: vectorForText(text),
    }));

    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }));
}

function vectorForText(text: string) {
  const normalized = text.toLowerCase();
  if (normalized.includes("pnpm")) return [1, 0, 0];
  if (normalized.includes("pytest")) return [0, 1, 0];
  return [0, 0, 1];
}

afterEach(async () => {
  await flushEmbeddingJobs();
  vi.unstubAllGlobals();
  delete process.env.RECALL_EMBEDDINGS_ENABLED;
  delete process.env.OPENAI_API_KEY;
  delete process.env.RECALL_EMBEDDING_DIMS;
  delete process.env.RECALL_EMBEDDING_VERSION;
});

describe("sqlite-vec phase 2 index sync", () => {
  it("searches the derived sqlite-vec index within a repo slice", async () => {
    const db = freshDb();
    installEmbeddingMock();
    process.env.RECALL_EMBEDDINGS_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
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
    expect(rebuilt).toBe(2);
  });

  it("removes vec index rows when memories become ineligible", async () => {
    const db = freshDb();
    installEmbeddingMock();
    process.env.RECALL_EMBEDDINGS_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
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
});

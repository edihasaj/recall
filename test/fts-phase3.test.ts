import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import {
  flushEmbeddingJobs,
  hybridSearch,
  loadEmbeddingConfigFromEnv,
} from "../src/embeddings/embeddings.js";
import { createMemory } from "../src/models/memory.js";

let dbCounter = 0;

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-fts-phase3-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

function vectorForText(text: string) {
  const normalized = text.toLowerCase();
  if (normalized.includes("pytest -q")) return [1, 1, 0];
  if (normalized.includes("pytest")) return [0.95, 0.9, 0];
  if (normalized.includes("pnpm")) return [1, 0, 0];
  return [0, 0, 1];
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

afterEach(async () => {
  await flushEmbeddingJobs();
  vi.unstubAllGlobals();
  delete process.env.RECALL_EMBEDDINGS_ENABLED;
  delete process.env.OPENAI_API_KEY;
  delete process.env.RECALL_EMBEDDING_DIMS;
  delete process.env.RECALL_EMBEDDING_VERSION;
});

describe("phase 3 lexical index", () => {
  it("supports lexical-only search when embeddings are disabled", async () => {
    const db = freshDb();

    createMemory(db, {
      type: "command",
      text: "Run pytest -q",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });

    await flushEmbeddingJobs();

    const results = await hybridSearch(db, "pytest", null, {
      repo: "test/repo",
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0].memory.text).toBe("Run pytest -q");
    expect(results[0].lexical_score).toBeGreaterThan(0);
    expect(results[0].similarity).toBe(0);
  });

  it("lets lexical rank break ties between semantically similar matches", async () => {
    const db = freshDb();
    installEmbeddingMock();
    process.env.RECALL_EMBEDDINGS_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.RECALL_EMBEDDING_DIMS = "3";
    process.env.RECALL_EMBEDDING_VERSION = "test-v1";

    createMemory(db, {
      type: "command",
      text: "Run pytest -q",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });
    createMemory(db, {
      type: "decision",
      text: "Use pytest for local test runs",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });

    await flushEmbeddingJobs();

    const config = loadEmbeddingConfigFromEnv();
    const results = await hybridSearch(db, "pytest -q", config, {
      repo: "test/repo",
      limit: 5,
    });

    expect(results).toHaveLength(2);
    expect(results[0].memory.text).toBe("Run pytest -q");
    expect(results[0].lexical_score).toBeGreaterThan(results[1].lexical_score);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });
});

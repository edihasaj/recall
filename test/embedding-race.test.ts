import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { initStandaloneDb } from "../src/db/client.js";
import * as providerRegistry from "../src/embeddings/providers/index.js";
import {
  flushEmbeddingJobs,
  syncMemoryEmbedding,
  loadEmbedding,
} from "../src/embeddings/embeddings.js";
import { createMemory } from "../src/models/memory.js";
import { memories } from "../src/db/schema.js";
import type { EmbeddingConfig } from "../src/types.js";

let dbCounter = 0;
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-embedding-race-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

const config: EmbeddingConfig = {
  provider: "nomic",
  model: "nomic-ai/nomic-embed-text-v1.5",
  dimensions: 3,
  version: "test-v1",
  similarity_threshold: 0.8,
};

afterEach(async () => {
  await flushEmbeddingJobs();
  vi.restoreAllMocks();
});

describe("syncMemoryEmbedding race", () => {
  it("does not throw FK error when the memory is deleted between fetch and store", async () => {
    const db = freshDb();

    const id = createMemory(db, {
      type: "rule",
      text: "doomed candidate",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.4,
    });

    // Mock provider whose embed() deletes the parent row mid-flight, simulating
    // the race we saw in production (e.g. test cleanup, candidate hard-delete).
    vi.spyOn(providerRegistry, "resolveProvider").mockImplementation((cfg) => ({
      async embed(text: string) {
        db.delete(memories).where(eq(memories.id, id)).run();
        return Float32Array.from([text.length, 1, 1]);
      },
      async embedBatch(texts: string[]) {
        return texts.map((t) => Float32Array.from([t.length, 1, 1]));
      },
      metadata() {
        return {
          model: cfg.model,
          dimensions: cfg.dimensions,
          canonical_dimensions: cfg.dimensions,
          index_dimensions: cfg.dimensions,
          version: cfg.version,
        };
      },
    }));

    const outcome = await syncMemoryEmbedding(db, id, config);
    expect(outcome).toBe("removed");
    expect(loadEmbedding(db, id)).toBeNull();
  });
});

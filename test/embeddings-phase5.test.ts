import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as providerRegistry from "../src/embeddings/providers/index.js";
import { getEmbeddingCachePath } from "../src/embeddings/cache.js";
import { ensureEmbeddingProviderReady, getEmbeddingModelInfo } from "../src/embeddings/embeddings.js";
import type { EmbeddingConfig } from "../src/types.js";

const config: EmbeddingConfig = {
  provider: "nomic",
  model: "nomic-ai/nomic-embed-text-v1.5",
  dimensions: 512,
  version: "phase5-test",
  similarity_threshold: 0.8,
};

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.HOME;
});

describe("phase 5 embedding model cache", () => {
  it("reports cache path and on-disk size", () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "recall-embed-home-"));

    vi.spyOn(providerRegistry, "resolveProvider").mockReturnValue({
      async embed() {
        return new Float32Array([1]);
      },
      async embedBatch() {
        return [new Float32Array([1])];
      },
      metadata() {
        return {
          model: config.model,
          dimensions: config.dimensions,
          version: config.version,
          estimated_size_mb: 140,
        };
      },
    });

    const cachePath = getEmbeddingCachePath(config);
    mkdirSync(cachePath, { recursive: true });
    writeFileSync(join(cachePath, "weights.bin"), "1234");

    expect(getEmbeddingModelInfo(config)).toMatchObject({
      provider: "nomic",
      model: "nomic-ai/nomic-embed-text-v1.5",
      cache_path: cachePath,
      cached: true,
      size_bytes: 4,
      size_label: "4 B",
      estimated_size_mb: 140,
    });
  });

  it("runs provider prepare during setup warmup", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "recall-embed-home-"));
    const prepare = vi.fn(async () => undefined);

    vi.spyOn(providerRegistry, "resolveProvider").mockReturnValue({
      async embed() {
        return new Float32Array([1]);
      },
      async embedBatch() {
        return [new Float32Array([1])];
      },
      prepare,
      metadata() {
        return {
          model: config.model,
          dimensions: config.dimensions,
          version: config.version,
          estimated_size_mb: 140,
        };
      },
    });

    const info = await ensureEmbeddingProviderReady(config);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(info).toMatchObject({
      provider: "nomic",
      model: "nomic-ai/nomic-embed-text-v1.5",
      cache_path: getEmbeddingCachePath(config),
    });
  });
});

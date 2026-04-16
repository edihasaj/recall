import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingConfig } from "../src/types.js";

const { pipelineMock } = vi.hoisted(() => ({
  pipelineMock: vi.fn(),
}));

vi.mock("@huggingface/transformers", () => ({
  pipeline: pipelineMock,
}));

class MockTensor {
  constructor(
    public dims: number[],
    public data: Float32Array,
  ) {}

  slice(rowSlice: number | number[] | null, columnSlice: number | number[] | null): MockTensor {
    const [rows, columns] = this.dims;
    const rowIndexes = resolveIndexes(rows, rowSlice);
    const columnIndexes = resolveIndexes(columns, columnSlice);
    const next = new Float32Array(rowIndexes.length * columnIndexes.length);

    rowIndexes.forEach((rowIndex, rowOffset) => {
      columnIndexes.forEach((columnIndex, columnOffset) => {
        next[rowOffset * columnIndexes.length + columnOffset] =
          this.data[rowIndex * columns + columnIndex];
      });
    });

    return new MockTensor([rowIndexes.length, columnIndexes.length], next);
  }

  normalize(_p = 2, _dim = -1): MockTensor {
    const [rows, columns] = this.dims;
    const next = new Float32Array(this.data.length);

    for (let row = 0; row < rows; row++) {
      let norm = 0;
      for (let column = 0; column < columns; column++) {
        const value = this.data[row * columns + column];
        norm += value * value;
      }
      const scale = Math.sqrt(norm) || 1;
      for (let column = 0; column < columns; column++) {
        next[row * columns + column] = this.data[row * columns + column] / scale;
      }
    }

    return new MockTensor([rows, columns], next);
  }
}

function resolveIndexes(size: number, slice: number | number[] | null): number[] {
  if (slice === null) return Array.from({ length: size }, (_, index) => index);
  if (typeof slice === "number") return [slice];

  const [start, end] = slice;
  return Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
}

function expectEmbeddingClose(actual: Float32Array, expected: number[]) {
  expect(actual.length).toBe(expected.length);
  Array.from(actual).forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index], 6);
  });
}

const multilingualConfig: EmbeddingConfig = {
  enabled: true,
  provider: "multilingual-e5",
  model: "Xenova/multilingual-e5-small",
  dimensions: 3,
  version: "test-v3",
  similarity_threshold: 0.8,
};

let extractorMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();

  extractorMock = vi.fn(async (texts: string[]) => {
    const rows = texts.length;
    const columns = 4;
    const data = new Float32Array(rows * columns);

    texts.forEach((text, row) => {
      const base = text.startsWith("query: ") ? 10 + row : 1 + row;
      for (let column = 0; column < columns; column++) {
        data[row * columns + column] = base + column;
      }
    });

    return new MockTensor([rows, columns], data).normalize();
  });

  pipelineMock.mockReset();
  pipelineMock.mockResolvedValue(extractorMock);
});

afterEach(() => {
  delete process.env.RECALL_EMBEDDINGS_DISABLED;
  delete process.env.RECALL_EMBEDDING_PROVIDER;
  delete process.env.RECALL_EMBEDDING_MODEL;
  delete process.env.RECALL_EMBEDDING_DIMS;
  delete process.env.RECALL_EMBEDDING_VERSION;
  delete process.env.RECALL_SIMILARITY_THRESHOLD;
});

describe("phase 3 multilingual-e5 provider", () => {
  it("resolves the multilingual provider with passage prefixes and normalized embeddings", async () => {
    const { resolveProvider } = await import("../src/embeddings/providers/index.js");

    const provider = resolveProvider(multilingualConfig);
    const embedding = await provider.embed("bonjour");

    expect(provider.metadata()).toMatchObject({
      model: "Xenova/multilingual-e5-small",
      dimensions: 3,
      version: "test-v3",
      task_prefix: "passage: | query:",
      estimated_size_mb: 113,
    });
    expect(pipelineMock).toHaveBeenCalledWith(
      "feature-extraction",
      "Xenova/multilingual-e5-small",
      expect.objectContaining({ dtype: "q8", cache_dir: expect.any(String) }),
    );
    expect(extractorMock).toHaveBeenCalledWith(
      ["passage: bonjour"],
      { pooling: "mean", normalize: true },
    );
    expectEmbeddingClose(embedding, [
      1 / Math.sqrt(14),
      2 / Math.sqrt(14),
      3 / Math.sqrt(14),
    ]);
  });

  it("uses query prefixes for query embeddings and preserves batch ordering", async () => {
    const { createMultilingualE5Provider } = await import("../src/embeddings/providers/multilingual-e5.js");

    const provider = createMultilingualE5Provider(multilingualConfig);
    const embeddings = await provider.embedBatch(["ciao", "hola"], "query");

    expect(extractorMock).toHaveBeenCalledWith(
      ["query: ciao", "query: hola"],
      { pooling: "mean", normalize: true },
    );
    expect(embeddings).toHaveLength(2);
    expectEmbeddingClose(embeddings[0], [
      10 / Math.sqrt(365),
      11 / Math.sqrt(365),
      12 / Math.sqrt(365),
    ]);
    expectEmbeddingClose(embeddings[1], [
      11 / Math.sqrt(434),
      12 / Math.sqrt(434),
      13 / Math.sqrt(434),
    ]);
  });

  it("caches the extractor pipeline across provider instances", async () => {
    const { createMultilingualE5Provider } = await import("../src/embeddings/providers/multilingual-e5.js");

    const first = createMultilingualE5Provider(multilingualConfig);
    const second = createMultilingualE5Provider(multilingualConfig);

    await first.embed("hallo");
    await second.embed("zdravo", "query");

    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it("loads multilingual-e5 from env only when explicitly selected", async () => {
    const { loadEmbeddingConfigFromEnv } = await import("../src/embeddings/embeddings.js");

    process.env.RECALL_EMBEDDING_PROVIDER = "multilingual-e5";

    expect(loadEmbeddingConfigFromEnv()).toEqual({
      enabled: true,
      provider: "multilingual-e5",
      model: "Xenova/multilingual-e5-small",
      dimensions: 384,
      version: "v1",
      similarity_threshold: 0.8,
    });
  });

  it("uses nomic as the default provider after the cutover", async () => {
    const { loadEmbeddingConfigFromEnv } = await import("../src/embeddings/embeddings.js");

    expect(loadEmbeddingConfigFromEnv()).toEqual({
      enabled: true,
      provider: "nomic",
      model: "nomic-ai/nomic-embed-text-v1.5",
      dimensions: 512,
      version: "v1",
      similarity_threshold: 0.8,
    });
  });
});

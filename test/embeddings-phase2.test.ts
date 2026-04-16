import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingConfig } from "../src/types.js";

const { layerNormMock, pipelineMock } = vi.hoisted(() => ({
  pipelineMock: vi.fn(),
  layerNormMock: vi.fn(),
}));

vi.mock("@huggingface/transformers", () => ({
  layer_norm: layerNormMock,
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

function rowValues(tensor: MockTensor): number[][] {
  const [rows, columns] = tensor.dims;
  return Array.from({ length: rows }, (_, row) =>
    Array.from(tensor.data.slice(row * columns, (row + 1) * columns)),
  );
}

function expectEmbeddingClose(actual: Float32Array, expected: number[]) {
  expect(actual.length).toBe(expected.length);
  Array.from(actual).forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index], 6);
  });
}

const nomicConfig: EmbeddingConfig = {
  enabled: true,
  provider: "nomic",
  model: "nomic-ai/nomic-embed-text-v1.5",
  dimensions: 3,
  version: "test-v2",
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
      const base = text.startsWith("search_query: ") ? 10 + row : 1 + row;
      for (let column = 0; column < columns; column++) {
        data[row * columns + column] = base + column;
      }
    });

    return new MockTensor([rows, columns], data);
  });

  pipelineMock.mockReset();
  pipelineMock.mockResolvedValue(extractorMock);

  layerNormMock.mockReset();
  layerNormMock.mockImplementation((tensor: MockTensor) => tensor);
});

describe("phase 2 nomic provider", () => {
  it("resolves the nomic provider with document prefixes and truncated normalized vectors", async () => {
    const { resolveProvider } = await import("../src/embeddings/providers/index.js");

    const provider = resolveProvider(nomicConfig);
    const embedding = await provider.embed("alpha");

    expect(provider.metadata()).toEqual({
      model: "nomic-ai/nomic-embed-text-v1.5",
      dimensions: 3,
      version: "test-v2",
      task_prefix: "search_document: | search_query:",
    });
    expect(pipelineMock).toHaveBeenCalledWith(
      "feature-extraction",
      "nomic-ai/nomic-embed-text-v1.5",
      { dtype: "q8" },
    );
    expect(extractorMock).toHaveBeenCalledWith(
      ["search_document: alpha"],
      { pooling: "mean" },
    );
    expect(layerNormMock).toHaveBeenCalledTimes(1);
    expectEmbeddingClose(embedding, [
      1 / Math.sqrt(14),
      2 / Math.sqrt(14),
      3 / Math.sqrt(14),
    ]);
  });

  it("uses query prefixes for query embeddings and preserves batch ordering", async () => {
    const { createNomicProvider } = await import("../src/embeddings/providers/nomic.js");

    const provider = createNomicProvider(nomicConfig);
    const embeddings = await provider.embedBatch(["first", "second"], "query");

    expect(extractorMock).toHaveBeenCalledWith(
      ["search_query: first", "search_query: second"],
      { pooling: "mean" },
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
    const { createNomicProvider } = await import("../src/embeddings/providers/nomic.js");

    const first = createNomicProvider(nomicConfig);
    const second = createNomicProvider(nomicConfig);

    await first.embed("alpha");
    await second.embed("beta", "query");

    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it("rejects dimensions above the native nomic output width", async () => {
    const { createNomicProvider } = await import("../src/embeddings/providers/nomic.js");

    const provider = createNomicProvider({
      ...nomicConfig,
      dimensions: 1024,
    });

    await expect(provider.embed("too-wide")).rejects.toThrow(/at most 768 dimensions/);
  });

  it("keeps the mocked tensor shape sane", () => {
    const tensor = new MockTensor([2, 4], Float32Array.from([
      1, 2, 3, 4,
      5, 6, 7, 8,
    ]));

    expect(rowValues(tensor.slice(null, [0, 3]).normalize())).toHaveLength(2);
  });
});

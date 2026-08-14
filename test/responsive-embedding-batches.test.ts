import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_EMBEDDING_BATCH_SIZE,
  processInResponsiveBatches,
} from "../src/embeddings/responsive-batches.js";

describe("responsive embedding batches", () => {
  it("limits default native inference to one row per event-loop turn", () => {
    expect(BACKGROUND_EMBEDDING_BATCH_SIZE).toBe(1);
  });

  it("bounds native inference work and yields between batches", async () => {
    const batches: number[][] = [];
    const yieldControl = vi.fn(async () => undefined);

    await processInResponsiveBatches(
      [1, 2, 3, 4, 5],
      async (batch) => { batches.push(batch); },
      { batchSize: 2, yieldControl },
    );

    expect(batches).toEqual([[1, 2], [3, 4], [5]]);
    expect(yieldControl).toHaveBeenCalledTimes(2);
  });
});

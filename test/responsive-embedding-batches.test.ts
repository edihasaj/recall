import { describe, expect, it, vi } from "vitest";
import { processInResponsiveBatches } from "../src/embeddings/responsive-batches.js";

describe("responsive embedding batches", () => {
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

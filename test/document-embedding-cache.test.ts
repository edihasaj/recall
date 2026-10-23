import { describe, expect, it } from "vitest";
import { DocumentEmbeddingCache } from "../benchmark/document-embedding-cache.js";

describe("document embedding cache", () => {
  it("reuses identical text and keeps different text separate", async () => {
    const calls: string[] = [];
    const cache = new DocumentEmbeddingCache({ provider: "fixture", model: "v1" }, async (text) => {
      calls.push(text);
      return new Float32Array([text.length]);
    });

    await expect(cache.embed("same")).resolves.toEqual(new Float32Array([4]));
    await expect(cache.embed("other")).resolves.toEqual(new Float32Array([5]));
    await expect(cache.embed("same")).resolves.toEqual(new Float32Array([4]));
    expect(calls).toEqual(["same", "other"]);
    expect(cache.stats()).toEqual({ hits: 1, misses: 2, entries: 2 });
  });

  it("keeps provider/model-bound cache instances isolated", async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const first = new DocumentEmbeddingCache({ provider: "one", model: "v1" }, async () => {
      firstCalls++;
      return new Float32Array([1]);
    });
    const second = new DocumentEmbeddingCache({ provider: "two", model: "v2" }, async () => {
      secondCalls++;
      return new Float32Array([2]);
    });

    await first.embed("shared text");
    await second.embed("shared text");
    await first.embed("shared text");
    expect([firstCalls, secondCalls]).toEqual([1, 1]);
    expect(first.stats().entries).toBe(1);
    expect(second.stats().entries).toBe(1);
  });

  it("distinguishes exact UTF-16 inputs that UTF-8 would replace", async () => {
    let calls = 0;
    const cache = new DocumentEmbeddingCache({ provider: "fixture", model: "v1" }, async () => {
      calls++;
      return new Float32Array([calls]);
    });
    await cache.embed("\ud800");
    await cache.embed("\ufffd");
    expect(calls).toBe(2);
    expect(cache.stats()).toEqual({ hits: 0, misses: 2, entries: 2 });
  });

  it("clones generated and returned values so mutation cannot corrupt the cache", async () => {
    const generated = new Float32Array([1, 2]);
    const cache = new DocumentEmbeddingCache({ provider: "fixture", model: "v1" }, async () => generated);
    const first = await cache.embed("stable");
    generated[0] = 9;
    first[1] = 8;
    expect(await cache.embed("stable")).toEqual(new Float32Array([1, 2]));
  });

  it("does not retain rejected generation calls", async () => {
    let attempts = 0;
    const cache = new DocumentEmbeddingCache({ provider: "fixture", model: "v1" }, async () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary failure");
      return new Float32Array([3]);
    });

    await expect(cache.embed("retry")).rejects.toThrow("temporary failure");
    await expect(cache.embed("retry")).resolves.toEqual(new Float32Array([3]));
    expect(attempts).toBe(2);
    expect(cache.stats()).toEqual({ hits: 0, misses: 2, entries: 1 });
  });
});

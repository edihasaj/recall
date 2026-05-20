import { afterEach, describe, expect, it } from "vitest";
import { isHydeCandidate } from "../src/embeddings/hyde.js";

afterEach(() => {
  delete process.env.RECALL_HYDE;
});

describe("HyDE candidate detection", () => {
  it("accepts a typical chat question", () => {
    expect(isHydeCandidate("What degree did I graduate with?")).toBe(true);
  });

  it("requires a trailing question mark", () => {
    expect(isHydeCandidate("What degree did I graduate with")).toBe(false);
  });

  it("rejects short queries", () => {
    expect(isHydeCandidate("why?")).toBe(false);
    expect(isHydeCandidate("how come?")).toBe(false);
  });

  it("rejects code-like queries with slashes or extensions", () => {
    expect(isHydeCandidate("Why does src/auth.ts fail?")).toBe(false);
    expect(isHydeCandidate("Where is Foo::bar defined?")).toBe(false);
  });

  it("accepts longer natural questions", () => {
    expect(
      isHydeCandidate("When did I start the new exercise routine?"),
    ).toBe(true);
  });
});

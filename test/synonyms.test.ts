import { afterEach, describe, expect, it } from "vitest";
import { getSynonyms, resetSynonymCache } from "../src/vector/synonyms.js";

afterEach(() => {
  resetSynonymCache();
  delete process.env.RECALL_SYNONYMS;
});

describe("synonym expansion", () => {
  it("returns expansions for a known token", () => {
    const result = getSynonyms("degree");
    expect(result).toContain("diploma");
    expect(result).toContain("qualification");
    // Should not include the token itself
    expect(result).not.toContain("degree");
  });

  it("is case-insensitive on lookup", () => {
    const lower = getSynonyms("graduate");
    const upper = getSynonyms("GRADUATE");
    expect(upper).toEqual(lower);
  });

  it("returns empty array for unknown tokens", () => {
    expect(getSynonyms("ghi9unknown_token_xyz")).toEqual([]);
  });

  it("returns empty when RECALL_SYNONYMS=false", () => {
    process.env.RECALL_SYNONYMS = "false";
    resetSynonymCache();
    expect(getSynonyms("degree")).toEqual([]);
  });

  it("excludes the looked-up token from its own expansion across group members", () => {
    const fromDegree = getSynonyms("degree");
    const fromDiploma = getSynonyms("diploma");
    expect(fromDegree).not.toContain("degree");
    expect(fromDiploma).not.toContain("diploma");
    // But each should reference the other.
    expect(fromDegree).toContain("diploma");
    expect(fromDiploma).toContain("degree");
  });
});

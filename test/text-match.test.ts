import { describe, expect, it } from "vitest";
import { matchTokens, textMatchScore, textMatches } from "../src/text/match.js";

describe("text match normalization", () => {
  it("matches negation/replacement paraphrases", () => {
    expect(textMatches(
      "stop using npm; pnpm only",
      "Do not use npm. Use pnpm instead.",
      0.62,
    )).toBe(true);
  });

  it("matches completion paraphrases over package commands", () => {
    expect(textMatches(
      "I ran the package command with pnpm and kept the lockfile in sync.",
      "Use pnpm for package commands.",
      0.62,
    )).toBe(true);
  });

  it("keeps one-token overlap below the normal threshold", () => {
    const score = textMatchScore(
      "I used npm for this one command.",
      "Do not use npm. Use pnpm instead.",
    );
    expect(score.score).toBeLessThan(0.62);
  });

  it("normalizes ES version phrasing for module rules", () => {
    expect(matchTokens("Use ES2022 modules")).toContain("es");
    expect(textMatches("Use modern ES modules", "Use ES2022 modules", 0.62)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import {
  createMemory,
  feedbackWeightedScore,
  recordFeedback,
  FEEDBACK_MATURITY,
} from "../src/models/memory.js";
import { compileContext } from "../src/compiler/context.js";

let dbCounter = 0;
function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-feedback-rank-"));
  return initStandaloneDb(join(dir, `t-${dbCounter++}.db`));
}

describe("feedbackWeightedScore", () => {
  it("returns the raw confidence when no resolved feedback exists", () => {
    expect(
      feedbackWeightedScore(0.6, { followed: 0, overridden: 0, contradicted: 0, ignored: 0, resolved: 0 }),
    ).toBe(0.6);
  });

  it("ignores ignored-only outcomes (resolved=0)", () => {
    expect(
      feedbackWeightedScore(0.6, { followed: 0, overridden: 0, contradicted: 0, ignored: 99, resolved: 0 }),
    ).toBe(0.6);
  });

  it("rewards memories that were followed once enough samples accumulate", () => {
    const followed = feedbackWeightedScore(0.5, {
      followed: FEEDBACK_MATURITY,
      overridden: 0,
      contradicted: 0,
      ignored: 0,
      resolved: FEEDBACK_MATURITY,
    });
    expect(followed).toBeGreaterThan(0.5);
  });

  it("punishes contradictions harder than overrides", () => {
    const overridden = feedbackWeightedScore(0.8, {
      followed: 0, overridden: FEEDBACK_MATURITY, contradicted: 0, ignored: 0,
      resolved: FEEDBACK_MATURITY,
    });
    const contradicted = feedbackWeightedScore(0.8, {
      followed: 0, overridden: 0, contradicted: FEEDBACK_MATURITY, ignored: 0,
      resolved: FEEDBACK_MATURITY,
    });
    expect(contradicted).toBeLessThanOrEqual(overridden);
    expect(contradicted).toBeLessThan(0.8);
  });
});

describe("compileContext ranking", () => {
  it("prefers a followed memory over an unfollowed sibling at equal confidence", () => {
    const db = freshDb();
    const winner = createMemory(db, {
      type: "rule", text: "Use pnpm not npm.", scope: "repo", repo: "r",
      source: "user_correction", confidence: 0.95,
    });
    const loser = createMemory(db, {
      type: "rule", text: "Avoid global state.", scope: "repo", repo: "r",
      source: "user_correction", confidence: 0.95,
    });

    // Winner is followed every time; loser is followed at the same rate but
    // also overridden once. Both stay above the confidence threshold but the
    // empirical followed-rate ranks the winner higher.
    for (let i = 0; i < FEEDBACK_MATURITY; i += 1) {
      recordFeedback(db, winner, `w${i}`, true, "followed");
      recordFeedback(db, loser, `l${i}`, true, "followed");
    }
    recordFeedback(db, loser, "lo1", true, "overridden");

    const result = compileContext(db, { repo: "r", session_id: "test", config: { max_lines: 100 } });
    const winnerIdx = result.memories_included.indexOf(winner);
    const loserIdx = result.memories_included.indexOf(loser);
    expect(winnerIdx).toBeGreaterThanOrEqual(0);
    expect(loserIdx).toBeGreaterThanOrEqual(0);
    expect(winnerIdx).toBeLessThan(loserIdx);
  });
});

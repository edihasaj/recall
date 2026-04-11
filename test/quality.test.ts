import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import {
  createMemory,
  confirmMemory,
  queryMemories,
} from "../src/models/memory.js";
import { getRepoQualityProfile, seedCandidateConfidence } from "../src/repo/quality.js";
import { processCorrection, processReviewFeedback } from "../src/capture/correction.js";
import { CONFIDENCE } from "../src/types.js";

let dbCounter = 0;
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-quality-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

function makeActive(db: ReturnType<typeof freshDb>, text: string, repo = "test/repo") {
  const id = createMemory(db, {
    text,
    type: "rule",
    source: "user_correction",
    scope: "repo",
    repo,
    confidence: 0.7,
    evidence: [],
  });
  confirmMemory(db, id);
  return id;
}

// --- Stage classification ---

describe("stage classification", () => {
  it("cold when < 10 active memories", () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) makeActive(db, `rule ${i}`);
    const profile = getRepoQualityProfile(db, "test/repo");
    expect(profile.stage).toBe("cold");
  });

  it("growing when 10-49 active memories", () => {
    const db = freshDb();
    for (let i = 0; i < 15; i++) makeActive(db, `rule ${i}`);
    const profile = getRepoQualityProfile(db, "test/repo");
    expect(profile.stage).toBe("growing");
  });

  it("mature when >= 50 active memories", () => {
    const db = freshDb();
    for (let i = 0; i < 50; i++) makeActive(db, `rule ${i}`);
    const profile = getRepoQualityProfile(db, "test/repo");
    expect(profile.stage).toBe("mature");
  });

  it("boundary: 9 = cold, 10 = growing", () => {
    const db = freshDb();
    for (let i = 0; i < 9; i++) makeActive(db, `rule ${i}`);
    expect(getRepoQualityProfile(db, "test/repo").stage).toBe("cold");

    makeActive(db, "rule 9");
    expect(getRepoQualityProfile(db, "test/repo").stage).toBe("growing");
  });
});

// --- Score calculation ---

describe("score calculation", () => {
  it("cold repo with no data scores low", () => {
    const db = freshDb();
    const profile = getRepoQualityProfile(db, "test/repo");
    expect(profile.score).toBeLessThanOrEqual(0.5);
    expect(profile.avg_health).toBe(0);
  });

  it("default profile (no repo) scores conservatively", () => {
    const db = freshDb();
    const profile = getRepoQualityProfile(db);
    expect(profile.stage).toBe("cold");
    expect(profile.score).toBeLessThan(0.5);
  });

  it("score increases with healthy active memories", () => {
    const db = freshDb();
    const emptyProfile = getRepoQualityProfile(db, "test/repo");
    for (let i = 0; i < 5; i++) makeActive(db, `good rule ${i}`);
    const withMemories = getRepoQualityProfile(db, "test/repo");
    expect(withMemories.score).toBeGreaterThan(emptyProfile.score);
  });

  it("score is between 0 and 1", () => {
    const db = freshDb();
    for (let i = 0; i < 20; i++) makeActive(db, `rule ${i}`);
    const profile = getRepoQualityProfile(db, "test/repo");
    expect(profile.score).toBeGreaterThanOrEqual(0);
    expect(profile.score).toBeLessThanOrEqual(1);
  });
});

// --- seedCandidateConfidence ---

describe("seedCandidateConfidence", () => {
  it("cold stage applies no maturity penalty", () => {
    const profile = {
      stage: "cold" as const,
      score: 0.6, // above 0.45 threshold so no quality penalty either
      total_count: 0,
      active_count: 0,
      avg_health: 0,
      override_rate: 0,
      contradiction_rate: 0,
      repeat_sessions_required: 2,
      compile_confidence_threshold: 0.6,
      dedup_similarity_threshold: 0.85,
    };
    const result = seedCandidateConfidence(0.5, profile);
    expect(result).toBeCloseTo(0.5);
  });

  it("growing stage applies 0.03 penalty", () => {
    const profile = {
      stage: "growing" as const,
      score: 0.6,
      total_count: 20,
      active_count: 15,
      avg_health: 0.6,
      override_rate: 0,
      contradiction_rate: 0,
      repeat_sessions_required: 3,
      compile_confidence_threshold: 0.68,
      dedup_similarity_threshold: 0.8,
    };
    const result = seedCandidateConfidence(0.5, profile);
    expect(result).toBeCloseTo(0.47);
  });

  it("mature stage applies 0.05 penalty", () => {
    const profile = {
      stage: "mature" as const,
      score: 0.7,
      total_count: 60,
      active_count: 55,
      avg_health: 0.7,
      override_rate: 0,
      contradiction_rate: 0,
      repeat_sessions_required: 4,
      compile_confidence_threshold: 0.72,
      dedup_similarity_threshold: 0.75,
    };
    const result = seedCandidateConfidence(0.5, profile);
    expect(result).toBeCloseTo(0.45);
  });

  it("low quality score adds extra 0.03 penalty", () => {
    const profile = {
      stage: "growing" as const,
      score: 0.3,
      total_count: 20,
      active_count: 15,
      avg_health: 0.3,
      override_rate: 0.5,
      contradiction_rate: 0.3,
      repeat_sessions_required: 4,
      compile_confidence_threshold: 0.73,
      dedup_similarity_threshold: 0.75,
    };
    const result = seedCandidateConfidence(0.5, profile);
    // 0.5 - 0.03 (growing) - 0.03 (low quality) = 0.44
    expect(result).toBeCloseTo(0.44);
  });

  it("clamps to valid candidate range", () => {
    const coldProfile = {
      stage: "cold" as const,
      score: 0.35,
      total_count: 0,
      active_count: 0,
      avg_health: 0,
      override_rate: 0,
      contradiction_rate: 0,
      repeat_sessions_required: 2,
      compile_confidence_threshold: 0.6,
      dedup_similarity_threshold: 0.85,
    };
    // Very high input gets capped below active threshold
    const high = seedCandidateConfidence(0.9, coldProfile);
    expect(high).toBe(CONFIDENCE.ACTIVE_MIN - 0.01);

    // Very low input gets floored above transient
    const low = seedCandidateConfidence(0.1, coldProfile);
    expect(low).toBe(CONFIDENCE.TRANSIENT_MAX + 0.05);
  });
});

// --- Dynamic thresholds ---

describe("dynamic thresholds", () => {
  it("cold stage uses base thresholds", () => {
    const db = freshDb();
    const profile = getRepoQualityProfile(db, "test/repo");
    expect(profile.repeat_sessions_required).toBe(2);
    expect(profile.compile_confidence_threshold).toBe(CONFIDENCE.ACTIVE_MIN);
  });

  it("growing stage tightens thresholds", () => {
    const db = freshDb();
    for (let i = 0; i < 15; i++) makeActive(db, `rule ${i}`);
    const profile = getRepoQualityProfile(db, "test/repo");
    expect(profile.repeat_sessions_required).toBeGreaterThanOrEqual(2);
    expect(profile.compile_confidence_threshold).toBeGreaterThanOrEqual(CONFIDENCE.ACTIVE_MIN);
  });

  it("mature stage has strictest thresholds", () => {
    const db = freshDb();
    for (let i = 0; i < 50; i++) makeActive(db, `rule ${i}`);
    const profile = getRepoQualityProfile(db, "test/repo");
    expect(profile.repeat_sessions_required).toBeGreaterThanOrEqual(3);
    expect(profile.compile_confidence_threshold).toBeGreaterThan(CONFIDENCE.ACTIVE_MIN);
    expect(profile.dedup_similarity_threshold).toBeLessThan(0.85);
  });
});

// --- Integration: review feedback respects maturity gate ---

describe("review feedback maturity gate", () => {
  it("does not auto-promote on first review in growing repo", () => {
    const db = freshDb();
    // Build a growing repo
    for (let i = 0; i < 15; i++) makeActive(db, `rule ${i}`);

    // Create a candidate via correction
    const ids1 = processCorrection(db, "always use strict mode", {
      sessionId: "s1",
      repo: "test/repo",
    });
    expect(ids1.length).toBeGreaterThan(0);

    // Same correction as review — in growing, needs >= 2 sessions for review promotion
    const ids2 = processReviewFeedback(db, "review said always use strict mode", {
      sessionId: "s2",
      repo: "test/repo",
      reviewer: "alice",
    });

    // The memory should still be candidate (not enough sessions yet)
    const allMems = queryMemories(db, { repo: "test/repo" });
    const strictMems = allMems.filter(
      (m) => m.text.toLowerCase().includes("strict") && m.status !== "rejected",
    );
    // At least one should still be candidate
    const hasCandidates = strictMems.some((m) => m.status === "candidate");
    expect(hasCandidates).toBe(true);
  });
});

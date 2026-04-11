import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { initStandaloneDb } from "../src/db/client.js";
import { memories } from "../src/db/schema.js";
import { createMemory, getMemory, queryMemories, recordFeedback } from "../src/models/memory.js";
import { compileContext } from "../src/compiler/context.js";
import { processCorrection, processReviewFeedback } from "../src/capture/correction.js";
import { getRepoQualityProfile } from "../src/repo/quality.js";

let dbCounter = 0;
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-quality-test-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

describe("repo quality gating", () => {
  it("promotes after a second distinct correction in cold repos", () => {
    const db = freshDb();

    processCorrection(db, "don't use npm, use pnpm", {
      sessionId: "s1",
      repo: "cold/repo",
    });
    const ids = processCorrection(db, "don't use npm, use pnpm", {
      sessionId: "s2",
      repo: "cold/repo",
    });

    const mem = getMemory(db, ids[0])!;
    expect(mem.status).toBe("active");
    expect(mem.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("requires more distinct sessions in mature healthy repos", () => {
    const db = freshDb();

    for (let i = 0; i < 50; i++) {
      createMemory(db, {
        type: "rule",
        text: `existing rule ${i}`,
        scope: "repo",
        repo: "mature/repo",
        source: "repo_scan",
        confidence: 0.8,
      });
    }

    const profile = getRepoQualityProfile(db, "mature/repo");
    expect(profile.stage).toBe("mature");
    expect(profile.repeat_sessions_required).toBe(3);

    processCorrection(db, "always use strict mode", {
      sessionId: "s1",
      repo: "mature/repo",
    });
    processCorrection(db, "always use strict mode", {
      sessionId: "s2",
      repo: "mature/repo",
    });

    let mem = queryMemories(db, { repo: "mature/repo", type: "rule" })
      .find((item) => item.text === "always use strict mode");
    expect(mem).toBeDefined();
    expect(mem!.status).toBe("candidate");

    processCorrection(db, "always use strict mode", {
      sessionId: "s3",
      repo: "mature/repo",
    });

    mem = queryMemories(db, { repo: "mature/repo", type: "rule" })
      .find((item) => item.text === "always use strict mode");
    expect(mem!.status).toBe("active");
  });

  it("raises compile thresholds for noisy repos", () => {
    const db = freshDb();

    for (let i = 0; i < 12; i++) {
      const id = createMemory(db, {
        type: "rule",
        text: `noisy rule ${i}`,
        scope: "repo",
        repo: "noisy/repo",
        source: "repo_scan",
        confidence: 0.8,
      });
      for (let j = 0; j < 3; j++) {
        recordFeedback(db, id, `s-${i}-${j}`, true, "overridden");
      }
      db.update(memories)
        .set({ confidence: 0.8, status: "active" })
        .where(eq(memories.id, id))
        .run();
    }

    const strongId = createMemory(db, {
      type: "rule",
      text: "strong rule",
      scope: "repo",
      repo: "noisy/repo",
      source: "user_correction",
      confidence: 0.82,
    });
    const borderlineId = createMemory(db, {
      type: "rule",
      text: "borderline rule",
      scope: "repo",
      repo: "noisy/repo",
      source: "user_correction",
      confidence: 0.65,
    });

    const profile = getRepoQualityProfile(db, "noisy/repo");
    expect(profile.compile_confidence_threshold).toBeGreaterThan(0.65);

    const result = compileContext(db, { repo: "noisy/repo" });
    expect(result.memories_included).toContain(strongId);
    expect(result.memories_included).not.toContain(borderlineId);
  });

  it("keeps new review feedback as candidate until reinforced", () => {
    const db = freshDb();

    const ids = processReviewFeedback(db, "review said use error boundaries", {
      sessionId: "review-1",
      repo: "review/repo",
    });

    const mem = getMemory(db, ids[0])!;
    expect(mem.status).toBe("candidate");
    expect(mem.confidence).toBeLessThan(0.6);
  });
});

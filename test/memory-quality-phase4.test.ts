import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory, getMemory, recordFeedback } from "../src/models/memory.js";
import { processCorrection } from "../src/capture/correction.js";
import { promoteRepetitionCandidates } from "../src/maintenance/lifecycle.js";

let dbCounter = 0;

function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-memory-quality-p4-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

describe("memory quality phase 4 promotion-on-repetition", () => {
  it("increments repetition_count on repeated cross-session correction and promotes on threshold", async () => {
    const db = freshDb();

    const ids1 = await processCorrection(db, "always use strict mode", {
      sessionId: "s1",
      repo: "test/repo",
    });
    const first = getMemory(db, ids1[0])!;
    expect(first.repetition_count).toBe(0);

    const ids2 = await processCorrection(db, "always use strict mode", {
      sessionId: "s2",
      repo: "test/repo",
    });

    expect(ids2).toEqual(ids1);
    const repeated = getMemory(db, ids1[0])!;
    expect(repeated.repetition_count).toBe(1);
    expect(repeated.status).toBe("active");
  });

  it("maintenance promotes candidates whose repetition_count crosses the repo threshold", async () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Use uv",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.45,
    });

    db.$client
      .prepare("update memories set repetition_count = 2 where id = ?")
      .run(memoryId);

    const promoted = promoteRepetitionCandidates(db);
    expect(promoted).toBe(1);
    expect(getMemory(db, memoryId)!.status).toBe("active");
  });

  it("promotes a new candidate when sibling memories in the same group have enough followed outcomes", () => {
    const db = freshDb();
    const siblingId = createMemory(db, {
      type: "rule",
      text: "Use pnpm",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });
    recordFeedback(db, siblingId, "s1", true, "followed");
    recordFeedback(db, siblingId, "s2", true, "followed");
    recordFeedback(db, siblingId, "s3", true, "followed");

    const candidateIds = processCorrection(db, "always use bun as the runtime", {
      sessionId: "s4",
      repo: "test/repo",
    });

    return candidateIds.then((ids) => {
      const candidate = getMemory(db, ids[0])!;
      expect(candidate.status).toBe("active");
    });
  });
});

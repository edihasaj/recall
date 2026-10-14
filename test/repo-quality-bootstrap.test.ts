import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { initStandaloneDb } from "../src/db/client.js";
import { getRepoQualityProfile } from "../src/repo/quality.js";
import { CONFIDENCE } from "../src/types.js";

const DAY = 86_400_000;
let dbCounter = 0;
const openDbs: ReturnType<typeof initStandaloneDb>[] = [];

beforeEach(() => {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
});

afterEach(() => {
  for (const db of openDbs.splice(0)) db.$client.close();
});

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-quality-bootstrap-"));
  const db = initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
  openDbs.push(db);
  return db;
}
type Db = ReturnType<typeof freshDb>;

interface Rows {
  count: number;
  status: "candidate" | "active";
  confidence: number;
  ageDays: number;
  injections?: number;
  overrides?: number;
}

function insertRows(db: Db, repo: string, rows: Rows) {
  const at = new Date(Date.now() - rows.ageDays * DAY).toISOString();
  const insert = db.$client.prepare(`
    INSERT INTO memories (
      id, type, text, scope, repo, status, confidence, source, evidence,
      created_at, updated_at, injection_count, override_count, repetition_count, auto_inject
    ) VALUES (?, 'rule', ?, 'repo', ?, ?, ?, 'user_correction', '[]', ?, ?, ?, ?, 0, 1)
  `);
  db.$client.transaction(() => {
    for (let i = 0; i < rows.count; i++) {
      insert.run(
        randomUUID(),
        `${rows.status} rule ${i} for ${repo}`,
        repo,
        rows.status,
        rows.confidence,
        at,
        at,
        rows.injections ?? 0,
        rows.overrides ?? 0,
      );
    }
  })();
}

describe("compile_confidence_threshold without active memories", () => {
  it("stays at the injection gate with 2,000 candidates and a high score", () => {
    const db = freshDb();
    insertRows(db, "acme/app", { count: 2000, status: "candidate", confidence: 0.59, ageDays: 0 });
    const profile = getRepoQualityProfile(db, "acme/app");
    expect(profile.total_count).toBe(2000);
    expect(profile.active_count).toBe(0);
    expect(profile.score).toBeGreaterThan(0.8);
    expect(profile.compile_confidence_threshold).toBe(CONFIDENCE.ACTIVE_MIN);
  });

  it("is not raised by health and override signals of never-active candidates", () => {
    const db = freshDb();
    insertRows(db, "acme/app", {
      count: 20, status: "candidate", confidence: 0.35, ageDays: 400, injections: 10, overrides: 10,
    });
    const profile = getRepoQualityProfile(db, "acme/app");
    expect(profile.active_count).toBe(0);
    // Before the fix this score raised the gate to ACTIVE_MIN + 0.05.
    expect(profile.score).toBeLessThan(0.45);
    expect(profile.compile_confidence_threshold).toBe(CONFIDENCE.ACTIVE_MIN);
  });

  it("keeps the existing adjustment once a memory is active", () => {
    const db = freshDb();
    insertRows(db, "acme/app", {
      count: 20, status: "candidate", confidence: 0.35, ageDays: 400, injections: 10, overrides: 10,
    });
    insertRows(db, "acme/app", {
      count: 1, status: "active", confidence: 0.6, ageDays: 400, injections: 10, overrides: 10,
    });
    const profile = getRepoQualityProfile(db, "acme/app");
    expect(profile.active_count).toBe(1);
    expect(profile.stage).toBe("cold");
    expect(profile.score).toBeLessThan(0.45);
    expect(profile.compile_confidence_threshold).toBeCloseTo(CONFIDENCE.ACTIVE_MIN + 0.05, 10);
  });
});

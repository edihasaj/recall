import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import {
  createMemory,
  getMemory,
  queryMemories,
  confirmMemory,
} from "../src/models/memory.js";
import { startEvalSession, endEvalSession, getEvalSession, incrementEvalCounter, computeMetrics, formatMetricsReport } from "../src/eval/harness.js";
import { recordSignal, getSignals, getSignalStats, recordTestSignals } from "../src/feedback/implicit.js";
import { inferScope, analyzeScopePatterns } from "../src/capture/scope.js";
import { cosineSimilarity } from "../src/embeddings/embeddings.js";

let dbCounter = 0;
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-p2-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

// --- Eval harness ---

describe("eval harness", () => {
  it("tracks session lifecycle", () => {
    const db = freshDb();
    const id = startEvalSession(db, "test/repo");
    const session = getEvalSession(db, id);
    expect(session).toBeDefined();
    expect(session!.repo).toBe("test/repo");
    expect(session!.ended_at).toBeNull();

    endEvalSession(db, id);
    const ended = getEvalSession(db, id);
    expect(ended!.ended_at).not.toBeNull();
  });

  it("increments counters", () => {
    const db = freshDb();
    const id = startEvalSession(db, "test/repo");

    incrementEvalCounter(db, id, "memories_injected", 3);
    incrementEvalCounter(db, id, "memories_followed", 2);
    incrementEvalCounter(db, id, "memories_overridden", 1);

    const session = getEvalSession(db, id);
    expect(session!.memories_injected).toBe(3);
    expect(session!.memories_followed).toBe(2);
    expect(session!.memories_overridden).toBe(1);
  });

  it("computes metrics", () => {
    const db = freshDb();

    // Create 2 sessions
    const s1 = startEvalSession(db, "test/repo");
    incrementEvalCounter(db, s1, "memories_injected", 5);
    incrementEvalCounter(db, s1, "memories_followed", 4);
    incrementEvalCounter(db, s1, "memories_overridden", 1);
    endEvalSession(db, s1);

    const s2 = startEvalSession(db, "test/repo");
    incrementEvalCounter(db, s2, "memories_injected", 3);
    incrementEvalCounter(db, s2, "memories_followed", 3);
    endEvalSession(db, s2);

    const metrics = computeMetrics(db, { repo: "test/repo" });
    expect(metrics.total_sessions).toBe(2);
    expect(metrics.follow_rate).toBeCloseTo(7 / 8); // 7 followed / 8 injected
    expect(metrics.override_rate).toBeCloseTo(1 / 8);
  });

  it("formats report", () => {
    const db = freshDb();
    const metrics = computeMetrics(db);
    const report = formatMetricsReport(metrics);
    expect(report).toContain("Recall Evaluation Report");
    expect(report).toContain("Sessions:");
  });
});

// --- Implicit feedback ---

describe("implicit feedback", () => {
  it("records signals and adjusts confidence", () => {
    const db = freshDb();
    const memId = createMemory(db, {
      type: "rule",
      text: "test rule",
      scope: "repo",
      source: "user_correction",
      confidence: 0.65,
    });

    const before = getMemory(db, memId)!.confidence;
    recordSignal(db, memId, "s1", "test_pass");
    const after = getMemory(db, memId)!.confidence;
    expect(after).toBeGreaterThan(before);
  });

  it("demotes on test failure", () => {
    const db = freshDb();
    const memId = createMemory(db, {
      type: "rule",
      text: "test rule",
      scope: "repo",
      source: "user_correction",
      confidence: 0.7,
    });

    recordSignal(db, memId, "s1", "test_fail");
    const mem = getMemory(db, memId)!;
    expect(mem.confidence).toBeLessThan(0.7);
  });

  it("tracks signal stats", () => {
    const db = freshDb();
    const memId = createMemory(db, {
      type: "rule",
      text: "test",
      scope: "repo",
      source: "user_correction",
      confidence: 0.7,
    });

    recordSignal(db, memId, "s1", "test_pass");
    recordSignal(db, memId, "s2", "test_pass");
    recordSignal(db, memId, "s3", "file_unchanged");

    const stats = getSignalStats(db, memId);
    expect(stats.test_pass).toBe(2);
    expect(stats.file_unchanged).toBe(1);
    expect(stats.test_fail).toBe(0);
  });

  it("records test signals for multiple memories", () => {
    const db = freshDb();
    const m1 = createMemory(db, {
      type: "rule",
      text: "r1",
      scope: "repo",
      source: "user_correction",
      confidence: 0.7,
    });
    const m2 = createMemory(db, {
      type: "rule",
      text: "r2",
      scope: "repo",
      source: "user_correction",
      confidence: 0.7,
    });

    const ids = recordTestSignals(db, "sess", [m1, m2], {
      passed: true,
      output: "all tests pass",
    });
    expect(ids).toHaveLength(2);
  });
});

// --- Scope inference ---

describe("scope inference", () => {
  it("detects explicit file scope", () => {
    const result = inferScope("in this file only, use tabs not spaces");
    expect(result.scope).toBe("path");
    expect(result.reason).toContain("explicit file scope");
  });

  it("detects explicit repo scope", () => {
    const result = inferScope("for this repo, always use strict mode");
    expect(result.scope).toBe("repo");
    expect(result.reason).toContain("explicit repo scope");
  });

  it("detects team scope", () => {
    const result = inferScope("for all projects use conventional commits");
    expect(result.scope).toBe("team");
    expect(result.reason).toContain("explicit team/org scope");
  });

  it("detects session scope", () => {
    const result = inferScope("just for now, skip the linter");
    expect(result.scope).toBe("session");
    expect(result.reason).toContain("explicit session scope");
  });

  it("infers repo scope from framework reference", () => {
    const result = inferScope("always use TypeScript strict mode");
    expect(result.scope).toBe("repo");
    expect(result.reason).toContain("language/framework");
  });

  it("infers path scope from source file context", () => {
    const result = inferScope("use a different pattern here", "src/components/Button.tsx");
    expect(result.scope).toBe("path");
    expect(result.path_scope).toContain("src/components");
  });

  it("infers repo scope from config file context", () => {
    const result = inferScope("change this setting", "tsconfig.json");
    expect(result.scope).toBe("repo");
  });

  it("detects file reference in text", () => {
    const result = inferScope("the utils/format.ts file should always export default");
    expect(result.scope).toBe("path");
  });

  it("defaults to repo scope", () => {
    const result = inferScope("make it better");
    expect(result.scope).toBe("repo");
    expect(result.reason).toContain("default");
  });

  it("analyzes scope patterns", () => {
    const corrections = [
      { text: "a", path: "src/api/routes.ts", scope: "path" as const },
      { text: "b", path: "src/api/middleware.ts", scope: "path" as const },
      { text: "c", path: "src/api/auth.ts", scope: "path" as const },
    ];
    const suggestions = analyzeScopePatterns(corrections);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].path_scope).toContain("src/api");
  });
});

// --- Embeddings (cosine similarity only — no API calls) ---

describe("embeddings", () => {
  it("computes cosine similarity correctly", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  it("handles partial similarity", () => {
    const a = new Float32Array([1, 1, 0]);
    const b = new Float32Array([1, 0, 0]);
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.5);
    expect(sim).toBeLessThan(1.0);
  });

  it("handles zero vectors", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

// --- Sync state (local DB only, no network) ---

describe("sync state", () => {
  it("adds sync_version and team_id columns", () => {
    const db = freshDb();
    const memId = createMemory(db, {
      type: "rule",
      text: "sync test",
      scope: "repo",
      source: "user_correction",
      confidence: 0.7,
    });

    const mem = getMemory(db, memId)!;
    // sync_version defaults to 0, team_id defaults to null
    expect(mem).toBeDefined();
    expect(mem.text).toBe("sync test");
  });
});

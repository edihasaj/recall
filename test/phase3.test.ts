import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import {
  createMemory,
  getMemory,
  confirmMemory,
  rejectMemory,
  queryMemories,
  recordFeedback,
} from "../src/models/memory.js";
import { createPolicy, listPolicies, togglePolicy, deletePolicy, evaluatePolicy, matchesAutoApprove, requestApproval, resolveApproval, listPendingApprovals } from "../src/policy/engine.js";
import { computeHealthScore, computeAllHealthScores, formatHealthReport } from "../src/health/scoring.js";
import { detectContradictions, resolveContradiction, autoResolveContradictions, listContradictions } from "../src/contradictions/detector.js";
import { pruneMemories, formatPruneReport } from "../src/pruning/pruner.js";
import { recordAudit, getAuditTrail, getRecentAudit, formatAuditTrail, diffSnapshots, rollbackMemory, recordAuditWithSnapshot } from "../src/audit/trail.js";
import { recordSignal } from "../src/feedback/implicit.js";
import { eq } from "drizzle-orm";
import { memories } from "../src/db/schema.js";

let dbCounter = 0;
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-p3-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

function makeMemory(db: ReturnType<typeof freshDb>, overrides: Record<string, any> = {}) {
  return createMemory(db, {
    text: overrides.text ?? "always use strict mode",
    type: overrides.type ?? "rule",
    source: overrides.source ?? "correction",
    scope: overrides.scope ?? "repo",
    repo: overrides.repo ?? "test/repo",
    confidence: overrides.confidence ?? 0.7,
    evidence: overrides.evidence ?? [],
    ...(overrides.status === "active" ? {} : {}),
  });
}

// --- Policy engine ---

describe("policy engine", () => {
  it("creates and lists policies", () => {
    const db = freshDb();
    const id = createPolicy(db, "org-1", "min_confidence", { min_confidence: 0.5 });
    expect(id).toBeDefined();
    const policies = listPolicies(db, "org-1");
    expect(policies).toHaveLength(1);
    expect(policies[0].rule_type).toBe("min_confidence");
    expect(policies[0].enabled).toBe(true);
  });

  it("toggles and deletes policies", () => {
    const db = freshDb();
    const id = createPolicy(db, "org-1", "min_confidence", { min_confidence: 0.5 });
    togglePolicy(db, id, false);
    expect(listPolicies(db, "org-1")[0].enabled).toBe(false);
    deletePolicy(db, id);
    expect(listPolicies(db, "org-1")).toHaveLength(0);
  });

  it("evaluates min_confidence violation", () => {
    const db = freshDb();
    createPolicy(db, "org-1", "min_confidence", { min_confidence: 0.8 });
    const memId = makeMemory(db, { confidence: 0.5 });
    const mem = getMemory(db, memId)!;
    const violations = evaluatePolicy(db, "org-1", mem);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule_type).toBe("min_confidence");
    expect(violations[0].blocking).toBe(true);
  });

  it("evaluates require_approval violation", () => {
    const db = freshDb();
    createPolicy(db, "org-1", "require_approval", { for_types: ["rule"] });
    const memId = makeMemory(db, { type: "rule" });
    const mem = getMemory(db, memId)!;
    const violations = evaluatePolicy(db, "org-1", mem);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule_type).toBe("require_approval");
  });

  it("evaluates blocked_scopes violation", () => {
    const db = freshDb();
    createPolicy(db, "org-1", "blocked_scopes", { scopes: ["team"] });
    const memId = makeMemory(db, { scope: "team" });
    const mem = getMemory(db, memId)!;
    const violations = evaluatePolicy(db, "org-1", mem);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule_type).toBe("blocked_scopes");
  });

  it("passes when no violations", () => {
    const db = freshDb();
    createPolicy(db, "org-1", "min_confidence", { min_confidence: 0.3 });
    const memId = makeMemory(db, { confidence: 0.7 });
    const mem = getMemory(db, memId)!;
    const violations = evaluatePolicy(db, "org-1", mem);
    expect(violations).toHaveLength(0);
  });

  it("matches auto-approve pattern", () => {
    const db = freshDb();
    createPolicy(db, "org-1", "auto_approve_pattern", { sources: ["correction"] });
    const memId = makeMemory(db, { source: "correction" });
    const mem = getMemory(db, memId)!;
    expect(matchesAutoApprove(db, "org-1", mem)).toBe(true);
  });
});

// --- Approval queue ---

describe("approval queue", () => {
  it("request → list → resolve approved", () => {
    const db = freshDb();
    const memId = makeMemory(db);
    const approvalId = requestApproval(db, memId, "org-1", "alice");
    expect(approvalId).toBeDefined();

    const pending = listPendingApprovals(db, "org-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].requested_by).toBe("alice");

    const ok = resolveApproval(db, approvalId, "approved", "bob", "looks good");
    expect(ok).toBe(true);

    // Memory should be confirmed
    const mem = getMemory(db, memId)!;
    expect(mem.status).toBe("active");

    // No more pending
    expect(listPendingApprovals(db, "org-1")).toHaveLength(0);
  });

  it("resolve denied rejects memory", () => {
    const db = freshDb();
    const memId = makeMemory(db);
    const approvalId = requestApproval(db, memId, "org-1", "alice");
    resolveApproval(db, approvalId, "denied", "bob");
    const mem = getMemory(db, memId)!;
    expect(mem.status).toBe("rejected");
  });
});

// --- Health scoring ---

describe("health scoring", () => {
  it("computes health score for a memory", () => {
    const db = freshDb();
    const memId = makeMemory(db, { confidence: 0.8 });
    confirmMemory(db, memId);
    const score = computeHealthScore(db, memId);
    expect(score).toBeDefined();
    expect(score!.score).toBeGreaterThan(0);
    expect(score!.score).toBeLessThanOrEqual(1);
    expect(score!.confidence_component).toBe(0.8);
  });

  it("returns null for nonexistent memory", () => {
    const db = freshDb();
    expect(computeHealthScore(db, "nope")).toBeNull();
  });

  it("computes all health scores", () => {
    const db = freshDb();
    makeMemory(db, { confidence: 0.9, text: "rule 1" });
    makeMemory(db, { confidence: 0.6, text: "rule 2" });
    const scores = computeAllHealthScores(db);
    expect(scores.length).toBe(2);
    // sorted descending
    expect(scores[0].score).toBeGreaterThanOrEqual(scores[1].score);
  });

  it("follow rate reflects feedback", () => {
    const db = freshDb();
    const memId = makeMemory(db, { confidence: 0.7 });
    confirmMemory(db, memId);
    recordFeedback(db, memId, "s1", true, "followed");
    recordFeedback(db, memId, "s2", true, "followed");
    recordFeedback(db, memId, "s3", true, "overridden");
    const score = computeHealthScore(db, memId)!;
    expect(score.follow_rate_component).toBeCloseTo(2 / 3);
  });

  it("signal ratio reflects implicit signals", () => {
    const db = freshDb();
    const memId = makeMemory(db, { confidence: 0.7 });
    confirmMemory(db, memId);
    recordSignal(db, memId, "s1", "test_pass");
    recordSignal(db, memId, "s1", "test_pass");
    recordSignal(db, memId, "s1", "test_fail");
    const score = computeHealthScore(db, memId)!;
    expect(score.signal_ratio_component).toBeCloseTo(2 / 3);
  });

  it("formats health report", () => {
    const db = freshDb();
    makeMemory(db, { confidence: 0.8 });
    const scores = computeAllHealthScores(db);
    const report = formatHealthReport(scores);
    expect(report).toContain("Memory Health Report");
    expect(report).toContain("Score");
  });
});

// --- Contradiction detection ---

describe("contradiction detection", () => {
  it("detects direct negation", () => {
    const db = freshDb();
    makeMemory(db, { text: "always use strict mode", confidence: 0.8 });
    makeMemory(db, { text: "never use strict mode", confidence: 0.5 });
    // Promote both to active
    const mems = queryMemories(db, { repo: "test/repo" });
    for (const m of mems) confirmMemory(db, m.id);

    const found = detectContradictions(db, "test/repo");
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0].contradiction_type).toBe("direct_negation");
    expect(found[0].severity).toBe("high");
  });

  it("detects conflicting rules (use A vs use B)", () => {
    const db = freshDb();
    makeMemory(db, { text: "use npm for package management", type: "rule", confidence: 0.8 });
    makeMemory(db, { text: "use yarn for package management", type: "rule", confidence: 0.5 });
    const mems = queryMemories(db, { repo: "test/repo" });
    for (const m of mems) confirmMemory(db, m.id);

    const found = detectContradictions(db, "test/repo");
    expect(found.length).toBeGreaterThanOrEqual(1);
    const conflict = found.find((c) => c.contradiction_type === "conflicting_rules");
    expect(conflict).toBeDefined();
  });

  it("resolves contradiction manually", () => {
    const db = freshDb();
    const idA = makeMemory(db, { text: "always use tabs", confidence: 0.8 });
    const idB = makeMemory(db, { text: "never use tabs", confidence: 0.5 });
    confirmMemory(db, idA);
    confirmMemory(db, idB);

    const found = detectContradictions(db, "test/repo");
    expect(found.length).toBeGreaterThanOrEqual(1);

    const ok = resolveContradiction(db, found[0].id, idA, "user", "prefer tabs");
    expect(ok).toBe(true);

    // B should be demoted
    const memB = getMemory(db, idB)!;
    expect(memB.status).toBe("candidate");

    // Contradiction should be resolved
    const resolved = listContradictions(db, { resolved: true });
    expect(resolved.length).toBe(1);
  });

  it("auto-resolves by confidence", () => {
    const db = freshDb();
    const idA = makeMemory(db, { text: "always use semicolons", confidence: 0.95 });
    const idB = makeMemory(db, { text: "never use semicolons", confidence: 0.5 });
    confirmMemory(db, idA); // stays 0.95 (> 0.8)
    confirmMemory(db, idB); // becomes 0.8

    const found = detectContradictions(db, "test/repo");
    expect(found.length).toBeGreaterThanOrEqual(1);

    // Verify unresolved contradictions exist in DB
    const unresolved = listContradictions(db, { resolved: false });
    expect(unresolved.length).toBeGreaterThanOrEqual(1);

    // Widen confidence gap to ensure auto-resolve passes threshold
    db.update(memories)
      .set({ confidence: 0.5 })
      .where(eq(memories.id, idB))
      .run();

    const count = autoResolveContradictions(db, "test/repo");
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("skips non-overlapping scopes", () => {
    const db = freshDb();
    makeMemory(db, { text: "always use X", scope: "path", path_scope: "src/a/**", confidence: 0.8, repo: "test/repo" });
    makeMemory(db, { text: "never use X", scope: "path", path_scope: "src/b/**", confidence: 0.8, repo: "test/repo" });
    const mems = queryMemories(db, { repo: "test/repo" });
    for (const m of mems) confirmMemory(db, m.id);

    const found = detectContradictions(db, "test/repo");
    expect(found).toHaveLength(0);
  });
});

// --- Pruning ---

describe("pruning", () => {
  it("prunes stale memories (dry run)", () => {
    const db = freshDb();
    // Create a memory with old timestamps
    const memId = makeMemory(db, { confidence: 0.7 });
    confirmMemory(db, memId);

    // Manually set old updated_at
    // uses top-level imports
    const oldDate = new Date(Date.now() - 100 * 86_400_000).toISOString(); // 100 days ago
    db.update(memories)
      .set({ updated_at: oldDate, last_validated_at: null, last_injected_at: null })
      .where(eq(memories.id, memId))
      .run();

    const result = pruneMemories(db, { stale_days: 90, dry_run: true });
    expect(result.stale_rejected).toContain(memId);
    expect(result.total).toBeGreaterThanOrEqual(1);

    // Dry run: status should be unchanged
    const mem = getMemory(db, memId)!;
    expect(mem.status).toBe("active");
  });

  it("prunes rejected memories past retention", () => {
    const db = freshDb();
    const memId = makeMemory(db, { confidence: 0.7 });
    rejectMemory(db, memId);

    // uses top-level imports
    const oldDate = new Date(Date.now() - 40 * 86_400_000).toISOString();
    db.update(memories)
      .set({ updated_at: oldDate })
      .where(eq(memories.id, memId))
      .run();

    const result = pruneMemories(db, { rejected_retention_days: 30 });
    expect(result.rejected_pruned).toContain(memId);

    // Memory should be deleted
    expect(getMemory(db, memId)).toBeUndefined();
  });

  it("can prune one repo without touching another", () => {
    const db = freshDb();
    const repoA = makeMemory(db, { repo: "test/repo", confidence: 0.7 });
    const repoB = makeMemory(db, { repo: "other/repo", confidence: 0.7 });
    confirmMemory(db, repoA);
    confirmMemory(db, repoB);

    const oldDate = new Date(Date.now() - 100 * 86_400_000).toISOString();
    db.update(memories)
      .set({ updated_at: oldDate, last_validated_at: null, last_injected_at: null })
      .where(eq(memories.id, repoA))
      .run();
    db.update(memories)
      .set({ updated_at: oldDate, last_validated_at: null, last_injected_at: null })
      .where(eq(memories.id, repoB))
      .run();

    const result = pruneMemories(db, {
      repo: "test/repo",
      stale_days: 90,
    });

    expect(result.stale_rejected).toContain(repoA);
    expect(result.stale_rejected).not.toContain(repoB);
    expect(getMemory(db, repoA)?.status).toBe("rejected");
    expect(getMemory(db, repoB)?.status).toBe("active");
  });

  it("formats prune report", () => {
    const result = {
      stale_rejected: ["abc"],
      rejected_pruned: [],
      transient_pruned: [],
      unhealthy_demoted: [],
      total: 1,
    };
    const report = formatPruneReport(result, false);
    expect(report).toContain("Stale rejected:    1");
  });
});

// --- Audit trail ---

describe("audit trail", () => {
  it("records and retrieves audit entries", () => {
    const db = freshDb();
    const memId = makeMemory(db);
    const auditId = recordAudit(db, memId, "created", "test-actor", "initial creation");
    expect(auditId).toBeDefined();

    const trail = getAuditTrail(db, memId);
    expect(trail.length).toBeGreaterThanOrEqual(1);
    expect(trail[0].action).toBe("created");
    expect(trail[0].actor).toBe("test-actor");
    expect(trail[0].reason).toBe("initial creation");
  });

  it("gets recent audit entries", () => {
    const db = freshDb();
    const memId = makeMemory(db);
    recordAudit(db, memId, "created", "actor1", null);
    recordAudit(db, memId, "promoted", "actor2", null);

    const recent = getRecentAudit(db, 10);
    expect(recent.length).toBe(2);
  });

  it("diffs snapshots", () => {
    const before = JSON.stringify({ text: "old text", confidence: 0.5 });
    const after = JSON.stringify({ text: "new text", confidence: 0.8 });
    const diffs = diffSnapshots(before, after);
    expect(diffs.length).toBe(2);
    const textDiff = diffs.find((d) => d.field === "text");
    expect(textDiff).toBeDefined();
    expect(textDiff!.before).toBe("old text");
    expect(textDiff!.after).toBe("new text");
  });

  it("returns empty diffs for null snapshots", () => {
    expect(diffSnapshots(null, null)).toEqual([]);
    expect(diffSnapshots(null, "{}")).toEqual([]);
  });

  it("records with explicit snapshots", () => {
    const db = freshDb();
    const memId = makeMemory(db);
    const mem = getMemory(db, memId)!;
    const auditId = recordAuditWithSnapshot(db, memId, "updated", "actor", "test", null, mem);

    const trail = getAuditTrail(db, memId);
    const entry = trail.find((e) => e.id === auditId)!;
    expect(entry.after_snapshot).toBeDefined();
    expect(JSON.parse(entry.after_snapshot!).text).toBe(mem.text);
  });

  it("rolls back a memory", () => {
    const db = freshDb();
    const memId = makeMemory(db, { text: "original text", confidence: 0.7 });
    confirmMemory(db, memId);
    const originalMem = getMemory(db, memId)!;

    // Record audit with snapshot before change
    const auditId = recordAuditWithSnapshot(
      db, memId, "updated", "actor", "change",
      originalMem, { ...originalMem, text: "changed text" },
    );

    // Simulate a change
    // uses top-level imports
    db.update(memories)
      .set({ text: "changed text" })
      .where(eq(memories.id, memId))
      .run();

    expect(getMemory(db, memId)!.text).toBe("changed text");

    // Rollback
    const ok = rollbackMemory(db, memId, auditId, "user");
    expect(ok).toBe(true);
    expect(getMemory(db, memId)!.text).toBe("original text");
  });

  it("formats audit trail", () => {
    const db = freshDb();
    const memId = makeMemory(db);
    recordAudit(db, memId, "created", "actor", "test");
    const trail = getAuditTrail(db, memId);
    const formatted = formatAuditTrail(trail);
    expect(formatted).toContain("Audit Trail");
    expect(formatted).toContain("created");
  });

  it("formats empty audit trail", () => {
    expect(formatAuditTrail([])).toBe("No audit entries.");
  });
});

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory, getMemory } from "../src/models/memory.js";
import {
  formatCleanupReport,
  planPromoteRepeats,
  qualityReasons,
  revertCleanupRun,
  runDeterministicCleanup,
} from "../src/maintenance/cleanup.js";
import { evaluatePromotionCandidates } from "../src/maintenance/promote.js";
import {
  collectPromotionEvidence,
  PROMOTION_SCORE_THRESHOLD,
  scorePromotionCandidate,
  type PromotionEvidence,
} from "../src/maintenance/promotion-score.js";
import {
  auditTrail,
  contradictions,
  feedbackEvents,
  maintenanceCleanupLog,
  memories,
  memoryInjections,
  memoryValueEvents,
} from "../src/db/schema.js";

type Db = ReturnType<typeof initStandaloneDb>;
let dbCounter = 0;

function freshDb(): Db {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-promotion-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

const RULE = "Always use .agent/config.json as the local main config file";

function candidate(db: Db, text = RULE, extra: Partial<Parameters<typeof createMemory>[1]> = {}): string {
  return createMemory(db, {
    type: "rule", text, scope: "repo", repo: "r", source: "user_correction", confidence: 0.5, ...extra,
  });
}

function inject(db: Db, memoryId: string, sessionId: string, day: string, outcome: "followed" | "overridden" | "contradicted" | "ignored" | null) {
  db.insert(memoryInjections).values({
    id: randomUUID(), memory_id: memoryId, session_id: sessionId, repo: "r",
    injected_at: `${day}T10:00:00.000Z`, outcome, outcome_at: outcome ? `${day}T11:00:00.000Z` : null,
  }).run();
}

function feedback(db: Db, memoryId: string, sessionId: string, outcome: "followed" | "overridden" | "contradicted" | "ignored", injected = true) {
  db.insert(feedbackEvents).values({
    id: randomUUID(), memory_id: memoryId, session_id: sessionId, injected, outcome,
    timestamp: new Date().toISOString(),
  }).run();
}

function used(db: Db, memoryId: string, sessionId: string) {
  db.insert(memoryValueEvents).values({
    id: randomUUID(), memory_id: memoryId, session_id: sessionId, repo: "r",
    event_type: "used", source: "test", created_at: new Date().toISOString(),
  }).run();
}

/** 4 `followed` outcomes across 2 sessions on 2 days (signal_outcome writes both tables). */
function followedTwice(db: Db, id: string) {
  inject(db, id, "s1", "2026-10-01", "followed");
  inject(db, id, "s2", "2026-10-02", "followed");
  feedback(db, id, "s1", "followed");
  feedback(db, id, "s2", "followed");
}

function baseEvidence(overrides: Partial<PromotionEvidence> = {}): PromotionEvidence {
  return {
    memory_id: "m", source: "user_correction", repetition_count: 0, injection_count: 0,
    followed: 0, overridden: 0, contradicted: 0, ignored: 0,
    injected_sessions: 0, injected_days: 0, used: 0,
    positive_feedback: 0, negative_feedback: 0, implicit_positive: 0, implicit_negative: 0,
    active_contradiction_ids: [], age_days: 1, stale: false,
    guards: {
      destructive_risky: false, trigger_template: false, non_user_capture: false,
      non_durable_provenance: false, session_scope: false, fragment_reasons: [],
    },
    ...overrides,
  };
}

describe("promotion — repetition path unchanged", () => {
  it("repetition_count >= 2 still promotes via=repetition with no score", () => {
    const db = freshDb();
    const id = candidate(db);
    db.update(memories).set({ repetition_count: 2 }).where(eq(memories.id, id)).run();

    const plan = planPromoteRepeats(db);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ matched_pattern: "repetition", memory_id: id });
    expect(plan[0].score).toBeUndefined();

    const report = runDeterministicCleanup(db, { dryRun: false, only: "promote_repeat_correction" });
    expect(getMemory(db, id)?.status).toBe("active");
    expect(formatCleanupReport(report)).toContain(`promote: ${id.slice(0, 8)}  via=repetition\n`);
  });
});

describe("promotion — evidence_score path", () => {
  it("4 followed outcomes across 2 sessions on 2 days promote via evidence_score", () => {
    const db = freshDb();
    const id = candidate(db);
    followedTwice(db, id);

    const evidence = collectPromotionEvidence(db, id)!;
    expect(evidence).toMatchObject({ followed: 2, injected_sessions: 2, injected_days: 2 });
    const scored = scorePromotionCandidate(evidence);
    expect(scored.score).toBe(8);
    expect(scored.decision).toBe("would_promote");

    const report = runDeterministicCleanup(db, { dryRun: false, only: "promote_repeat_correction" });
    expect(report.counts.repeat_promotions).toBe(1);
    expect(report.plan[0]).toMatchObject({ matched_pattern: "evidence_score", score: 8 });
    const after = getMemory(db, id);
    expect(after?.status).toBe("active");
    expect(after?.confidence).toBeGreaterThanOrEqual(0.7);

    const audit = db.select().from(auditTrail)
      .where(and(eq(auditTrail.memory_id, id), eq(auditTrail.action, "promoted"))).all();
    expect(audit.map((a) => a.reason)).toContain(`cleanup_promote:evidence_score:run:${report.run_id}`);
    const log = db.select().from(maintenanceCleanupLog).where(eq(maintenanceCleanupLog.memory_id, id)).all();
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("promote_repeat_correction");
    expect(log[0].details).toMatchObject({ matched_pattern: "evidence_score", score: 8 });
  });

  it("a contradicted outcome plus an active contradiction row suppresses promotion", () => {
    const db = freshDb();
    const id = candidate(db);
    followedTwice(db, id);
    inject(db, id, "s3", "2026-10-03", "contradicted");
    const other = createMemory(db, {
      type: "rule", text: "Keep local config in .env files only", scope: "repo", repo: "r",
      source: "user_correction", confidence: 0.9,
    });
    db.insert(contradictions).values({
      id: randomUUID(), memory_a_id: id, memory_b_id: other, contradiction_type: "conflicting_rules",
      severity: "medium", description: "test", resolved: false, detected_at: new Date().toISOString(),
    }).run();

    const [evaluation] = evaluatePromotionCandidates(db, { fragmentReasons: qualityReasons });
    expect(evaluation.decision).toBe("suppressed");
    expect(evaluation.explanation).toContain("contradicted=1:-4");
    expect(evaluation.explanation).toContain("active_contradictions=1:-6");
    expect(evaluation.explanation).toContain("suppressed_due_to_contradiction");

    expect(planPromoteRepeats(db)).toHaveLength(0);
    runDeterministicCleanup(db, { dryRun: false, only: "promote_repeat_correction" });
    expect(getMemory(db, id)?.status).toBe("candidate");
  });

  it("ignores contradiction rows whose other side is already rejected", () => {
    const db = freshDb();
    const id = candidate(db);
    followedTwice(db, id);
    const other = createMemory(db, {
      type: "rule", text: "Keep local config in .env files only", scope: "repo", repo: "r",
      source: "user_correction", confidence: 0.9,
    });
    db.update(memories).set({ status: "rejected" }).where(eq(memories.id, other)).run();
    db.insert(contradictions).values({
      id: randomUUID(), memory_a_id: other, memory_b_id: id, contradiction_type: "conflicting_rules",
      severity: "medium", description: "test", resolved: false, detected_at: new Date().toISOString(),
    }).run();

    expect(collectPromotionEvidence(db, id)?.active_contradiction_ids).toEqual([]);
    expect(planPromoteRepeats(db).map((p) => p.matched_pattern)).toEqual(["evidence_score"]);
  });

  it("live-checks would-promote rows against active memories", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule", text: "Never use the staging database for integration tests", scope: "repo", repo: "r",
      source: "user_correction", confidence: 0.9,
    });
    const id = candidate(db, "Always use the staging database for integration tests");
    followedTwice(db, id);

    const evaluation = evaluatePromotionCandidates(db, { fragmentReasons: qualityReasons })
      .find((e) => e.memory_id === id)!;
    expect(evaluation.decision).toBe("suppressed");
    expect(evaluation.evidence.active_contradiction_ids.some((c) => c.startsWith("live:"))).toBe(true);
    expect(planPromoteRepeats(db)).toHaveLength(0);
  });

  it("a 100-day-old candidate with no injections needs more evidence (stale)", () => {
    const db = freshDb();
    const id = candidate(db);
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    db.update(memories).set({ created_at: old }).where(eq(memories.id, id)).run();

    const [evaluation] = evaluatePromotionCandidates(db, { fragmentReasons: qualityReasons });
    expect(evaluation.evidence.stale).toBe(true);
    expect(evaluation.score).toBe(-3);
    expect(evaluation.decision).toBe("needs_more_evidence");
    expect(evaluation.explanation).toContain("stale_candidate=100d:-3");
  });

  it("dry-run carries score + explanation and mutates nothing", () => {
    const db = freshDb();
    const id = candidate(db);
    followedTwice(db, id);

    const report = runDeterministicCleanup(db, { dryRun: true, only: "promote_repeat_correction" });
    expect(report.counts.repeat_promotions).toBe(1);
    const item = report.plan[0];
    expect(item.kind).toBe("promote_repeat_correction");
    if (item.kind !== "promote_repeat_correction") throw new Error("unreachable");
    expect(item.score).toBe(8);
    expect(item.explanation).toEqual(expect.arrayContaining(["followed=2:+4", "meets_promotion_threshold"]));
    expect(formatCleanupReport(report)).toContain(`promote: ${id.slice(0, 8)}  via=evidence_score score=8 [followed=2:+4`);

    expect(getMemory(db, id)?.status).toBe("candidate");
    expect(db.select().from(maintenanceCleanupLog).all()).toHaveLength(0);
    expect(db.select().from(auditTrail).where(eq(auditTrail.action, "promoted")).all()).toHaveLength(0);
  });

  it("revert of an evidence promotion restores candidate", () => {
    const db = freshDb();
    const id = candidate(db);
    followedTwice(db, id);

    const report = runDeterministicCleanup(db, { dryRun: false, only: "promote_repeat_correction" });
    expect(getMemory(db, id)?.status).toBe("active");
    const reverted = revertCleanupRun(db, report.run_id);
    expect(reverted.reverted).toBe(1);
    const after = getMemory(db, id);
    expect(after?.status).toBe("candidate");
    expect(after?.confidence).toBe(0.5);
  });

  it("destructive-risky text never promotes, even with a score of 20+", () => {
    const db = freshDb();
    const id = candidate(db, "always remove plugins from settings");
    db.update(memories).set({ repetition_count: 5 }).where(eq(memories.id, id)).run();
    ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-03"].forEach((day, i) => {
      inject(db, id, `s${i}`, day, "followed");
      used(db, id, `s${i}`);
    });

    const [evaluation] = evaluatePromotionCandidates(db, { fragmentReasons: qualityReasons });
    expect(evaluation.score).toBeGreaterThanOrEqual(20);
    expect(evaluation.decision).toBe("suppressed");
    expect(evaluation.explanation).toContain("suppressed_due_to_destructive_risky");
    expect(planPromoteRepeats(db)).toHaveLength(0);
    runDeterministicCleanup(db, { dryRun: false, only: "promote_repeat_correction" });
    expect(getMemory(db, id)?.status).toBe("candidate");
  });

  it("counts repeated feedback inside one session once", () => {
    const db = freshDb();
    const id = candidate(db);
    inject(db, id, "s1", "2026-10-01", "followed");
    for (let i = 0; i < 5; i++) feedback(db, id, "s1", "followed");

    const evidence = collectPromotionEvidence(db, id)!;
    expect(evidence.followed).toBe(1);
    expect(scorePromotionCandidate(evidence)).toMatchObject({ score: 4, decision: "needs_more_evidence" });
  });

  it("unresolved injection sessions and days give no positive credit", () => {
    const db = freshDb();
    const id = candidate(db);
    for (let i = 1; i <= 10; i++) {
      inject(db, id, `s${i}`, `2026-10-${String(i).padStart(2, "0")}`, null);
      used(db, id, `s${i}`);
    }

    const evidence = collectPromotionEvidence(db, id)!;
    expect(evidence).toMatchObject({ followed: 0, injected_sessions: 0, injected_days: 0, used: 10 });
    expect(scorePromotionCandidate(evidence)).toMatchObject({ score: 4, decision: "needs_more_evidence" });
    expect(planPromoteRepeats(db)).toHaveLength(0);
  });

  it("a negative report in a followed session removes that session's positive credit", () => {
    const db = freshDb();
    const id = candidate(db);
    followedTwice(db, id);
    feedback(db, id, "s1", "overridden");

    const evidence = collectPromotionEvidence(db, id)!;
    expect(evidence).toMatchObject({ followed: 1, overridden: 1, injected_sessions: 1, injected_days: 1 });
    expect(scorePromotionCandidate(evidence)).toMatchObject({ score: 2, decision: "needs_more_evidence" });
    expect(planPromoteRepeats(db)).toHaveLength(0);
  });

  it("non-user_correction candidates promote on injection evidence like anyone else", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "command", text: "npm run typecheck", scope: "repo", repo: "r", source: "repo_scan", confidence: 0.5,
    });
    followedTwice(db, id);

    runDeterministicCleanup(db, { dryRun: false, only: "promote_repeat_correction" });
    expect(getMemory(db, id)?.status).toBe("active");
  });

  it("user_correction fragments are suppressed so the fragment filter wins", () => {
    const db = freshDb();
    const id = candidate(db, "must stay");
    followedTwice(db, id);

    const [evaluation] = evaluatePromotionCandidates(db, { fragmentReasons: qualityReasons });
    expect(evaluation.decision).toBe("suppressed");
    expect(evaluation.explanation.some((r) => r.startsWith("suppressed_due_to_fragment:"))).toBe(true);
  });

  it("generated and non-user capture contexts stay suppressed despite followed evidence", () => {
    for (const context of [
      "[system] Generated runtime instruction.",
      "Sub-agent output: use the generated configuration.",
    ]) {
      const db = freshDb();
      const id = candidate(db, RULE, {
        evidence: [{
          type: "session_correction", session: "capture", timestamp: new Date().toISOString(), context,
        }],
      });
      followedTwice(db, id);

      const evidence = collectPromotionEvidence(db, id)!;
      expect(scorePromotionCandidate(evidence).decision).toBe("suppressed");
      expect(planPromoteRepeats(db)).toHaveLength(0);
    }
  });

  it("session-scoped candidates do not become durable through injection outcomes", () => {
    const db = freshDb();
    const id = candidate(db, RULE, { scope: "session" });
    followedTwice(db, id);

    expect(collectPromotionEvidence(db, id)?.guards.session_scope).toBe(true);
    expect(planPromoteRepeats(db)).toHaveLength(0);
  });

  it("keeps an injection opt-out when followed evidence promotes the status", () => {
    const db = freshDb();
    const id = candidate(db);
    followedTwice(db, id);
    db.update(memories).set({ auto_inject: false }).where(eq(memories.id, id)).run();

    runDeterministicCleanup(db, { dryRun: false, only: "promote_repeat_correction" });

    expect(getMemory(db, id)).toMatchObject({ status: "active", auto_inject: false });
  });

  it("accepts only one of two conflicting scored candidates in the same plan", () => {
    const db = freshDb();
    const a = candidate(db, "Always use the staging database for integration tests");
    const b = candidate(db, "Never use the staging database for integration tests");
    followedTwice(db, a);
    followedTwice(db, b);

    const plan = planPromoteRepeats(db);
    expect(plan).toHaveLength(1);
    expect(plan[0].memory_id).toBe([a, b].sort()[0]);
    expect(planPromoteRepeats(db)).toEqual(plan);
    runDeterministicCleanup(db, { dryRun: false, only: "promote_repeat_correction" });
    expect([getMemory(db, a)?.status, getMemory(db, b)?.status].sort()).toEqual(["active", "candidate"]);
  });
});

describe("promotion — pure scorer", () => {
  it("caps every positive term", () => {
    const scored = scorePromotionCandidate(baseEvidence({
      followed: 10, used: 9, injected_sessions: 10, injected_days: 10, positive_feedback: 5,
    }));
    expect(scored.explanation).toEqual(expect.arrayContaining([
      "followed=10:+8", "used=9:+4", "injected_sessions=10:+4", "injected_days=10:+3", "positive_feedback=5:+4",
    ]));
    expect(scored.score).toBe(23);
  });

  it("7 is below the threshold and 8 meets it", () => {
    expect(PROMOTION_SCORE_THRESHOLD).toBe(8);
    const seven = scorePromotionCandidate(baseEvidence({ followed: 1, used: 3, injected_sessions: 1, injected_days: 1 }));
    expect(seven).toMatchObject({ score: 7, decision: "needs_more_evidence" });
    const eight = scorePromotionCandidate(baseEvidence({ followed: 1, used: 4, injected_sessions: 1, injected_days: 1 }));
    expect(eight).toMatchObject({ score: 8, decision: "would_promote" });
  });

  it("does not infer followed evidence from injection counts supplied directly", () => {
    const scored = scorePromotionCandidate(baseEvidence({ injected_sessions: 100, injected_days: 100, used: 100 }));
    expect(scored).toMatchObject({ score: 4, decision: "needs_more_evidence" });
  });

  it("repetition alone (+8) promotes; confidence is not an input", () => {
    expect(scorePromotionCandidate(baseEvidence({ repetition_count: 2 }))).toMatchObject({
      score: 8, decision: "would_promote",
    });
    expect(scorePromotionCandidate(baseEvidence({ repetition_count: 1 })).score).toBe(0);
  });

  it("applies negative terms uncapped", () => {
    const scored = scorePromotionCandidate(baseEvidence({
      followed: 4, overridden: 2, contradicted: 1, stale: true, age_days: 120,
    }));
    expect(scored.score).toBe(8 - 4 - 4 - 3);
    expect(scored.decision).toBe("needs_more_evidence");
  });

  it("negative explicit feedback above positive suppresses regardless of score", () => {
    const scored = scorePromotionCandidate(baseEvidence({
      followed: 4, injected_sessions: 4, positive_feedback: 1, negative_feedback: 2,
    }));
    expect(scored.score).toBeGreaterThanOrEqual(8);
    expect(scored.decision).toBe("suppressed");
    expect(scored.explanation).toContain("suppressed_due_to_negative_feedback");
  });

  it("every guard suppresses a score of 20", () => {
    const strong = { repetition_count: 2, followed: 4, used: 4 } as const;
    const guards = baseEvidence().guards;
    for (const key of ["destructive_risky", "trigger_template", "non_user_capture", "non_durable_provenance", "session_scope"] as const) {
      const scored = scorePromotionCandidate(baseEvidence({ ...strong, guards: { ...guards, [key]: true } }));
      expect(scored.score).toBe(20);
      expect(scored.decision).toBe("suppressed");
      expect(scored.explanation).toContain(`suppressed_due_to_${key}`);
    }
  });

  it("an active contradiction applies -6 and suppresses", () => {
    const scored = scorePromotionCandidate(baseEvidence({ repetition_count: 2, followed: 4, active_contradiction_ids: ["c1"] }));
    expect(scored.score).toBe(8 + 8 - 6);
    expect(scored.decision).toBe("suppressed");
  });
});

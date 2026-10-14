// Candidate promotion for the deterministic cleanup tier.
//
// Two matched patterns share the single `promote_repeat_correction` action so
// `--only`, revert, and the daemon's daily loop keep working unchanged:
//   * "repetition"     — candidate user_correction with repetition_count >= 2
//                         (unchanged legacy path).
//   * "evidence_score" — any candidate whose durable evidence (injection
//                         outcomes, `used` events, explicit feedback) scores
//                         >= PROMOTION_SCORE_THRESHOLD and no guard suppresses.
//                         See promotion-score.ts and docs/promotion-scoring.md.

import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { maintenanceCleanupLog, memories } from "../db/schema.js";
import { getMemory } from "../models/memory.js";
import { rowToMemory } from "../models/memory-row.js";
import { recordAuditWithSnapshot } from "../audit/trail.js";
import { hasNonDurableProvenance } from "../capture/provenance.js";
import { isDestructiveRisky } from "../capture/correction.js";
import { checkContradiction } from "../contradictions/detector.js";
import {
  collectPromotionEvidenceBatch,
  scorePromotionCandidate,
  type PromotionDecision,
  type PromotionEvidence,
} from "./promotion-score.js";
import type { MemoryItem } from "../types.js";

const DEFAULT_ACTOR = "maintenance:cleanup";

export interface PromoteRepeatPlan {
  kind: "promote_repeat_correction";
  memory_id: string;
  text: string;
  matched_pattern: "repetition" | "rule_shape" | "evidence_score";
  /** Present for matched_pattern = "evidence_score". */
  score?: number;
  explanation?: string[];
}

export interface PlanPromotionsOptions {
  /** Cleanup's fragment filter; rows it would reject never promote first. */
  fragmentReasons: (text: string) => string[];
  now?: Date;
}

export interface PromotionEvaluation {
  memory_id: string;
  text: string;
  source: string;
  evidence: PromotionEvidence;
  score: number;
  decision: PromotionDecision;
  explanation: string[];
}

export function planPromotions(db: RecallDb, opts: PlanPromotionsOptions): PromoteRepeatPlan[] {
  const repetition = planRepetitionPromotions(db, opts.fragmentReasons);
  const repetitionIds = new Set(repetition.map((p) => p.memory_id));
  const evidence = evaluatePromotionCandidates(db, { ...opts, preAcceptedIds: repetitionIds })
    .filter((e) => e.decision === "would_promote" && !repetitionIds.has(e.memory_id))
    .map((e): PromoteRepeatPlan => ({
      kind: "promote_repeat_correction",
      memory_id: e.memory_id,
      text: e.text,
      matched_pattern: "evidence_score",
      score: e.score,
      explanation: e.explanation,
    }));
  return [...repetition, ...evidence];
}

// Promotion gate (legacy, unchanged): candidate user_corrections auto-promote
// on repetition signal (>=2 distinct sessions producing the same correction).
// Shape alone (e.g. starting with "always") is NOT enough — that produced
// false-positive active rules from voice-transcript fragments. Feedback on
// sibling memories is not evidence that a brand-new rule is true.
function planRepetitionPromotions(
  db: RecallDb,
  fragmentReasons: (text: string) => string[],
): PromoteRepeatPlan[] {
  const rows = db.select({
    id: memories.id,
    text: memories.text,
    repetition_count: memories.repetition_count,
    scope: memories.scope,
  })
    .from(memories)
    .where(and(eq(memories.status, "candidate"), eq(memories.source, "user_correction")))
    .all();

  const out: PromoteRepeatPlan[] = [];
  for (const row of rows) {
    const text = row.text.trim();
    const memory = getMemory(db, row.id);
    if (!memory || hasNonDurableProvenance(memory)) continue;
    if (row.scope === "session") continue;
    // Skip rows that the fragment filter would also match — let it reject them
    // first so we don't flip-flop.
    if (fragmentReasons(text).length > 0) continue;
    // Destructive verbs paired with high-risk targets never auto-promote.
    if (isDestructiveRisky(text)) continue;
    if (row.repetition_count >= 2) {
      out.push({ kind: "promote_repeat_correction", memory_id: row.id, text, matched_pattern: "repetition" });
    }
  }
  return out;
}

/**
 * Score every candidate. Returned sorted by score desc, then id. Used by the
 * planner and for diagnostics (full decision distribution, not just winners).
 */
export function evaluatePromotionCandidates(
  db: RecallDb,
  opts: PlanPromotionsOptions & { preAcceptedIds?: ReadonlySet<string> },
): PromotionEvaluation[] {
  const items = db.select().from(memories)
    .where(eq(memories.status, "candidate"))
    .all()
    .map(rowToMemory);
  const byId = new Map(items.map((m) => [m.id, m]));
  const evidence = collectPromotionEvidenceBatch(db, items, {
    now: opts.now,
    fragmentReasons: opts.fragmentReasons,
  });

  const evaluations: PromotionEvaluation[] = [];
  for (const item of items) {
    const e = evidence.get(item.id);
    if (!e) continue;
    evaluations.push(toEvaluation(item, e));
  }
  applyLiveContradictionCheck(db, evaluations, byId, opts.preAcceptedIds ?? new Set());
  return evaluations.sort((a, b) => b.score - a.score || a.memory_id.localeCompare(b.memory_id));
}

function toEvaluation(item: MemoryItem, evidence: PromotionEvidence): PromotionEvaluation {
  const scored = scorePromotionCandidate(evidence);
  return {
    memory_id: item.id,
    text: item.text.trim(),
    source: item.source,
    evidence,
    score: scored.score,
    decision: scored.decision,
    explanation: scored.explanation,
  };
}

/**
 * The contradictions table only knows what the detector already recorded. A
 * would-promote row is also checked against every currently active memory
 * (and against rows accepted earlier in this plan) so one run can never
 * produce two conflicting active rules. Any match suppresses (conservative).
 */
function applyLiveContradictionCheck(
  db: RecallDb,
  evaluations: PromotionEvaluation[],
  byId: ReadonlyMap<string, MemoryItem>,
  preAcceptedIds: ReadonlySet<string>,
): void {
  const pending = evaluations
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.decision === "would_promote" && !preAcceptedIds.has(e.memory_id))
    .sort((x, y) => y.e.score - x.e.score || x.e.memory_id.localeCompare(y.e.memory_id));
  if (pending.length === 0) return;

  const accepted: MemoryItem[] = db.select().from(memories)
    .where(eq(memories.status, "active"))
    .all()
    .map(rowToMemory);
  for (const id of preAcceptedIds) {
    const m = byId.get(id);
    if (m) accepted.push(m);
  }

  for (const { e, index } of pending) {
    const candidate = byId.get(e.memory_id);
    if (!candidate) continue;
    const conflicts = accepted
      .filter((other) => other.id !== candidate.id && checkContradiction(candidate, other) != null)
      .map((other) => `live:${other.id}`);
    if (conflicts.length === 0) {
      accepted.push(candidate);
      continue;
    }
    const evidence: PromotionEvidence = {
      ...e.evidence,
      active_contradiction_ids: [...e.evidence.active_contradiction_ids, ...conflicts],
    };
    evaluations[index] = toEvaluation(candidate, evidence);
  }
}

export function applyPromoteRepeat(db: RecallDb, runId: string, plan: PromoteRepeatPlan): void {
  const before = getMemory(db, plan.memory_id);
  if (!before || before.status !== "candidate" || hasNonDurableProvenance(before)) return;
  if (plan.matched_pattern === "evidence_score" && isDestructiveRisky(before.text)) return;

  const now = new Date().toISOString();
  db.update(memories)
    .set({ status: "active", confidence: Math.max(before.confidence, 0.7), updated_at: now, last_validated_at: now })
    .where(eq(memories.id, plan.memory_id))
    .run();

  const after = getMemory(db, plan.memory_id);
  recordAuditWithSnapshot(
    db,
    plan.memory_id,
    "promoted",
    DEFAULT_ACTOR,
    `cleanup_promote:${plan.matched_pattern}:run:${runId}`,
    before,
    after ?? null,
  );

  const details: Record<string, unknown> = { matched_pattern: plan.matched_pattern };
  if (plan.score !== undefined) details.score = plan.score;
  if (plan.explanation) details.explanation = plan.explanation;

  db.insert(maintenanceCleanupLog).values({
    id: randomUUID(),
    run_id: runId,
    action: "promote_repeat_correction",
    memory_id: plan.memory_id,
    related_memory_id: null,
    before_snapshot: before as unknown as any,
    after_snapshot: after as unknown as any,
    details: details as any,
    reverted: false,
    reverted_at: null,
    created_at: now,
  }).run();
}

/** `promote: <id8>  via=<pattern>[ score=N [reason, reason]]` */
export function formatPromoteLine(item: PromoteRepeatPlan): string {
  let line = `  promote: ${item.memory_id.slice(0, 8)}  via=${item.matched_pattern}`;
  if (item.score !== undefined) {
    line += ` score=${item.score}`;
    if (item.explanation && item.explanation.length > 0) line += ` [${item.explanation.join(", ")}]`;
  }
  return line;
}

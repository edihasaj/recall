// Evidence-scored promotion for candidate memories.
//
// Two halves:
//   * collectPromotionEvidence(Batch) — reads the durable evidence a candidate
//     has earned (injection outcomes, `used` value events, explicit feedback,
//     implicit signals, live contradictions, age) plus safety guard flags.
//   * scorePromotionCandidate — pure: evidence -> score + decision + reasons.
//
// Confidence is deliberately NOT an input: it is the separate injection gate.
// Weights and rules are documented in docs/promotion-scoring.md; change them
// only together with a written reason there.

import { and, eq, inArray, or } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import {
  contradictions,
  feedbackEvents,
  implicitSignals,
  memories,
  memoryInjections,
  memoryValueEvents,
} from "../db/schema.js";
import { getMemory } from "../models/memory.js";
import { isDestructiveRisky, isTriggerTemplateRule } from "../capture/correction.js";
import { isNonUserCaptureContext } from "../capture/context.js";
import { hasNonDurableProvenance } from "../capture/provenance.js";
import type { MemoryItem } from "../types.js";

export const PROMOTION_SCORE_THRESHOLD = 8;
export const STALE_CANDIDATE_DAYS = 90;

export const PROMOTION_WEIGHTS = {
  /** Flat bonus once repetition_count >= 2 (two sessions produced the rule). */
  repetition: 8,
  followed: 2,
  followedCap: 8,
  used: 1,
  usedCap: 4,
  injectedSession: 1,
  injectedSessionCap: 4,
  injectedDay: 1,
  injectedDayCap: 3,
  positiveFeedback: 2,
  positiveFeedbackCap: 4,
  overridden: -2,
  contradicted: -4,
  activeContradiction: -6,
  staleCandidate: -3,
} as const;

export type PromotionDecision = "would_promote" | "needs_more_evidence" | "suppressed";

export interface PromotionGuards {
  destructive_risky: boolean;
  trigger_template: boolean;
  non_user_capture: boolean;
  non_durable_provenance: boolean;
  session_scope: boolean;
  /** Fragment-shape reasons (user_correction only); non-empty suppresses. */
  fragment_reasons: string[];
}

export interface PromotionEvidence {
  memory_id: string;
  source: string;
  repetition_count: number;
  injection_count: number;
  /** Distinct sessions with each outcome (memory_injections ∪ injected feedback). */
  followed: number;
  overridden: number;
  contradicted: number;
  ignored: number;
  /** Distinct injected sessions / UTC days with a followed outcome. */
  injected_sessions: number;
  injected_days: number;
  /** Distinct sessions with a `used` memory_value_events row. */
  used: number;
  /** Distinct sessions with explicit (injected=false) feedback. */
  positive_feedback: number;
  negative_feedback: number;
  /** implicit_signals rows; collected for visibility, not scored. */
  implicit_positive: number;
  implicit_negative: number;
  /** Unresolved contradiction row ids whose other side is still live. */
  active_contradiction_ids: string[];
  age_days: number;
  stale: boolean;
  guards: PromotionGuards;
}

export interface PromotionScore {
  score: number;
  decision: PromotionDecision;
  explanation: string[];
}

export interface CollectPromotionEvidenceOptions {
  now?: Date;
  /**
   * Fragment-shape check for user_correction text (cleanup's
   * `qualityReasons`). Injected so this module never imports cleanup.ts.
   */
  fragmentReasons?: (text: string) => string[];
}

// --- Pure scorer -----------------------------------------------------------

export function scorePromotionCandidate(e: PromotionEvidence): PromotionScore {
  const W = PROMOTION_WEIGHTS;
  const explanation: string[] = [];
  let score = 0;
  const add = (label: string, points: number) => {
    if (points === 0) return;
    score += points;
    explanation.push(`${label}:${points > 0 ? "+" : ""}${points}`);
  };

  if (e.repetition_count >= 2) add(`repetition=${e.repetition_count}`, W.repetition);
  if (e.followed > 0) add(`followed=${e.followed}`, Math.min(e.followed * W.followed, W.followedCap));
  if (e.used > 0) add(`used=${e.used}`, Math.min(e.used * W.used, W.usedCap));
  // Diversity bonuses are corroboration of followed outcomes, never proof
  // from delivery alone. Bound them here as well as in the DB collector.
  const followedInjectedSessions = Math.min(e.injected_sessions, e.followed);
  const followedInjectedDays = Math.min(e.injected_days, followedInjectedSessions);
  if (followedInjectedSessions > 0) {
    add(`injected_sessions=${e.injected_sessions}`,
      Math.min(followedInjectedSessions * W.injectedSession, W.injectedSessionCap));
  }
  if (followedInjectedDays > 0) {
    add(`injected_days=${e.injected_days}`, Math.min(followedInjectedDays * W.injectedDay, W.injectedDayCap));
  }
  if (e.positive_feedback > 0) {
    add(`positive_feedback=${e.positive_feedback}`,
      Math.min(e.positive_feedback * W.positiveFeedback, W.positiveFeedbackCap));
  }
  if (e.overridden > 0) add(`overridden=${e.overridden}`, e.overridden * W.overridden);
  if (e.contradicted > 0) add(`contradicted=${e.contradicted}`, e.contradicted * W.contradicted);
  if (e.active_contradiction_ids.length > 0) {
    add(`active_contradictions=${e.active_contradiction_ids.length}`, W.activeContradiction);
  }
  if (e.stale) add(`stale_candidate=${e.age_days}d`, W.staleCandidate);

  // Visible but unscored: these never move the number.
  if (e.negative_feedback > 0) explanation.push(`negative_feedback=${e.negative_feedback}`);
  if (e.ignored > 0) explanation.push(`ignored=${e.ignored}`);
  if (e.implicit_positive > 0 || e.implicit_negative > 0) {
    explanation.push(`implicit=+${e.implicit_positive}/-${e.implicit_negative}(unscored)`);
  }

  const guardReasons = suppressionGuardReasons(e.guards);
  let decision: PromotionDecision;
  if (guardReasons.length > 0) {
    decision = "suppressed";
    for (const reason of guardReasons) explanation.push(`suppressed_due_to_${reason}`);
  } else if (e.negative_feedback > e.positive_feedback) {
    decision = "suppressed";
    explanation.push("suppressed_due_to_negative_feedback");
  } else if (e.active_contradiction_ids.length > 0) {
    decision = "suppressed";
    explanation.push("suppressed_due_to_contradiction");
  } else if (score >= PROMOTION_SCORE_THRESHOLD) {
    decision = "would_promote";
    explanation.push("meets_promotion_threshold");
  } else {
    decision = "needs_more_evidence";
    explanation.push("below_promotion_threshold");
  }
  return { score, decision, explanation };
}

export function suppressionGuardReasons(g: PromotionGuards): string[] {
  const reasons: string[] = [];
  if (g.destructive_risky) reasons.push("destructive_risky");
  if (g.trigger_template) reasons.push("trigger_template");
  if (g.non_user_capture) reasons.push("non_user_capture");
  if (g.non_durable_provenance) reasons.push("non_durable_provenance");
  if (g.session_scope) reasons.push("session_scope");
  if (g.fragment_reasons.length > 0) reasons.push(`fragment:${g.fragment_reasons.join("+")}`);
  return reasons;
}

// --- DB collector ----------------------------------------------------------

export function collectPromotionEvidence(
  db: RecallDb,
  memoryId: string,
  opts: CollectPromotionEvidenceOptions = {},
): PromotionEvidence | null {
  const memory = getMemory(db, memoryId);
  if (!memory) return null;
  return collectPromotionEvidenceBatch(db, [memory], opts).get(memoryId) ?? null;
}

interface Accumulator {
  outcomes: Record<"followed" | "overridden" | "contradicted" | "ignored", Set<string>>;
  injectedSessions: Set<string>;
  injectedDaysBySession: Map<string, string>;
  used: Set<string>;
  positive: Set<string>;
  negative: Set<string>;
  implicitPositive: number;
  implicitNegative: number;
  /** contradiction row id -> other memory id */
  contradictions: Map<string, string>;
}

const CHUNK = 400;
const IMPLICIT_POSITIVE = new Set(["test_pass", "file_unchanged", "task_accepted"]);
const IMPLICIT_NEGATIVE = new Set(["test_fail", "file_rewritten", "task_rejected"]);

/**
 * Batched evidence collection: a fixed number of queries per 400 memories
 * instead of per memory, so the daemon's synchronous cleanup tick stays short.
 */
export function collectPromotionEvidenceBatch(
  db: RecallDb,
  items: readonly MemoryItem[],
  opts: CollectPromotionEvidenceOptions = {},
): Map<string, PromotionEvidence> {
  const now = opts.now ?? new Date();
  const acc = new Map<string, Accumulator>();
  for (const item of items) acc.set(item.id, emptyAccumulator());
  const ids = [...acc.keys()];

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);

    const injections = db.select({
      memory_id: memoryInjections.memory_id,
      session_id: memoryInjections.session_id,
      injected_at: memoryInjections.injected_at,
      outcome: memoryInjections.outcome,
    }).from(memoryInjections).where(inArray(memoryInjections.memory_id, chunk)).all();
    for (const row of injections) {
      const a = acc.get(row.memory_id);
      if (!a) continue;
      a.injectedSessions.add(row.session_id);
      a.injectedDaysBySession.set(row.session_id, row.injected_at.slice(0, 10));
      if (row.outcome) a.outcomes[row.outcome].add(row.session_id);
    }

    // signal_outcome writes BOTH feedback_events and memory_injections.outcome
    // for one report, so outcomes are counted as distinct sessions, never rows.
    const feedback = db.select({
      memory_id: feedbackEvents.memory_id,
      session_id: feedbackEvents.session_id,
      injected: feedbackEvents.injected,
      outcome: feedbackEvents.outcome,
    }).from(feedbackEvents).where(inArray(feedbackEvents.memory_id, chunk)).all();
    for (const row of feedback) {
      const a = acc.get(row.memory_id);
      if (!a) continue;
      if (row.injected) {
        a.outcomes[row.outcome].add(row.session_id);
      } else if (row.outcome === "followed") {
        a.positive.add(row.session_id);
      } else if (row.outcome === "overridden" || row.outcome === "contradicted") {
        a.negative.add(row.session_id);
      }
    }

    const used = db.select({
      memory_id: memoryValueEvents.memory_id,
      session_id: memoryValueEvents.session_id,
    }).from(memoryValueEvents).where(and(
      inArray(memoryValueEvents.memory_id, chunk),
      eq(memoryValueEvents.event_type, "used"),
    )).all();
    for (const row of used) {
      const a = row.memory_id ? acc.get(row.memory_id) : undefined;
      if (a) a.used.add(row.session_id);
    }

    const implicit = db.select({
      memory_id: implicitSignals.memory_id,
      signal_type: implicitSignals.signal_type,
    }).from(implicitSignals).where(inArray(implicitSignals.memory_id, chunk)).all();
    for (const row of implicit) {
      const a = acc.get(row.memory_id);
      if (!a) continue;
      if (IMPLICIT_POSITIVE.has(row.signal_type)) a.implicitPositive += 1;
      else if (IMPLICIT_NEGATIVE.has(row.signal_type)) a.implicitNegative += 1;
    }

    const conflictRows = db.select({
      id: contradictions.id,
      a: contradictions.memory_a_id,
      b: contradictions.memory_b_id,
    }).from(contradictions).where(and(
      eq(contradictions.resolved, false),
      or(inArray(contradictions.memory_a_id, chunk), inArray(contradictions.memory_b_id, chunk)),
    )).all();
    for (const row of conflictRows) {
      acc.get(row.a)?.contradictions.set(row.id, row.b);
      acc.get(row.b)?.contradictions.set(row.id, row.a);
    }
  }

  const liveOthers = liveMemoryIds(db, [...acc.values()].flatMap((a) => [...a.contradictions.values()]));

  const out = new Map<string, PromotionEvidence>();
  for (const item of items) {
    const a = acc.get(item.id);
    if (!a) continue;
    // Feedback mirrors injection outcomes and can also report a later
    // correction. Never retain positive credit for a session that has
    // overridden or contradicted the memory, regardless of arrival order.
    const followedSessions = [...a.outcomes.followed].filter((session) =>
      !a.outcomes.overridden.has(session) && !a.outcomes.contradicted.has(session));
    const followedInjectedSessions = followedSessions.filter((session) => a.injectedSessions.has(session));
    const followedInjectedDays = new Set(followedInjectedSessions
      .map((session) => a.injectedDaysBySession.get(session))
      .filter((day): day is string => day !== undefined));
    const ageDays = ageInDays(item.created_at, now);
    out.set(item.id, {
      memory_id: item.id,
      source: item.source,
      repetition_count: item.repetition_count,
      injection_count: item.injection_count,
      followed: followedSessions.length,
      overridden: a.outcomes.overridden.size,
      contradicted: a.outcomes.contradicted.size,
      ignored: a.outcomes.ignored.size,
      injected_sessions: followedInjectedSessions.length,
      injected_days: followedInjectedDays.size,
      used: a.used.size,
      positive_feedback: a.positive.size,
      negative_feedback: a.negative.size,
      implicit_positive: a.implicitPositive,
      implicit_negative: a.implicitNegative,
      active_contradiction_ids: [...a.contradictions.entries()]
        .filter(([, other]) => liveOthers.has(other))
        .map(([id]) => id)
        .sort(),
      age_days: ageDays,
      stale: ageDays > STALE_CANDIDATE_DAYS && item.injection_count === 0 && a.injectedSessions.size === 0,
      guards: guardsFor(item, opts.fragmentReasons),
    });
  }
  return out;
}

function guardsFor(memory: MemoryItem, fragmentReasons?: (text: string) => string[]): PromotionGuards {
  const text = memory.text.trim();
  return {
    destructive_risky: isDestructiveRisky(text),
    trigger_template: isTriggerTemplateRule(text),
    non_user_capture: hasNonUserEvidenceContext(memory),
    non_durable_provenance: hasNonDurableProvenance(memory),
    session_scope: memory.scope === "session",
    // Same rule as the repetition path: user_correction rows that the
    // fragment filter would reject must not promote first (no flip-flop).
    fragment_reasons: memory.source === "user_correction" && fragmentReasons ? fragmentReasons(text) : [],
  };
}

function hasNonUserEvidenceContext(memory: MemoryItem): boolean {
  if (!Array.isArray(memory.evidence)) return false;
  return memory.evidence.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const context = (entry as { context?: unknown }).context;
    return typeof context === "string" && isNonUserCaptureContext(context);
  });
}

function liveMemoryIds(db: RecallDb, ids: readonly string[]): Set<string> {
  const unique = [...new Set(ids)];
  const live = new Set<string>();
  for (let i = 0; i < unique.length; i += CHUNK) {
    const rows = db.select({ id: memories.id }).from(memories).where(and(
      inArray(memories.id, unique.slice(i, i + CHUNK)),
      inArray(memories.status, ["active", "candidate"]),
    )).all();
    for (const row of rows) live.add(row.id);
  }
  return live;
}

function emptyAccumulator(): Accumulator {
  return {
    outcomes: { followed: new Set(), overridden: new Set(), contradicted: new Set(), ignored: new Set() },
    injectedSessions: new Set(),
    injectedDaysBySession: new Map(),
    used: new Set(),
    positive: new Set(),
    negative: new Set(),
    implicitPositive: 0,
    implicitNegative: 0,
    contradictions: new Map(),
  };
}

function ageInDays(createdAt: string, now: Date): number {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, Math.floor((now.getTime() - created) / 86_400_000));
}

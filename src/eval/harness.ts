/**
 * Evaluation harness — tracks memory effectiveness metrics per session.
 * Answers: are memories actually helping? Are they trusted?
 */

import { eq, sql, and, gte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { evalSessions, feedbackEvents, memories } from "../db/schema.js";
import type { EvalMetrics, EvalSession } from "../types.js";

// --- Session lifecycle ---

export function startEvalSession(
  db: RecallDb,
  repo: string,
): string {
  const id = randomUUID();
  db.insert(evalSessions)
    .values({
      id,
      repo,
      started_at: new Date().toISOString(),
    })
    .run();
  return id;
}

export function endEvalSession(db: RecallDb, sessionId: string) {
  db.update(evalSessions)
    .set({ ended_at: new Date().toISOString() })
    .where(eq(evalSessions.id, sessionId))
    .run();
}

export function getEvalSession(
  db: RecallDb,
  sessionId: string,
): EvalSession | undefined {
  const row = db
    .select()
    .from(evalSessions)
    .where(eq(evalSessions.id, sessionId))
    .get();
  return row as EvalSession | undefined;
}

// --- Increment counters ---

type CounterField =
  | "memories_injected"
  | "memories_followed"
  | "memories_overridden"
  | "user_corrections"
  | "test_passes"
  | "test_failures";

export function incrementEvalCounter(
  db: RecallDb,
  sessionId: string,
  field: CounterField,
  amount: number = 1,
) {
  const col = evalSessions[field];
  db.update(evalSessions)
    .set({ [field]: sql`${col} + ${amount}` })
    .where(eq(evalSessions.id, sessionId))
    .run();
}

// --- Compute metrics ---

export function computeMetrics(
  db: RecallDb,
  options: { repo?: string; since?: string } = {},
): EvalMetrics {
  const conditions = [];
  if (options.repo) conditions.push(eq(evalSessions.repo, options.repo));
  if (options.since) conditions.push(gte(evalSessions.started_at, options.since));

  const sessions =
    conditions.length > 0
      ? db
          .select()
          .from(evalSessions)
          .where(and(...conditions))
          .all()
      : db.select().from(evalSessions).all();

  if (sessions.length === 0) {
    return {
      total_sessions: 0,
      injection_rate: 0,
      follow_rate: 0,
      override_rate: 0,
      correction_frequency: 0,
      avg_confidence_at_injection: 0,
      memory_effectiveness: 0,
    };
  }

  const totals = sessions.reduce(
    (acc, s) => ({
      injected: acc.injected + s.memories_injected,
      followed: acc.followed + s.memories_followed,
      overridden: acc.overridden + s.memories_overridden,
      corrections: acc.corrections + s.user_corrections,
      test_passes: acc.test_passes + s.test_passes,
      test_failures: acc.test_failures + s.test_failures,
    }),
    {
      injected: 0,
      followed: 0,
      overridden: 0,
      corrections: 0,
      test_passes: 0,
      test_failures: 0,
    },
  );

  const totalTests = totals.test_passes + totals.test_failures;

  // Get average confidence of injected memories from feedback events
  const feedbackRows = db.select().from(feedbackEvents).all();
  const injectedFeedback = feedbackRows.filter((f) => f.injected);
  let avgConfidence = 0;
  if (injectedFeedback.length > 0) {
    const memIds = [...new Set(injectedFeedback.map((f) => f.memory_id))];
    let totalConf = 0;
    let count = 0;
    for (const memId of memIds) {
      const mem = db
        .select({ confidence: memories.confidence })
        .from(memories)
        .where(eq(memories.id, memId))
        .get();
      if (mem) {
        totalConf += mem.confidence;
        count++;
      }
    }
    avgConfidence = count > 0 ? totalConf / count : 0;
  }

  // Memory effectiveness = (followed - overridden) / injected
  const effectiveness =
    totals.injected > 0
      ? (totals.followed - totals.overridden) / totals.injected
      : 0;

  return {
    total_sessions: sessions.length,
    injection_rate:
      totals.injected / Math.max(sessions.length, 1),
    follow_rate:
      totals.injected > 0 ? totals.followed / totals.injected : 0,
    override_rate:
      totals.injected > 0 ? totals.overridden / totals.injected : 0,
    correction_frequency:
      totals.corrections / Math.max(sessions.length, 1),
    avg_confidence_at_injection: avgConfidence,
    memory_effectiveness: effectiveness,
  };
}

// --- Report formatting ---

export function formatMetricsReport(metrics: EvalMetrics): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `# Recall Evaluation Report`,
    ``,
    `Sessions: ${metrics.total_sessions}`,
    `Avg memories injected/session: ${metrics.injection_rate.toFixed(1)}`,
    ``,
    `## Trust`,
    `Follow rate:    ${pct(metrics.follow_rate)}`,
    `Override rate:  ${pct(metrics.override_rate)}`,
    `Effectiveness:  ${pct(metrics.memory_effectiveness)}`,
    ``,
    `## Learning`,
    `Corrections/session: ${metrics.correction_frequency.toFixed(1)}`,
    `Avg confidence at injection: ${metrics.avg_confidence_at_injection.toFixed(2)}`,
  ];
  return lines.join("\n");
}

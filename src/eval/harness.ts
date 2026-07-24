/**
 * Evaluation harness — tracks memory effectiveness metrics per session.
 * Answers: are memories actually helping? Are they trusted?
 */

import { eq, sql, and, gte, like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import {
  auditTrail,
  evalSessions,
  feedbackEvents,
  memories,
  memoryMaintenanceTasks,
} from "../db/schema.js";
import type {
  EvalMetrics,
  EvalSession,
  MaintenanceEvalMetrics,
  MaintenanceTaskKind,
} from "../types.js";

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
  const update = (() => {
    switch (field) {
      case "memories_injected":
        return { memories_injected: sql`${evalSessions.memories_injected} + ${amount}` };
      case "memories_followed":
        return { memories_followed: sql`${evalSessions.memories_followed} + ${amount}` };
      case "memories_overridden":
        return { memories_overridden: sql`${evalSessions.memories_overridden} + ${amount}` };
      case "user_corrections":
        return { user_corrections: sql`${evalSessions.user_corrections} + ${amount}` };
      case "test_passes":
        return { test_passes: sql`${evalSessions.test_passes} + ${amount}` };
      case "test_failures":
        return { test_failures: sql`${evalSessions.test_failures} + ${amount}` };
    }
  })();
  db.update(evalSessions).set(update).where(eq(evalSessions.id, sessionId)).run();
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
    const maintenance = computeMaintenanceMetrics(db);
    return {
      total_sessions: 0,
      injection_rate: 0,
      follow_rate: 0,
      override_rate: 0,
      correction_frequency: 0,
      avg_confidence_at_injection: 0,
      memory_effectiveness: 0,
      ...(maintenance ? { maintenance } : {}),
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

  const maintenance = computeMaintenanceMetrics(db);

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
    ...(maintenance ? { maintenance } : {}),
  };
}

export function computeMaintenanceMetrics(db: RecallDb): MaintenanceEvalMetrics | undefined {
  const rows = db.select().from(memoryMaintenanceTasks).all();
  if (rows.length === 0) return undefined;

  let completed = 0;
  let abandoned = 0;
  const completed_by_kind: Record<string, number> = {};
  let completionDurations: number[] = [];
  let mergeCompleted = 0;

  for (const row of rows) {
    if (row.status === "completed") {
      completed += 1;
      completed_by_kind[row.kind] = (completed_by_kind[row.kind] ?? 0) + 1;
      if (row.kind === "merge_duplicates") mergeCompleted += 1;
      if (row.completed_at) {
        const delta = new Date(row.completed_at).getTime() - new Date(row.created_at).getTime();
        if (Number.isFinite(delta) && delta >= 0) completionDurations.push(delta);
      }
    } else if (row.status === "abandoned") {
      abandoned += 1;
    }
  }

  // Merge precision: fraction of merge-touched memories NOT subsequently rolled back.
  // Audit rows tagged with reason LIKE 'merged_%' (actor = 'maintenance:<agent>')
  // are the universe; rolled_back entries on the same memory_id are the regressions.
  const mergeTouched = db.select().from(auditTrail)
    .where(and(
      like(auditTrail.reason, "merged_%"),
      like(auditTrail.actor, "maintenance:%"),
    ))
    .all();
  const touchedMemoryIds = new Set(mergeTouched.map((r) => r.memory_id));

  let mergeRollbacks = 0;
  if (touchedMemoryIds.size > 0) {
    const rollbacks = db.select().from(auditTrail)
      .where(eq(auditTrail.action, "rolled_back"))
      .all();
    for (const r of rollbacks) {
      if (touchedMemoryIds.has(r.memory_id)) mergeRollbacks += 1;
    }
  }

  const merge_precision = mergeCompleted >= 5 && touchedMemoryIds.size > 0
    ? Math.max(0, 1 - mergeRollbacks / touchedMemoryIds.size)
    : null;

  const mean_completion_ms = completionDurations.length
    ? completionDurations.reduce((a, b) => a + b, 0) / completionDurations.length
    : null;

  return {
    total_completed: completed,
    total_abandoned: abandoned,
    abandon_rate: completed + abandoned > 0 ? abandoned / (completed + abandoned) : 0,
    mean_completion_ms,
    completed_by_kind: completed_by_kind as Record<MaintenanceTaskKind, number>,
    merge_precision,
    merge_rollbacks: mergeRollbacks,
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
  if (metrics.maintenance) {
    const m = metrics.maintenance;
    lines.push(``, `## Maintenance (tier-2)`);
    lines.push(`Completed tasks:     ${m.total_completed}`);
    lines.push(`Abandoned tasks:     ${m.total_abandoned}`);
    lines.push(`Abandon rate:        ${pct(m.abandon_rate)}`);
    if (m.mean_completion_ms != null) {
      lines.push(`Mean completion:     ${(m.mean_completion_ms / 1000).toFixed(1)}s`);
    }
    if (m.merge_precision != null) {
      lines.push(`Merge precision:     ${pct(m.merge_precision)} (rollbacks: ${m.merge_rollbacks})`);
    }
    const kinds = Object.entries(m.completed_by_kind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(", ");
    if (kinds) lines.push(`By kind: ${kinds}`);
  }
  return lines.join("\n");
}

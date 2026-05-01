import { and, desc, eq, gte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { feedbackEvents, historyInjections, memories, memoryInjections, qualitySnapshots } from "../db/schema.js";

export interface QualityReport {
  window_start: string;
  window_end: string;
  injections: {
    total: number;
    resolved: number;
    unresolved: number;
    by_outcome: Record<string, number>;
    followed_rate_resolved: number | null;
  };
  feedback_events: {
    total: number;
    by_outcome: Record<string, number>;
  };
  history_injections: {
    total: number;
    unique_snippets: number;
  };
}

export function computeQualityReport(
  db: RecallDb,
  opts: { sinceIso?: string } = {},
): QualityReport {
  const now = new Date();
  const start = opts.sinceIso ?? new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const end = now.toISOString();

  const injectionRows = db.select({
    outcome: memoryInjections.outcome,
    count: sql<number>`count(*)`.as("count"),
  })
    .from(memoryInjections)
    .where(gte(memoryInjections.injected_at, start))
    .groupBy(memoryInjections.outcome)
    .all();

  const injectionsByOutcome: Record<string, number> = {};
  let injectionsTotal = 0;
  let injectionsResolved = 0;
  for (const row of injectionRows) {
    injectionsTotal += row.count;
    const key = row.outcome ?? "unresolved";
    injectionsByOutcome[key] = row.count;
    if (row.outcome) injectionsResolved += row.count;
  }
  const followed = injectionsByOutcome.followed ?? 0;
  const followedRate = injectionsResolved > 0 ? followed / injectionsResolved : null;

  const feedbackRows = db.select({
    outcome: feedbackEvents.outcome,
    count: sql<number>`count(*)`.as("count"),
  })
    .from(feedbackEvents)
    .where(and(gte(feedbackEvents.timestamp, start)))
    .groupBy(feedbackEvents.outcome)
    .all();

  const feedbackByOutcome: Record<string, number> = {};
  let feedbackTotal = 0;
  for (const row of feedbackRows) {
    feedbackTotal += row.count;
    feedbackByOutcome[row.outcome] = row.count;
  }

  const historyRow = db.select({
    total: sql<number>`count(*)`.as("total"),
    unique_snippets: sql<number>`count(distinct ${historyInjections.snippet_id})`.as("unique_snippets"),
  })
    .from(historyInjections)
    .where(gte(historyInjections.injected_at, start))
    .get();

  return {
    window_start: start,
    window_end: end,
    injections: {
      total: injectionsTotal,
      resolved: injectionsResolved,
      unresolved: injectionsTotal - injectionsResolved,
      by_outcome: injectionsByOutcome,
      followed_rate_resolved: followedRate,
    },
    feedback_events: {
      total: feedbackTotal,
      by_outcome: feedbackByOutcome,
    },
    history_injections: {
      total: Number(historyRow?.total ?? 0),
      unique_snippets: Number(historyRow?.unique_snippets ?? 0),
    },
  };
}

export interface QualitySnapshotRow {
  id: string;
  taken_at: string;
  window_start: string;
  window_end: string;
  injections_total: number;
  injections_resolved: number;
  injections_followed: number;
  injections_overridden: number;
  injections_contradicted: number;
  injections_ignored: number;
  followed_rate_resolved: number | null;
  active_rule_count: number;
  active_command_count: number;
  candidate_correction_count: number;
  history_injections_total: number;
  history_snippets_injected: number;
  notes: string | null;
}

export function recordQualitySnapshot(
  db: RecallDb,
  report: QualityReport,
  notes?: string,
): QualitySnapshotRow {
  const counts = report.injections.by_outcome;
  const ruleRow = db.select({ n: sql<number>`count(*)` }).from(memories)
    .where(and(eq(memories.status, "active"), eq(memories.type, "rule"))).get();
  const cmdRow = db.select({ n: sql<number>`count(*)` }).from(memories)
    .where(and(eq(memories.status, "active"), eq(memories.type, "command"))).get();
  const candRow = db.select({ n: sql<number>`count(*)` }).from(memories)
    .where(and(eq(memories.status, "candidate"), eq(memories.source, "user_correction"))).get();

  const row: QualitySnapshotRow = {
    id: randomUUID(),
    taken_at: new Date().toISOString(),
    window_start: report.window_start,
    window_end: report.window_end,
    injections_total: report.injections.total,
    injections_resolved: report.injections.resolved,
    injections_followed: counts.followed ?? 0,
    injections_overridden: counts.overridden ?? 0,
    injections_contradicted: counts.contradicted ?? 0,
    injections_ignored: counts.ignored ?? 0,
    followed_rate_resolved: report.injections.followed_rate_resolved,
    active_rule_count: ruleRow?.n ?? 0,
    active_command_count: cmdRow?.n ?? 0,
    candidate_correction_count: candRow?.n ?? 0,
    history_injections_total: report.history_injections.total,
    history_snippets_injected: report.history_injections.unique_snippets,
    notes: notes ?? null,
  };

  db.insert(qualitySnapshots).values(row).run();
  return row;
}

export function listQualitySnapshots(db: RecallDb, limit = 20): QualitySnapshotRow[] {
  return db.select().from(qualitySnapshots)
    .orderBy(desc(qualitySnapshots.taken_at))
    .limit(limit)
    .all();
}

export function diffQualitySnapshots(prev: QualitySnapshotRow, curr: QualitySnapshotRow) {
  const prevRate = prev.followed_rate_resolved ?? 0;
  const currRate = curr.followed_rate_resolved ?? 0;
  return {
    days_apart: (new Date(curr.taken_at).getTime() - new Date(prev.taken_at).getTime()) / 86_400_000,
    followed_rate_delta_pp: (currRate - prevRate) * 100,
    resolved_delta: curr.injections_resolved - prev.injections_resolved,
    followed_delta: curr.injections_followed - prev.injections_followed,
    contradicted_delta: curr.injections_contradicted - prev.injections_contradicted,
    active_rule_delta: curr.active_rule_count - prev.active_rule_count,
    candidate_delta: curr.candidate_correction_count - prev.candidate_correction_count,
    history_injections_delta: curr.history_injections_total - prev.history_injections_total,
    history_snippets_delta: curr.history_snippets_injected - prev.history_snippets_injected,
  };
}

export function formatQualityReport(r: QualityReport): string {
  const lines: string[] = [];
  lines.push(`Quality window: ${r.window_start.slice(0, 10)} → ${r.window_end.slice(0, 10)}`);
  lines.push("");
  lines.push("Injections:");
  lines.push(`  total:        ${r.injections.total}`);
  lines.push(`  resolved:     ${r.injections.resolved}`);
  lines.push(`  unresolved:   ${r.injections.unresolved}`);
  for (const [k, v] of Object.entries(r.injections.by_outcome)) {
    lines.push(`    ${k.padEnd(12)} ${v}`);
  }
  if (r.injections.followed_rate_resolved != null) {
    lines.push(`  followed rate (of resolved): ${(r.injections.followed_rate_resolved * 100).toFixed(1)}%`);
  } else {
    lines.push(`  followed rate (of resolved): n/a (no resolved injections in window)`);
  }
  lines.push("");
  lines.push("Feedback events:");
  lines.push(`  total:        ${r.feedback_events.total}`);
  for (const [k, v] of Object.entries(r.feedback_events.by_outcome)) {
    lines.push(`    ${k.padEnd(12)} ${v}`);
  }
  lines.push("");
  lines.push("History injections:");
  lines.push(`  total:        ${r.history_injections.total}`);
  lines.push(`  snippets:     ${r.history_injections.unique_snippets}`);
  return lines.join("\n");
}

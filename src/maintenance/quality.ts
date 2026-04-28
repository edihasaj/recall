import { and, gte, sql } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { feedbackEvents, memoryInjections } from "../db/schema.js";

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
  return lines.join("\n");
}

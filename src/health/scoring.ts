/**
 * Memory health scoring — composite score per memory.
 *
 * Score = weighted average of:
 *   - confidence (40%)
 *   - freshness / recency (25%)
 *   - follow rate from feedback (20%)
 *   - implicit signal ratio (15%)
 *
 * Memories decay over time if not validated/injected.
 */

import { eq } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { memories, feedbackEvents, implicitSignals } from "../db/schema.js";
import { getMemory, queryMemories, listMemories } from "../models/memory.js";
import type { HealthScore, MemoryItem } from "../types.js";

// --- Weights ---

const WEIGHTS = {
  confidence: 0.4,
  freshness: 0.25,
  follow_rate: 0.2,
  signal_ratio: 0.15,
} as const;

// --- Compute health score ---

export function computeHealthScore(
  db: RecallDb,
  memoryId: string,
): HealthScore | null {
  const mem = getMemory(db, memoryId);
  if (!mem) return null;

  const confidence = mem.confidence;
  const freshness = computeFreshness(mem);
  const followRate = computeFollowRate(db, memoryId);
  const signalRatio = computeSignalRatio(db, memoryId);

  const score =
    WEIGHTS.confidence * confidence +
    WEIGHTS.freshness * freshness +
    WEIGHTS.follow_rate * followRate +
    WEIGHTS.signal_ratio * signalRatio;

  return {
    memory_id: memoryId,
    score: clamp(score),
    confidence_component: confidence,
    freshness_component: freshness,
    follow_rate_component: followRate,
    signal_ratio_component: signalRatio,
    computed_at: new Date().toISOString(),
  };
}

// --- Batch health scores ---

export function computeAllHealthScores(
  db: RecallDb,
  repo?: string,
): HealthScore[] {
  const mems = repo ? queryMemories(db, { repo }) : listMemories(db);
  const scores: HealthScore[] = [];

  for (const mem of mems) {
    if (mem.status === "rejected") continue;
    const score = computeHealthScore(db, mem.id);
    if (score) scores.push(score);
  }

  return scores.sort((a, b) => b.score - a.score);
}

// --- Freshness ---

function computeFreshness(mem: MemoryItem): number {
  const now = Date.now();
  const referenceDate =
    mem.last_validated_at ?? mem.last_injected_at ?? mem.updated_at;
  const age = now - new Date(referenceDate).getTime();
  const dayMs = 86_400_000;

  // Exponential decay: halves every 30 days
  const halfLife = 30 * dayMs;
  const freshness = Math.pow(0.5, age / halfLife);
  return clamp(freshness);
}

// --- Follow rate from feedback ---

function computeFollowRate(db: RecallDb, memoryId: string): number {
  const feedback = db
    .select()
    .from(feedbackEvents)
    .where(eq(feedbackEvents.memory_id, memoryId))
    .all();

  if (feedback.length === 0) return 0.5; // neutral if no data

  const followed = feedback.filter((f) => f.outcome === "followed").length;
  return followed / feedback.length;
}

// --- Signal ratio (positive signals / total signals) ---

function computeSignalRatio(db: RecallDb, memoryId: string): number {
  const signals = db
    .select()
    .from(implicitSignals)
    .where(eq(implicitSignals.memory_id, memoryId))
    .all();

  if (signals.length === 0) return 0.5; // neutral if no data

  const positive = signals.filter((s) =>
    ["test_pass", "file_unchanged", "task_accepted"].includes(s.signal_type),
  ).length;

  return positive / signals.length;
}

// --- Format health report ---

export function formatHealthReport(scores: HealthScore[]): string {
  if (scores.length === 0) return "No memories to score.";

  const lines = [
    "# Memory Health Report",
    "",
    `Total: ${scores.length} memories scored`,
    "",
    "| Score | Conf | Fresh | Follow | Signal | ID       |",
    "|-------|------|-------|--------|--------|----------|",
  ];

  for (const s of scores.slice(0, 30)) {
    lines.push(
      `| ${pct(s.score)} | ${pct(s.confidence_component)} | ${pct(s.freshness_component)} | ${pct(s.follow_rate_component)} | ${pct(s.signal_ratio_component)} | ${s.memory_id.slice(0, 8)} |`,
    );
  }

  // Summary stats
  const avg = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
  const unhealthy = scores.filter((s) => s.score < 0.3).length;
  const healthy = scores.filter((s) => s.score >= 0.6).length;

  lines.push("");
  lines.push(`Avg score: ${pct(avg)}`);
  lines.push(`Healthy (≥0.6): ${healthy} | Unhealthy (<0.3): ${unhealthy}`);

  return lines.join("\n");
}

// --- Helpers ---

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function pct(n: number): string {
  return (n * 100).toFixed(0).padStart(3) + "%";
}

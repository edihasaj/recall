import { eq } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { contradictions } from "../db/schema.js";
import { computeAllHealthScores } from "../health/scoring.js";
import { queryMemories } from "../models/memory.js";
import { CONFIDENCE } from "../types.js";

export interface RepoQualityProfile {
  repo?: string;
  stage: "cold" | "growing" | "mature";
  score: number;
  total_count: number;
  active_count: number;
  avg_health: number;
  override_rate: number;
  contradiction_rate: number;
  repeat_sessions_required: number;
  compile_confidence_threshold: number;
  dedup_similarity_threshold: number;
}

export function getRepoQualityProfile(
  db: RecallDb,
  repo?: string,
): RepoQualityProfile {
  if (!repo) {
    return defaultProfile();
  }

  const memories = queryMemories(db, { repo }).filter((m) => m.status !== "rejected");
  const active = memories.filter((m) => m.status === "active");
  const activeCount = active.length;
  const totalCount = memories.length;

  const health = computeAllHealthScores(db, repo);
  const avgHealth = health.length > 0
    ? health.reduce((sum, item) => sum + item.score, 0) / health.length
    : 0.5;

  const totalInjections = memories.reduce((sum, m) => sum + m.injection_count, 0);
  const totalOverrides = memories.reduce((sum, m) => sum + m.override_count, 0);
  const overrideRate = totalInjections > 0 ? totalOverrides / totalInjections : 0;

  const ids = new Set(memories.map((m) => m.id));
  const unresolved = db
    .select()
    .from(contradictions)
    .where(eq(contradictions.resolved, false))
    .all()
    .filter((item) => ids.has(item.memory_a_id) || ids.has(item.memory_b_id));
  const contradictionRate = activeCount > 0
    ? unresolved.length / activeCount
    : 0;

  const stage = classifyStage(activeCount);
  const pressure = clamp(activeCount / 50);
  const score = clamp(
    avgHealth * 0.5 +
      (1 - clamp(overrideRate)) * 0.25 +
      (1 - clamp(contradictionRate)) * 0.15 +
      (1 - pressure) * 0.1,
  );

  let repeatSessionsRequired = stage === "cold"
    ? 2
    : stage === "growing"
      ? 3
      : 4;
  if (score >= 0.75 && repeatSessionsRequired > 2) {
    repeatSessionsRequired -= 1;
  } else if (score < 0.45) {
    repeatSessionsRequired += 1;
  }

  let compileConfidenceThreshold = stage === "cold"
    ? CONFIDENCE.ACTIVE_MIN
    : stage === "growing"
      ? 0.68
      : 0.72;
  if (score < 0.45) {
    compileConfidenceThreshold += 0.05;
  } else if (score > 0.8) {
    compileConfidenceThreshold -= 0.03;
  }

  let dedupSimilarityThreshold = stage === "cold"
    ? 0.85
    : stage === "growing"
      ? 0.8
      : 0.75;
  if (score < 0.45) {
    dedupSimilarityThreshold -= 0.05;
  }

  return {
    repo,
    stage,
    score,
    total_count: totalCount,
    active_count: activeCount,
    avg_health: avgHealth,
    override_rate: clamp(overrideRate),
    contradiction_rate: clamp(contradictionRate),
    repeat_sessions_required: repeatSessionsRequired,
    compile_confidence_threshold: clamp(
      compileConfidenceThreshold,
      CONFIDENCE.ACTIVE_MIN,
      0.82,
    ),
    dedup_similarity_threshold: clamp(dedupSimilarityThreshold, 0.65, 0.9),
  };
}

export function seedCandidateConfidence(
  baseConfidence: number,
  profile: RepoQualityProfile,
): number {
  const maturityPenalty = profile.stage === "cold"
    ? 0
    : profile.stage === "growing"
      ? 0.03
      : 0.05;
  const qualityPenalty = profile.score < 0.45 ? 0.03 : 0;
  return clamp(
    Math.min(CONFIDENCE.ACTIVE_MIN - 0.01, baseConfidence - maturityPenalty - qualityPenalty),
    CONFIDENCE.TRANSIENT_MAX + 0.05,
    CONFIDENCE.ACTIVE_MIN - 0.01,
  );
}

function classifyStage(activeCount: number): RepoQualityProfile["stage"] {
  if (activeCount < 10) return "cold";
  if (activeCount < 50) return "growing";
  return "mature";
}

function defaultProfile(): RepoQualityProfile {
  return {
    stage: "cold",
    score: 0.5,
    total_count: 0,
    active_count: 0,
    avg_health: 0.5,
    override_rate: 0,
    contradiction_rate: 0,
    repeat_sessions_required: 2,
    compile_confidence_threshold: CONFIDENCE.ACTIVE_MIN,
    dedup_similarity_threshold: 0.85,
  };
}

function clamp(n: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, n));
}

import { and, eq, gte } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { activityEvents, memories, memoryInjections, memoryValueEvents } from "../db/schema.js";

export interface ReliabilityReport {
  window_start: string;
  window_end: string;
  sessions: number;
  sessions_with_repo: number;
  repo_attribution_rate: number;
  selected_injections: number;
  emitted_injections: number;
  emission_coverage: number;
  observed_uses: number;
  resolved_outcomes: number;
  outcome_coverage: number;
  retrieval_misses: number;
  retrieval_observations: number;
  candidate_backlog: number;
  active_memories: number;
  checks: Array<{
    name: string;
    status: "pass" | "warn" | "fail";
    value: number;
    target: string;
  }>;
  overall: "pass" | "warn" | "fail";
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export function computeReliabilityReport(
  db: RecallDb,
  options: { since?: string; repo?: string } = {},
): ReliabilityReport {
  const end = new Date().toISOString();
  const start = options.since ?? new Date(Date.now() - 14 * 86_400_000).toISOString();
  const activityConditions = [gte(activityEvents.created_at, start)];
  const injectionConditions = [gte(memoryInjections.injected_at, start)];
  const valueConditions = [gte(memoryValueEvents.created_at, start)];
  if (options.repo) {
    activityConditions.push(eq(activityEvents.repo, options.repo));
    injectionConditions.push(eq(memoryInjections.repo, options.repo));
    valueConditions.push(eq(memoryValueEvents.repo, options.repo));
  }

  const activity = db.select().from(activityEvents).where(and(...activityConditions)).all();
  const injections = db.select().from(memoryInjections).where(and(...injectionConditions)).all();
  const valueEvents = db.select().from(memoryValueEvents).where(and(...valueConditions)).all();

  const lifecycle = activity.filter((event) =>
    event.session_id && (event.event_type === "session_start" || event.event_type === "session_end")
  );
  const sessionIds = new Set(lifecycle.map((event) => event.session_id!));
  const attributedSessionIds = new Set(
    lifecycle.filter((event) => Boolean(event.repo)).map((event) => event.session_id!),
  );

  const emittedPairs = new Set<string>();
  for (const event of activity) {
    if (event.event_type !== "session_event" || !event.session_id) continue;
    const request = typeof event.request === "string" ? JSON.parse(event.request) : event.request;
    if (request?.name !== "memory_emitted") continue;
    const memoryIds = Array.isArray(event.memory_ids) ? event.memory_ids : [];
    for (const memoryId of memoryIds) {
      emittedPairs.add(`${event.session_id}\u0000${memoryId}`);
    }
  }

  const selectedPairs = new Set(
    injections.map((injection) => `${injection.session_id}\u0000${injection.memory_id}`),
  );
  const emittedSelected = [...emittedPairs].filter((key) => selectedPairs.has(key)).length;
  const observedUses = valueEvents.filter((event) => event.event_type === "used").length;
  const resolvedOutcomes = injections.filter((injection) => injection.outcome != null).length;
  const retrievalMisses = valueEvents.filter((event) => event.event_type === "retrieval_miss").length;
  const retrievalUses = valueEvents.filter((event) => event.event_type === "used").length;
  const candidateBacklog = db.select({ id: memories.id }).from(memories)
    .where(eq(memories.status, "candidate")).all().length;
  const activeMemories = db.select({ id: memories.id }).from(memories)
    .where(eq(memories.status, "active")).all().length;

  const repoAttribution = ratio(attributedSessionIds.size, sessionIds.size);
  const emissionCoverage = ratio(emittedSelected, selectedPairs.size);
  const outcomeCoverage = ratio(resolvedOutcomes, emittedSelected);
  const retrievalObservations = retrievalMisses + retrievalUses;
  const checks: ReliabilityReport["checks"] = [
    { name: "repo_attribution", status: sessionIds.size === 0 ? "warn" : repoAttribution >= 0.95 ? "pass" : repoAttribution >= 0.8 ? "warn" : "fail", value: repoAttribution, target: ">=95%" },
    { name: "emission_coverage", status: selectedPairs.size === 0 ? "warn" : emissionCoverage >= 0.99 ? "pass" : emissionCoverage >= 0.95 ? "warn" : "fail", value: emissionCoverage, target: ">=99%" },
    { name: "outcome_coverage", status: emittedSelected === 0 ? "warn" : outcomeCoverage >= 0.8 ? "pass" : outcomeCoverage >= 0.5 ? "warn" : "fail", value: outcomeCoverage, target: ">=80%" },
    { name: "retrieval_observations", status: retrievalObservations >= 20 ? "pass" : retrievalObservations >= 5 ? "warn" : "fail", value: retrievalObservations, target: ">=20" },
    { name: "candidate_backlog", status: candidateBacklog <= 50 ? "pass" : candidateBacklog <= 100 ? "warn" : "fail", value: candidateBacklog, target: "<=50" },
  ];
  const overall = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warn") ? "warn" : "pass";

  return {
    window_start: start,
    window_end: end,
    sessions: sessionIds.size,
    sessions_with_repo: attributedSessionIds.size,
    repo_attribution_rate: repoAttribution,
    selected_injections: selectedPairs.size,
    emitted_injections: emittedSelected,
    emission_coverage: emissionCoverage,
    observed_uses: observedUses,
    resolved_outcomes: resolvedOutcomes,
    outcome_coverage: outcomeCoverage,
    retrieval_misses: retrievalMisses,
    retrieval_observations: retrievalObservations,
    candidate_backlog: candidateBacklog,
    active_memories: activeMemories,
    checks,
    overall,
  };
}

export function formatReliabilityReport(report: ReliabilityReport): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines = [
    "# Recall Reliability",
    "",
    `Window: ${report.window_start} to ${report.window_end}`,
    `Overall: ${report.overall.toUpperCase()}`,
    "",
    `Sessions: ${report.sessions} (${report.sessions_with_repo} with repo, ${percent(report.repo_attribution_rate)})`,
    `Injections: ${report.selected_injections} selected, ${report.emitted_injections} emitted (${percent(report.emission_coverage)})`,
    `Evidence: ${report.observed_uses} observed uses, ${report.resolved_outcomes} resolved outcomes (${percent(report.outcome_coverage)})`,
    `Retrieval: ${report.retrieval_observations} observations, ${report.retrieval_misses} misses`,
    `Memory: ${report.active_memories} active, ${report.candidate_backlog} candidates`,
    "",
    "## Checks",
  ];
  for (const check of report.checks) {
    const value = check.name.endsWith("coverage") || check.name === "repo_attribution"
      ? percent(check.value)
      : String(check.value);
    lines.push(`${check.status.toUpperCase().padEnd(4)} ${check.name}: ${value} (target ${check.target})`);
  }
  return lines.join("\n");
}

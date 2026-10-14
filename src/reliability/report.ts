import { and, eq, gte } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { activityEvents, memories, memoryInjections, memoryValueEvents } from "../db/schema.js";
import { isUnscopedSessionPath } from "../repo/git-root.js";

export interface ReliabilityReport {
  window_start: string;
  window_end: string;
  sessions: number;
  sessions_requiring_repo: number;
  sessions_with_repo: number;
  /** Sessions whose cwd cannot belong to a repository (no git checkout). */
  sessions_unscoped: number;
  /** Most common cwd among unscoped sessions, for an actionable hint. */
  unscoped_top_paths: Array<{ path: string; sessions: number }>;
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
  candidate_injectable_total: number;
  candidate_total: number;
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
  const scopedSessionIds = new Set(attributedSessionIds);
  const unscopedPathBySession = new Map<string, string>();
  const scopeCache = new Map<string, boolean>();
  const isUnscoped = (repoPath: string): boolean => {
    let cached = scopeCache.get(repoPath);
    if (cached === undefined) {
      cached = isUnscopedSessionPath(repoPath);
      scopeCache.set(repoPath, cached);
    }
    return cached;
  };
  for (const event of lifecycle) {
    if (!event.session_id) continue;
    const request = typeof event.request === "string" ? JSON.parse(event.request) : event.request;
    const repoPath = typeof request?.repo_path === "string" ? request.repo_path : "";
    if (!repoPath) continue;
    if (isUnscoped(repoPath)) {
      if (!unscopedPathBySession.has(event.session_id)) unscopedPathBySession.set(event.session_id, repoPath);
    } else {
      scopedSessionIds.add(event.session_id);
    }
  }
  const unscopedSessions = sessionIds.size - scopedSessionIds.size;
  const unscopedPathCounts = new Map<string, number>();
  for (const [sessionId, repoPath] of unscopedPathBySession) {
    if (scopedSessionIds.has(sessionId)) continue;
    unscopedPathCounts.set(repoPath, (unscopedPathCounts.get(repoPath) ?? 0) + 1);
  }
  const unscopedTopPaths = [...unscopedPathCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([path, sessions]) => ({ path, sessions }));

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
  const candidates = db.select({ id: memories.id, auto_inject: memories.auto_inject, repo: memories.repo }).from(memories)
    .where(eq(memories.status, "candidate")).all();
  const injectableCandidates = candidates.filter((memory) => memory.auto_inject);
  const candidatesByRepo = new Map<string, number>();
  for (const memory of injectableCandidates) {
    const key = memory.repo ?? "global";
    candidatesByRepo.set(key, (candidatesByRepo.get(key) ?? 0) + 1);
  }
  const candidateBacklog = options.repo
    ? injectableCandidates.length
    : Math.max(0, ...candidatesByRepo.values());
  const activeMemories = db.select({ id: memories.id }).from(memories)
    .where(eq(memories.status, "active")).all().length;

  const repoAttribution = ratio(attributedSessionIds.size, scopedSessionIds.size);
  const scopeCoverage = ratio(scopedSessionIds.size, sessionIds.size);
  const emissionCoverage = ratio(emittedSelected, selectedPairs.size);
  const outcomeCoverage = ratio(resolvedOutcomes, emittedSelected);
  const retrievalObservations = retrievalMisses + retrievalUses;
  const checks: ReliabilityReport["checks"] = [
    { name: "repo_attribution", status: scopedSessionIds.size === 0 ? "warn" : repoAttribution >= 0.95 ? "pass" : repoAttribution >= 0.8 ? "warn" : "fail", value: repoAttribution, target: ">=95%" },
    // Unscoped sessions cannot receive repo memory. Surface the share instead
    // of hiding it behind a perfect attribution rate; never fails on its own.
    { name: "session_scope_coverage", status: sessionIds.size === 0 || scopeCoverage < 0.5 ? "warn" : "pass", value: scopeCoverage, target: ">=50%" },
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
    sessions_requiring_repo: scopedSessionIds.size,
    sessions_with_repo: attributedSessionIds.size,
    sessions_unscoped: unscopedSessions,
    unscoped_top_paths: unscopedTopPaths,
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
    candidate_injectable_total: injectableCandidates.length,
    candidate_total: candidates.length,
    active_memories: activeMemories,
    checks,
    overall,
  };
}

export function formatReliabilityReport(report: ReliabilityReport): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const home = process.env.HOME ?? "";
  const displayPath = (path: string) => (home && path.startsWith(home) ? `~${path.slice(home.length)}` : path);
  const lines = [
    "# Recall Reliability",
    "",
    `Window: ${report.window_start} to ${report.window_end}`,
    `Overall: ${report.overall.toUpperCase()}`,
    "",
    `Sessions: ${report.sessions} (${report.sessions_requiring_repo} required repo, ${report.sessions_with_repo} attributed, ${percent(report.repo_attribution_rate)}; ${report.sessions_unscoped} unscoped)`,
    ...(report.unscoped_top_paths.length > 0
      ? [`Unscoped cwd (no git checkout — open the repo itself or set RECALL_REPO_OVERRIDE): ${report.unscoped_top_paths.map((entry) => `${displayPath(entry.path)} (${entry.sessions})`).join(", ")}`]
      : []),
    `Injections: ${report.selected_injections} selected, ${report.emitted_injections} emitted (${percent(report.emission_coverage)})`,
    `Evidence: ${report.observed_uses} observed uses, ${report.resolved_outcomes} resolved outcomes (${percent(report.outcome_coverage)})`,
    `Retrieval: ${report.retrieval_observations} observations, ${report.retrieval_misses} misses`,
    `Memory: ${report.active_memories} active, ${report.candidate_injectable_total} injectable candidates total, ${report.candidate_backlog} max in one repo, ${report.candidate_total} total candidates`,
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

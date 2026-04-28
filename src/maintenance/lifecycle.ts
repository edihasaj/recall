import { eq, lt } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { activityEvents, feedbackEvents, historySnippets, implicitSignals, memories } from "../db/schema.js";
import {
  bootstrapEmbeddings,
  loadEmbeddingConfigFromEnv,
  rebuildEmbeddingIndex,
  verifyEmbeddings,
} from "../embeddings/embeddings.js";
import {
  createHistorySnippet,
  findHistorySnippetByRepoKind,
  findHistorySnippetBySession,
  listHistorySnippets,
  updateHistorySnippet,
} from "../history/snippets.js";
import { bootstrapHistoryEmbeddings, verifyHistoryEmbeddings } from "../history/retrieval.js";
import { pruneMemories } from "../pruning/pruner.js";
import { listActivityEvents } from "../models/activity.js";
import { getMemory, promoteMemory, queryMemories, rejectMemory, statusFromConfidence } from "../models/memory.js";
import { recordAuditWithSnapshot } from "../audit/trail.js";
import { getRepoQualityProfile } from "../repo/quality.js";
import { removeHistoryFtsRow, syncHistoryFtsIndex } from "../vector/sqlite-fts-history.js";
import { removeHistoryVecRow } from "../vector/sqlite-vec-history.js";
import { queueMemoryEmbeddingSync } from "../embeddings/embeddings.js";
import { evaluateScannedMemory } from "../scanner/signal.js";
import {
  DEFAULT_ENQUEUE_CONFIG,
  enqueueMaintenanceTasks,
  type EnqueueConfig,
} from "./tasks.js";

export interface MaintenanceConfig {
  enabled: boolean;
  interval_seconds: number;
  stale_days: number;
  min_health_score: number;
  activity_retention_days: number;
  feedback_retention_days: number;
  signal_retention_days: number;
  history_session_retention_days: number;
  sqlite_analyze_enabled: boolean;
  sqlite_optimize_enabled: boolean;
  sqlite_wal_checkpoint_enabled: boolean;
  sqlite_vacuum_enabled: boolean;
  sqlite_vacuum_min_free_pages: number;
  sqlite_vacuum_min_free_ratio: number;
  llm_tasks_enabled: boolean;
  llm_task_config: EnqueueConfig;
}

export interface MaintenanceResult {
  prune_total: number;
  stale_rejected: number;
  rejected_pruned: number;
  transient_pruned: number;
  unhealthy_demoted: number;
  scanned_memories_normalized: number;
  scanned_memories_demoted: number;
  scanned_memories_rejected: number;
  activity_pruned: number;
  feedback_pruned: number;
  signals_pruned: number;
  embeddings_refreshed: number;
  vector_rows_rebuilt: number;
  lexical_rows_rebuilt: number;
  embedding_stale: number;
  vector_drift: number;
  lexical_drift: number;
  history_snippets_created: number;
  history_summaries_created: number;
  history_session_deleted: number;
  history_embeddings_refreshed: number;
  history_vector_drift: number;
  history_lexical_drift: number;
  candidates_promoted: number;
  sqlite_analyze_ran: boolean;
  sqlite_optimize_ran: boolean;
  sqlite_checkpoint_ran: boolean;
  sqlite_vacuum_ran: boolean;
  sqlite_page_count: number;
  sqlite_freelist_count: number;
  maintenance_tasks_enqueued: number;
  maintenance_leases_swept: number;
  maintenance_tasks_dropped: number;
  maintenance_tasks_expired: number;
}

const DAY_MS = 86_400_000;

export function loadMaintenanceConfigFromEnv(): MaintenanceConfig {
  return {
    enabled: process.env.RECALL_MAINTENANCE_ENABLED !== "false",
    interval_seconds: parseInt(process.env.RECALL_MAINTENANCE_INTERVAL_SECONDS ?? "300", 10),
    stale_days: parseInt(process.env.RECALL_MAINTENANCE_STALE_DAYS ?? "90", 10),
    min_health_score: parseFloat(process.env.RECALL_MAINTENANCE_MIN_HEALTH_SCORE ?? "0.2"),
    activity_retention_days: parseInt(process.env.RECALL_ACTIVITY_RETENTION_DAYS ?? "90", 10),
    feedback_retention_days: parseInt(process.env.RECALL_FEEDBACK_RETENTION_DAYS ?? "180", 10),
    signal_retention_days: parseInt(process.env.RECALL_SIGNAL_RETENTION_DAYS ?? "180", 10),
    history_session_retention_days: parseInt(process.env.RECALL_HISTORY_SESSION_RETENTION_DAYS ?? "30", 10),
    sqlite_analyze_enabled: process.env.RECALL_SQLITE_ANALYZE_ENABLED !== "false",
    sqlite_optimize_enabled: process.env.RECALL_SQLITE_OPTIMIZE_ENABLED !== "false",
    sqlite_wal_checkpoint_enabled: process.env.RECALL_SQLITE_CHECKPOINT_ENABLED !== "false",
    sqlite_vacuum_enabled: process.env.RECALL_SQLITE_VACUUM_ENABLED === "true",
    sqlite_vacuum_min_free_pages: parseInt(process.env.RECALL_SQLITE_VACUUM_MIN_FREE_PAGES ?? "100", 10),
    sqlite_vacuum_min_free_ratio: parseFloat(process.env.RECALL_SQLITE_VACUUM_MIN_FREE_RATIO ?? "0.1"),
    llm_tasks_enabled: process.env.RECALL_MAINTENANCE_LLM_DISABLED !== "true",
    llm_task_config: {
      max_pending: parseInt(process.env.RECALL_MAINTENANCE_MAX_PENDING ?? String(DEFAULT_ENQUEUE_CONFIG.max_pending), 10),
      max_per_kind: parseInt(process.env.RECALL_MAINTENANCE_MAX_PER_KIND ?? String(DEFAULT_ENQUEUE_CONFIG.max_per_kind), 10),
      refine_min_repetition: parseInt(process.env.RECALL_MAINTENANCE_REFINE_MIN_REPETITION ?? String(DEFAULT_ENQUEUE_CONFIG.refine_min_repetition), 10),
      summary_max_age_days: parseInt(process.env.RECALL_MAINTENANCE_SUMMARY_MAX_AGE_DAYS ?? String(DEFAULT_ENQUEUE_CONFIG.summary_max_age_days), 10),
      merge_similarity_threshold: parseFloat(process.env.RECALL_MAINTENANCE_MERGE_SIMILARITY_THRESHOLD ?? String(DEFAULT_ENQUEUE_CONFIG.merge_similarity_threshold)),
      session_min_activity_events: parseInt(process.env.RECALL_MAINTENANCE_SESSION_MIN_EVENTS ?? String(DEFAULT_ENQUEUE_CONFIG.session_min_activity_events), 10),
      repo_synthesis_min_memories: parseInt(process.env.RECALL_MAINTENANCE_REPO_SYNTHESIS_MIN_MEMORIES ?? String(DEFAULT_ENQUEUE_CONFIG.repo_synthesis_min_memories), 10),
      repo_synthesis_refresh_days: parseInt(process.env.RECALL_MAINTENANCE_REPO_SYNTHESIS_REFRESH_DAYS ?? String(DEFAULT_ENQUEUE_CONFIG.repo_synthesis_refresh_days), 10),
    },
  };
}

export async function runMaintenanceCycle(
  db: RecallDb,
  config: MaintenanceConfig = loadMaintenanceConfigFromEnv(),
): Promise<MaintenanceResult> {
  const prune = pruneMemories(db, {
    stale_days: config.stale_days,
    min_health_score: config.min_health_score,
  });
  const scannedMemoryCleanup = reconcileScannedMemories(db);
  const candidates_promoted = promoteRepetitionCandidates(db);

  const activity_pruned = pruneOldActivityEvents(db, config.activity_retention_days);
  const feedback_pruned = pruneOldFeedbackEvents(db, config.feedback_retention_days);
  const signals_pruned = pruneOldImplicitSignals(db, config.signal_retention_days);
  const sqliteMaintenance = runSqliteMaintenance(db, config);

  let embeddings_refreshed = 0;
  let vector_rows_rebuilt = 0;
  let lexical_rows_rebuilt = 0;
  let embedding_stale = 0;
  let vector_drift = 0;
  let lexical_drift = 0;
  const history_snippets_created = rollupSessionHistory(db);
  const history_summaries_created = summarizeHistorySnippets(db);
  const history_session_deleted = cleanupSessionHistory(db, config.history_session_retention_days);
  let history_embeddings_refreshed = 0;
  let history_vector_drift = 0;
  let history_lexical_drift = 0;

  const embeddingConfig = loadEmbeddingConfigFromEnv();
  if (embeddingConfig) {
    const verify = verifyEmbeddings(db, embeddingConfig);
    embedding_stale = verify.stale;
    vector_drift = verify.index_drift;
    lexical_drift = verify.lexical_drift;

    if (embedding_stale > 0) {
      embeddings_refreshed = await bootstrapEmbeddings(db, embeddingConfig);
    }

    if (vector_drift !== 0 || lexical_drift !== 0) {
      const rebuilt = rebuildEmbeddingIndex(db, embeddingConfig);
      vector_rows_rebuilt = rebuilt.vector_rows;
      lexical_rows_rebuilt = rebuilt.lexical_rows;
    }

    const historyVerify = verifyHistoryEmbeddings(db, embeddingConfig);
    history_vector_drift = historyVerify.index_drift;
    history_lexical_drift = historyVerify.lexical_drift;
    if (
      historyVerify.stale > 0 ||
      history_snippets_created > 0 ||
      history_summaries_created > 0 ||
      history_session_deleted > 0
    ) {
      history_embeddings_refreshed = await bootstrapHistoryEmbeddings(db, embeddingConfig);
    }
  }

  const tasks = config.llm_tasks_enabled
    ? await enqueueMaintenanceTasks(db, config.llm_task_config)
    : { tasks_enqueued: 0, per_kind: {}, expired_leases_swept: 0, dropped_over_cap: 0, expired_pending_tasks: 0 };

  return {
    prune_total: prune.total,
    stale_rejected: prune.stale_rejected.length,
    rejected_pruned: prune.rejected_pruned.length,
    transient_pruned: prune.transient_pruned.length,
    unhealthy_demoted: prune.unhealthy_demoted.length,
    scanned_memories_normalized: scannedMemoryCleanup.normalized,
    scanned_memories_demoted: scannedMemoryCleanup.demoted,
    scanned_memories_rejected: scannedMemoryCleanup.rejected,
    activity_pruned,
    feedback_pruned,
    signals_pruned,
    embeddings_refreshed,
    vector_rows_rebuilt,
    lexical_rows_rebuilt,
    embedding_stale,
    vector_drift,
    lexical_drift,
    history_snippets_created,
    history_summaries_created,
    history_session_deleted,
    history_embeddings_refreshed,
    history_vector_drift,
    history_lexical_drift,
    candidates_promoted,
    sqlite_analyze_ran: sqliteMaintenance.analyze_ran,
    sqlite_optimize_ran: sqliteMaintenance.optimize_ran,
    sqlite_checkpoint_ran: sqliteMaintenance.checkpoint_ran,
    sqlite_vacuum_ran: sqliteMaintenance.vacuum_ran,
    sqlite_page_count: sqliteMaintenance.page_count,
    sqlite_freelist_count: sqliteMaintenance.freelist_count,
    maintenance_tasks_enqueued: tasks.tasks_enqueued,
    maintenance_leases_swept: tasks.expired_leases_swept,
    maintenance_tasks_dropped: tasks.dropped_over_cap,
    maintenance_tasks_expired: tasks.expired_pending_tasks,
  };
}

export function promoteRepetitionCandidates(db: RecallDb): number {
  const candidates = queryMemories(db, { status: "candidate" });
  let promoted = 0;

  for (const candidate of candidates) {
    if (!candidate.repo) continue;
    const profile = getRepoQualityProfile(db, candidate.repo);
    if (candidate.repetition_count < profile.repeat_sessions_required) continue;

    const before = getMemory(db, candidate.id);
    if (!before || before.status !== "candidate") continue;
    const ok = promoteMemory(db, candidate.id, "repeat_correction");
    if (!ok) continue;
    const after = getMemory(db, candidate.id);
    recordAuditWithSnapshot(
      db,
      candidate.id,
      "promoted",
      "system",
      `repetition:${candidate.repetition_count}`,
      before,
      after ?? null,
    );
    promoted += 1;
  }

  return promoted;
}

export function reconcileScannedMemories(db: RecallDb): {
  normalized: number;
  demoted: number;
  rejected: number;
} {
  const scanned = queryMemories(db, {})
    .filter((memory) =>
      memory.status !== "rejected" &&
      (memory.source === "repo_scan" || memory.source === "config_parse")
    );

  let normalized = 0;
  let demoted = 0;
  let rejected = 0;

  for (const memory of scanned) {
    const evaluated = evaluateScannedMemory({
      text: memory.text,
      type: memory.type,
      source: memory.source,
      confidence: memory.confidence,
    });

    if (evaluated.action === "reject") {
      if (memory.status !== "rejected") {
        rejectMemory(db, memory.id);
        rejected += 1;
      }
      continue;
    }

    const nextStatus = statusFromConfidence(evaluated.confidence);
    const updates: Partial<typeof memories.$inferInsert> = {};

    if (memory.text !== evaluated.text) {
      updates.text = evaluated.text;
      normalized += 1;
    }
    if (memory.confidence !== evaluated.confidence) {
      updates.confidence = evaluated.confidence;
    }
    if (memory.status !== nextStatus) {
      updates.status = nextStatus;
      if (memory.status === "active" && nextStatus === "candidate") {
        demoted += 1;
      }
    }

    if (Object.keys(updates).length === 0) continue;

    updates.updated_at = new Date().toISOString();
    db.update(memories)
      .set(updates)
      .where(eq(memories.id, memory.id))
      .run();
    queueMemoryEmbeddingSync(db, memory.id);
  }

  return { normalized, demoted, rejected };
}

export function runSqliteMaintenance(
  db: RecallDb,
  config: Pick<
    MaintenanceConfig,
    | "sqlite_analyze_enabled"
    | "sqlite_optimize_enabled"
    | "sqlite_wal_checkpoint_enabled"
    | "sqlite_vacuum_enabled"
    | "sqlite_vacuum_min_free_pages"
    | "sqlite_vacuum_min_free_ratio"
  >,
) {
  const sqlite = db.$client;

  const pageCount = Number((sqlite.pragma("page_count", { simple: true }) as number | bigint) ?? 0);
  const freelistCount = Number((sqlite.pragma("freelist_count", { simple: true }) as number | bigint) ?? 0);
  const freeRatio = pageCount > 0 ? freelistCount / pageCount : 0;

  let analyzeRan = false;
  let optimizeRan = false;
  let checkpointRan = false;
  let vacuumRan = false;

  if (config.sqlite_analyze_enabled) {
    sqlite.exec("ANALYZE;");
    analyzeRan = true;
  }

  if (config.sqlite_wal_checkpoint_enabled) {
    sqlite.pragma("wal_checkpoint(PASSIVE)");
    checkpointRan = true;
  }

  if (config.sqlite_optimize_enabled) {
    sqlite.pragma("optimize");
    optimizeRan = true;
  }

  if (
    config.sqlite_vacuum_enabled &&
    freelistCount >= config.sqlite_vacuum_min_free_pages &&
    freeRatio >= config.sqlite_vacuum_min_free_ratio
  ) {
    sqlite.exec("VACUUM;");
    vacuumRan = true;
  }

  return {
    analyze_ran: analyzeRan,
    optimize_ran: optimizeRan,
    checkpoint_ran: checkpointRan,
    vacuum_ran: vacuumRan,
    page_count: pageCount,
    freelist_count: freelistCount,
  };
}

export function pruneOldActivityEvents(
  db: RecallDb,
  retentionDays: number,
): number {
  const cutoff = new Date(Date.now() - (retentionDays * DAY_MS)).toISOString();
  return db.delete(activityEvents)
    .where(lt(activityEvents.created_at, cutoff))
    .run().changes;
}

export function pruneOldFeedbackEvents(
  db: RecallDb,
  retentionDays: number,
): number {
  const cutoff = new Date(Date.now() - (retentionDays * DAY_MS)).toISOString();
  return db.delete(feedbackEvents)
    .where(lt(feedbackEvents.timestamp, cutoff))
    .run().changes;
}

export function pruneOldImplicitSignals(
  db: RecallDb,
  retentionDays: number,
): number {
  const cutoff = new Date(Date.now() - (retentionDays * DAY_MS)).toISOString();
  return db.delete(implicitSignals)
    .where(lt(implicitSignals.timestamp, cutoff))
    .run().changes;
}

export function rollupSessionHistory(db: RecallDb): number {
  const sessionEnds = listActivityEvents(db, { event_type: "session_end", limit: 500 });
  let createdOrUpdated = 0;

  for (const end of sessionEnds) {
    if (!end.session_id) continue;
    const existing = findHistorySnippetBySession(db, end.session_id, "session_summary");

    const events = listActivityEvents(db, { session_id: end.session_id })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (events.length === 0) continue;

    const repo = end.repo ?? events.find((event) => event.repo)?.repo ?? null;
    const summary = summarizeSessionEvents(events);
    const sourceActivityIds = events.map((event) => event.id);

    if (existing) {
      if (existing.text !== summary) {
        updateHistorySnippet(db, existing.id, {
          text: summary,
          source_activity_ids: sourceActivityIds,
        });
        syncHistoryFtsIndex(db, existing.id);
        createdOrUpdated++;
      }
      continue;
    }

    const id = createHistorySnippet(db, {
      repo,
      session_id: end.session_id,
      kind: "session_summary",
      text: summary,
      source_activity_ids: sourceActivityIds,
    });
    syncHistoryFtsIndex(db, id);
    createdOrUpdated++;
  }

  return createdOrUpdated;
}

export function summarizeHistorySnippets(db: RecallDb): number {
  const sessionSnippets = listHistorySnippets(db, {
    kind: "session_summary",
    limit: 1000,
  });

  const byRepo = new Map<string, typeof sessionSnippets>();
  for (const snippet of sessionSnippets) {
    if (!snippet.repo) continue;
    const bucket = byRepo.get(snippet.repo) ?? [];
    bucket.push(snippet);
    byRepo.set(snippet.repo, bucket);
  }

  let createdOrUpdated = 0;
  for (const [repo, snippets] of byRepo.entries()) {
    const aggregated = aggregateRepoHistory(repo, snippets);
    for (const item of aggregated) {
      if (!item.text) continue;

      const existing = findHistorySnippetByRepoKind(db, repo, item.kind);
      if (existing) {
        if (existing.text !== item.text) {
          updateHistorySnippet(db, existing.id, {
            text: item.text,
            source_activity_ids: item.source_activity_ids,
          });
          syncHistoryFtsIndex(db, existing.id);
          createdOrUpdated++;
        }
        continue;
      }

      const id = createHistorySnippet(db, {
        repo,
        kind: item.kind,
        text: item.text,
        source_activity_ids: item.source_activity_ids,
      });
      syncHistoryFtsIndex(db, id);
      createdOrUpdated++;
    }
  }

  return createdOrUpdated;
}

export function cleanupSessionHistory(
  db: RecallDb,
  retentionDays: number,
): number {
  const cutoff = new Date(Date.now() - (retentionDays * DAY_MS)).toISOString();
  const sessionSnippets = listHistorySnippets(db, {
    kind: "session_summary",
    limit: 1000,
  });

  let deleted = 0;
  for (const snippet of sessionSnippets) {
    if (!snippet.repo) continue;
    if (snippet.created_at >= cutoff) continue;

    const hasRepoSummary =
      findHistorySnippetByRepoKind(db, snippet.repo, "correction_summary") ||
      findHistorySnippetByRepoKind(db, snippet.repo, "review_summary") ||
      findHistorySnippetByRepoKind(db, snippet.repo, "compile_summary");
    if (!hasRepoSummary) continue;

    removeHistoryFtsRow(db, snippet.id);
    removeHistoryVecRow(db, snippet.id);
    db.delete(historySnippets)
      .where(eq(historySnippets.id, snippet.id))
      .run();
    deleted++;
  }

  return deleted;
}

function summarizeSessionEvents(
  events: Array<ReturnType<typeof listActivityEvents>[number]>,
) {
  const repo = events.find((event) => event.repo)?.repo ?? "unknown";
  const eventTypes = [...new Set(events.map((event) => event.event_type))];
  const corrections = events
    .filter((event) => event.event_type === "correction")
    .map((event) => String(event.request.text ?? ""))
    .filter(Boolean);
  const reviews = events
    .filter((event) => event.event_type === "review")
    .map((event) => String(event.request.feedback ?? ""))
    .filter(Boolean);
  const compileEvents = events.filter((event) => event.event_type === "compile");

  const lines = [
    `Repo: ${repo}`,
    `Event types: ${eventTypes.join(", ")}`,
  ];

  if (compileEvents.length > 0) {
    const latestCompile = compileEvents.at(-1);
    const included = Array.isArray(latestCompile?.result.included)
      ? latestCompile.result.included.length
      : 0;
    lines.push(`Latest compile included ${included} memories.`);
  }

  if (corrections.length > 0) {
    lines.push(`Corrections: ${corrections.slice(0, 3).join(" | ")}`);
  }

  if (reviews.length > 0) {
    lines.push(`Reviews: ${reviews.slice(0, 3).join(" | ")}`);
  }

  return lines.join("\n");
}

function aggregateRepoHistory(
  repo: string,
  snippets: ReturnType<typeof listHistorySnippets>,
): Array<{
  kind: "correction_summary" | "review_summary" | "compile_summary";
  text: string;
  source_activity_ids: string[];
}> {
  const corrections = new Map<string, number>();
  const reviews = new Map<string, number>();
  let compileObservations = 0;
  let compileIncludedTotal = 0;
  const sourceActivityIds = new Set<string>();

  for (const snippet of snippets) {
    for (const id of snippet.source_activity_ids) {
      sourceActivityIds.add(id);
    }

    const lines = snippet.text.split("\n");
    const correctionsLine = lines.find((line) => line.startsWith("Corrections: "));
    if (correctionsLine) {
      for (const item of correctionsLine.replace("Corrections: ", "").split(" | ").filter(Boolean)) {
        corrections.set(item, (corrections.get(item) ?? 0) + 1);
      }
    }

    const reviewsLine = lines.find((line) => line.startsWith("Reviews: "));
    if (reviewsLine) {
      for (const item of reviewsLine.replace("Reviews: ", "").split(" | ").filter(Boolean)) {
        reviews.set(item, (reviews.get(item) ?? 0) + 1);
      }
    }

    const compileLine = lines.find((line) => line.startsWith("Latest compile included "));
    if (compileLine) {
      compileObservations++;
      const match = compileLine.match(/included (\d+) memories/);
      if (match) compileIncludedTotal += parseInt(match[1], 10);
    }
  }

  return [
    {
      kind: "correction_summary",
      text: renderSummary(repo, "Frequent corrections", corrections),
      source_activity_ids: [...sourceActivityIds],
    },
    {
      kind: "review_summary",
      text: renderSummary(repo, "Frequent review guidance", reviews),
      source_activity_ids: [...sourceActivityIds],
    },
    {
      kind: "compile_summary",
      text: compileObservations > 0
        ? [
            `Repo: ${repo}`,
            `Compile observations: ${compileObservations}`,
            `Average included memories: ${(compileIncludedTotal / compileObservations).toFixed(1)}`,
          ].join("\n")
        : "",
      source_activity_ids: [...sourceActivityIds],
    },
  ];
}

function renderSummary(
  repo: string,
  heading: string,
  counts: Map<string, number>,
) {
  if (counts.size === 0) return "";
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([text, count]) => `- (${count}) ${text}`);

  return [
    `Repo: ${repo}`,
    `${heading}:`,
    ...top,
  ].join("\n");
}

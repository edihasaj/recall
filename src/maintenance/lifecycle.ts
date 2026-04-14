import { lt } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { activityEvents, feedbackEvents, implicitSignals } from "../db/schema.js";
import {
  bootstrapEmbeddings,
  loadEmbeddingConfigFromEnv,
  rebuildEmbeddingIndex,
  verifyEmbeddings,
} from "../embeddings/embeddings.js";
import { createHistorySnippet, findHistorySnippetBySession, listHistorySnippets, updateHistorySnippet } from "../history/snippets.js";
import { bootstrapHistoryEmbeddings, verifyHistoryEmbeddings } from "../history/retrieval.js";
import { pruneMemories } from "../pruning/pruner.js";
import { listActivityEvents } from "../models/activity.js";
import { syncHistoryFtsIndex } from "../vector/sqlite-fts-history.js";

export interface MaintenanceConfig {
  enabled: boolean;
  interval_seconds: number;
  stale_days: number;
  min_health_score: number;
  activity_retention_days: number;
  feedback_retention_days: number;
  signal_retention_days: number;
}

export interface MaintenanceResult {
  prune_total: number;
  stale_archived: number;
  rejected_pruned: number;
  transient_pruned: number;
  unhealthy_demoted: number;
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
  history_embeddings_refreshed: number;
  history_vector_drift: number;
  history_lexical_drift: number;
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

  const activity_pruned = pruneOldActivityEvents(db, config.activity_retention_days);
  const feedback_pruned = pruneOldFeedbackEvents(db, config.feedback_retention_days);
  const signals_pruned = pruneOldImplicitSignals(db, config.signal_retention_days);

  let embeddings_refreshed = 0;
  let vector_rows_rebuilt = 0;
  let lexical_rows_rebuilt = 0;
  let embedding_stale = 0;
  let vector_drift = 0;
  let lexical_drift = 0;
  const history_snippets_created = rollupSessionHistory(db);
  let history_embeddings_refreshed = 0;
  let history_vector_drift = 0;
  let history_lexical_drift = 0;

  const embeddingConfig = loadEmbeddingConfigFromEnv();
  if (embeddingConfig?.enabled) {
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
    if (historyVerify.stale > 0 || history_snippets_created > 0) {
      history_embeddings_refreshed = await bootstrapHistoryEmbeddings(db, embeddingConfig);
    }
  }

  return {
    prune_total: prune.total,
    stale_archived: prune.stale_archived.length,
    rejected_pruned: prune.rejected_pruned.length,
    transient_pruned: prune.transient_pruned.length,
    unhealthy_demoted: prune.unhealthy_demoted.length,
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
    history_embeddings_refreshed,
    history_vector_drift,
    history_lexical_drift,
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

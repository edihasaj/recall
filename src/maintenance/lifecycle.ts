import { lt } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { activityEvents, feedbackEvents, implicitSignals } from "../db/schema.js";
import {
  bootstrapEmbeddings,
  loadEmbeddingConfigFromEnv,
  rebuildEmbeddingIndex,
  verifyEmbeddings,
} from "../embeddings/embeddings.js";
import { pruneMemories } from "../pruning/pruner.js";

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

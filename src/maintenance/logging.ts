import type { MaintenanceResult } from "./lifecycle.js";

export function maintenanceChangeCount(result: MaintenanceResult): number {
  return (
    result.prune_total +
    result.scanned_memories_normalized +
    result.scanned_memories_demoted +
    result.scanned_memories_rejected +
    result.activity_pruned +
    result.feedback_pruned +
    result.signals_pruned +
    result.embeddings_refreshed +
    result.vector_rows_rebuilt +
    result.lexical_rows_rebuilt +
    result.history_snippets_created +
    result.history_embeddings_refreshed +
    result.maintenance_tasks_enqueued +
    result.maintenance_leases_swept +
    result.maintenance_tasks_dropped +
    result.maintenance_tasks_expired +
    result.maintenance_tasks_invalid
  );
}

export function shouldLogMaintenance(result: MaintenanceResult): boolean {
  return (
    maintenanceChangeCount(result) > 0 ||
    result.vector_drift !== 0 ||
    result.lexical_drift !== 0 ||
    result.embedding_stale > 0 ||
    result.history_vector_drift !== 0 ||
    result.history_lexical_drift !== 0
  );
}

export function formatMaintenanceSummary(result: MaintenanceResult): string {
  return (
    `[recall] maintenance ` +
    `prune=${result.prune_total} ` +
    `scanned(normalized=${result.scanned_memories_normalized},demoted=${result.scanned_memories_demoted},rejected=${result.scanned_memories_rejected}) ` +
    `activity=${result.activity_pruned} ` +
    `feedback=${result.feedback_pruned} ` +
    `signals=${result.signals_pruned} ` +
    `refreshed=${result.embeddings_refreshed} ` +
    `rebuilt(vec=${result.vector_rows_rebuilt},fts=${result.lexical_rows_rebuilt}) ` +
    `drift(vec=${result.vector_drift},fts=${result.lexical_drift}) ` +
    `stale=${result.embedding_stale} ` +
    `history(created=${result.history_snippets_created},refreshed=${result.history_embeddings_refreshed},drift_vec=${result.history_vector_drift},drift_fts=${result.history_lexical_drift}) ` +
    `tasks(enqueued=${result.maintenance_tasks_enqueued},swept=${result.maintenance_leases_swept},dropped=${result.maintenance_tasks_dropped},expired=${result.maintenance_tasks_expired},invalid=${result.maintenance_tasks_invalid})`
  );
}

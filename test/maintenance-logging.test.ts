import { describe, expect, it } from "vitest";
import type { MaintenanceResult } from "../src/maintenance/lifecycle.js";
import {
  formatMaintenanceSummary,
  maintenanceChangeCount,
  shouldLogMaintenance,
} from "../src/maintenance/logging.js";

function makeResult(overrides: Partial<MaintenanceResult> = {}): MaintenanceResult {
  return {
    prune_total: 0,
    stale_rejected: 0,
    rejected_pruned: 0,
    transient_pruned: 0,
    unhealthy_demoted: 0,
    scanned_memories_normalized: 0,
    scanned_memories_demoted: 0,
    scanned_memories_rejected: 0,
    activity_pruned: 0,
    feedback_pruned: 0,
    signals_pruned: 0,
    embeddings_refreshed: 0,
    vector_rows_rebuilt: 0,
    lexical_rows_rebuilt: 0,
    embedding_stale: 0,
    vector_drift: 0,
    lexical_drift: 0,
    history_snippets_created: 0,
    history_summaries_created: 0,
    history_session_deleted: 0,
    history_embeddings_refreshed: 0,
    history_vector_drift: 0,
    history_lexical_drift: 0,
    candidates_promoted: 0,
    sqlite_analyze_ran: true,
    sqlite_optimize_ran: true,
    sqlite_checkpoint_ran: true,
    sqlite_vacuum_ran: false,
    sqlite_page_count: 0,
    sqlite_freelist_count: 0,
    maintenance_tasks_enqueued: 0,
    maintenance_leases_swept: 0,
    maintenance_tasks_dropped: 0,
    ...overrides,
  };
}

describe("maintenance logging", () => {
  it("counts scan-cleanup mutations as maintenance changes", () => {
    const result = makeResult({
      scanned_memories_normalized: 8,
      scanned_memories_demoted: 10,
      scanned_memories_rejected: 11,
    });

    expect(maintenanceChangeCount(result)).toBe(29);
    expect(shouldLogMaintenance(result)).toBe(true);
  });

  it("formats scan-cleanup counters in the summary line", () => {
    const result = makeResult({
      prune_total: 1,
      scanned_memories_normalized: 8,
      scanned_memories_demoted: 10,
      scanned_memories_rejected: 11,
      vector_drift: 2,
      lexical_drift: 3,
      embedding_stale: 4,
      history_snippets_created: 5,
      history_embeddings_refreshed: 6,
      history_vector_drift: 7,
      history_lexical_drift: 8,
    });

    expect(formatMaintenanceSummary(result)).toContain(
      "scanned(normalized=8,demoted=10,rejected=11)",
    );
    expect(formatMaintenanceSummary(result)).toContain("prune=1");
    expect(formatMaintenanceSummary(result)).toContain("drift(vec=2,fts=3)");
    expect(formatMaintenanceSummary(result)).toContain(
      "history(created=5,refreshed=6,drift_vec=7,drift_fts=8)",
    );
  });
});

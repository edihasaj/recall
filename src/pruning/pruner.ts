/**
 * Auto-pruning and stale memory handling.
 *
 * - Archive memories not injected/validated in N days (stop auto-injecting
 *   them; never reject them — a durable rule does not become false because
 *   its repo went untouched for a quarter)
 * - Prune rejected memories older than threshold
 * - Compact transient memories
 * - Configurable retention policies
 */

import { eq, or } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import {
  approvalRequests,
  contradictions,
  feedbackEvents,
  implicitSignals,
  memories,
  memoryEntities,
} from "../db/schema.js";
import { queueMemoryEmbeddingSync } from "../embeddings/embeddings.js";
import { queryMemories } from "../models/memory.js";
import { computeHealthScore } from "../health/scoring.js";
import { recordAudit } from "../audit/trail.js";
import type { PruneConfig } from "../types.js";

const DEFAULT_CONFIG: PruneConfig = {
  stale_days: 90,
  rejected_retention_days: 30,
  transient_retention_days: 7,
  min_health_score: 0.2,
  dry_run: false,
};

export interface PruneResult {
  /** Stale memories archived out of auto-injection (still active + retrievable). */
  stale_archived: string[];
  rejected_pruned: string[];
  transient_pruned: string[];
  unhealthy_demoted: string[];
  total: number;
}

export function pruneMemories(
  db: RecallDb,
  config: Partial<PruneConfig> = {},
): PruneResult {
  // Spread-merge keeps `undefined` from the caller's partial, which then
  // overrides the default and NaN-poisons the retention math. Strip explicit
  // undefined before merging so partial configs fall through to defaults.
  const definedConfig = Object.fromEntries(
    Object.entries(config).filter(([, v]) => v !== undefined),
  ) as Partial<PruneConfig>;
  const cfg = { ...DEFAULT_CONFIG, ...definedConfig };
  const now = Date.now();
  const dayMs = 86_400_000;

  const result: PruneResult = {
    stale_archived: [],
    rejected_pruned: [],
    transient_pruned: [],
    unhealthy_demoted: [],
    total: 0,
  };

  // 1. Archive stale active/candidate memories.
  //
  // Staleness means "not used lately", not "wrong". Rejecting on disuse threw
  // away correct, user-taught rules — a security rule for a repo untouched
  // for a quarter is exactly the rule you most need when you return to it.
  // Worse, rejected memories double as "never capture this again" exemplars
  // (see isSimilarToRejectedFragment), so pruning a good rule also blocked
  // the user from re-teaching it, and 30-day rejected retention then deleted
  // it outright.
  //
  // Archiving instead clears `auto_inject`: the memory stops consuming
  // context budget on every prompt but stays active, searchable, and
  // instantly reusable. Any later injection or validation restores it.
  const staleCutoff = new Date(now - cfg.stale_days * dayMs).toISOString();
  const staleCandidates = queryMemories(db, {
    repo: cfg.repo,
    limit: undefined,
  }).filter((mem) => mem.status !== "rejected" && mem.status !== "transient");

  for (const mem of staleCandidates) {
    const lastActivity =
      mem.last_validated_at ?? mem.last_injected_at ?? mem.updated_at;

    if (lastActivity < staleCutoff && mem.auto_inject) {
      if (!cfg.dry_run) {
        db.update(memories)
          .set({ auto_inject: false, updated_at: new Date().toISOString() })
          .where(eq(memories.id, mem.id))
          .run();
        recordAudit(
          db,
          mem.id,
          "demoted",
          "auto-pruner",
          `Archived from auto-injection: no activity since ${lastActivity}`,
        );
      }
      result.stale_archived.push(mem.id);
    }
  }

  // 2. Delete rejected memories past retention
  const rejectedCutoff = new Date(
    now - cfg.rejected_retention_days * dayMs,
  ).toISOString();
  const rejectedMemories = queryMemories(db, {
    repo: cfg.repo,
    status: "rejected",
  });

  for (const mem of rejectedMemories) {
    if (mem.updated_at < rejectedCutoff) {
      if (!cfg.dry_run) {
        deleteMemoryAndDependents(db, mem.id);
        queueMemoryEmbeddingSync(db, mem.id);
        recordAudit(db, mem.id, "pruned", "auto-pruner", `Rejected memory past ${cfg.rejected_retention_days}d retention`);
      }
      result.rejected_pruned.push(mem.id);
    }
  }

  // 3. Compact transient memories
  const transientCutoff = new Date(
    now - cfg.transient_retention_days * dayMs,
  ).toISOString();
  const transientMemories = queryMemories(db, {
    repo: cfg.repo,
    status: "transient",
  });

  for (const mem of transientMemories) {
    if (mem.updated_at < transientCutoff) {
      if (!cfg.dry_run) {
        deleteMemoryAndDependents(db, mem.id);
        queueMemoryEmbeddingSync(db, mem.id);
        recordAudit(db, mem.id, "pruned", "auto-pruner", `Transient memory past ${cfg.transient_retention_days}d retention`);
      }
      result.transient_pruned.push(mem.id);
    }
  }

  // 4. Demote unhealthy active memories
  const activeMemories = queryMemories(db, {
    repo: cfg.repo,
    status: "active",
  });
  for (const mem of activeMemories) {
    const health = computeHealthScore(db, mem.id);
    if (health && health.score < cfg.min_health_score) {
      if (!cfg.dry_run) {
        db.update(memories)
          .set({ status: "candidate", updated_at: new Date().toISOString() })
          .where(eq(memories.id, mem.id))
          .run();
        queueMemoryEmbeddingSync(db, mem.id);
        recordAudit(
          db,
          mem.id,
          "demoted",
          "auto-pruner",
          `Health score ${health.score.toFixed(2)} below threshold ${cfg.min_health_score}`,
        );
      }
      result.unhealthy_demoted.push(mem.id);
    }
  }

  result.total =
    result.stale_archived.length +
    result.rejected_pruned.length +
    result.transient_pruned.length +
    result.unhealthy_demoted.length;

  return result;
}

/** Remove rows whose historical schemas lack ON DELETE actions before the parent. */
function deleteMemoryAndDependents(db: RecallDb, memoryId: string): void {
  db.transaction((tx) => {
    tx.delete(feedbackEvents).where(eq(feedbackEvents.memory_id, memoryId)).run();
    tx.delete(approvalRequests).where(eq(approvalRequests.memory_id, memoryId)).run();
    tx.delete(contradictions)
      .where(or(
        eq(contradictions.memory_a_id, memoryId),
        eq(contradictions.memory_b_id, memoryId),
      ))
      .run();
    tx.delete(implicitSignals).where(eq(implicitSignals.memory_id, memoryId)).run();
    tx.delete(memoryEntities).where(eq(memoryEntities.memory_id, memoryId)).run();
    tx.delete(memories).where(eq(memories.id, memoryId)).run();
  });
}

// --- Format prune report ---

export function formatPruneReport(result: PruneResult, dryRun: boolean): string {
  const prefix = dryRun ? "[DRY RUN] " : "";
  const lines = [
    `${prefix}Prune Report`,
    ``,
    `Stale archived:    ${result.stale_archived.length}`,
    `Rejected pruned:   ${result.rejected_pruned.length}`,
    `Transient pruned:  ${result.transient_pruned.length}`,
    `Unhealthy demoted: ${result.unhealthy_demoted.length}`,
    `Total affected:    ${result.total}`,
  ];

  if (result.stale_archived.length > 0) {
    lines.push("", "Stale Archived (no longer auto-injected):");
    for (const id of result.stale_archived.slice(0, 10)) {
      lines.push(`  ${id.slice(0, 8)}`);
    }
  }

  if (result.unhealthy_demoted.length > 0) {
    lines.push("", "Unhealthy:");
    for (const id of result.unhealthy_demoted.slice(0, 10)) {
      lines.push(`  ${id.slice(0, 8)}`);
    }
  }

  return lines.join("\n");
}

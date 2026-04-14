/**
 * Auto-pruning and stale memory handling.
 *
 * - Archive memories not injected/validated in N days
 * - Prune rejected memories older than threshold
 * - Compact transient memories
 * - Configurable retention policies
 */

import { eq, and, lt, sql } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { memories } from "../db/schema.js";
import { queueMemoryEmbeddingSync } from "../embeddings/embeddings.js";
import { queryMemories, getMemory, rejectMemory } from "../models/memory.js";
import { computeHealthScore } from "../health/scoring.js";
import { recordAudit } from "../audit/trail.js";
import type { PruneConfig, MemoryItem } from "../types.js";

const DEFAULT_CONFIG: PruneConfig = {
  stale_days: 90,
  rejected_retention_days: 30,
  transient_retention_days: 7,
  min_health_score: 0.2,
  dry_run: false,
};

export interface PruneResult {
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
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = Date.now();
  const dayMs = 86_400_000;

  const result: PruneResult = {
    stale_archived: [],
    rejected_pruned: [],
    transient_pruned: [],
    unhealthy_demoted: [],
    total: 0,
  };

  // 1. Archive stale active/candidate memories
  const staleCutoff = new Date(now - cfg.stale_days * dayMs).toISOString();
  const allMemories = db.select().from(memories).all();

  for (const mem of allMemories) {
    if (mem.status === "rejected" || mem.status === "transient") continue;

    const lastActivity =
      mem.last_validated_at ?? mem.last_injected_at ?? mem.updated_at;

    if (lastActivity < staleCutoff) {
      if (!cfg.dry_run) {
        db.update(memories)
          .set({ status: "rejected", updated_at: new Date().toISOString() })
          .where(eq(memories.id, mem.id))
          .run();
        queueMemoryEmbeddingSync(db, mem.id);
        recordAudit(db, mem.id, "archived", "auto-pruner", `Stale: no activity since ${lastActivity}`);
      }
      result.stale_archived.push(mem.id);
    }
  }

  // 2. Delete rejected memories past retention
  const rejectedCutoff = new Date(
    now - cfg.rejected_retention_days * dayMs,
  ).toISOString();

  for (const mem of allMemories) {
    if (mem.status !== "rejected") continue;
    if (mem.updated_at < rejectedCutoff) {
      if (!cfg.dry_run) {
        // Soft delete — keep audit trail but remove from memories
        db.delete(memories).where(eq(memories.id, mem.id)).run();
        recordAudit(db, mem.id, "pruned", "auto-pruner", `Rejected memory past ${cfg.rejected_retention_days}d retention`);
      }
      result.rejected_pruned.push(mem.id);
    }
  }

  // 3. Compact transient memories
  const transientCutoff = new Date(
    now - cfg.transient_retention_days * dayMs,
  ).toISOString();

  for (const mem of allMemories) {
    if (mem.status !== "transient") continue;
    if (mem.updated_at < transientCutoff) {
      if (!cfg.dry_run) {
        db.delete(memories).where(eq(memories.id, mem.id)).run();
        recordAudit(db, mem.id, "pruned", "auto-pruner", `Transient memory past ${cfg.transient_retention_days}d retention`);
      }
      result.transient_pruned.push(mem.id);
    }
  }

  // 4. Demote unhealthy active memories
  const activeMemories = allMemories.filter((m) => m.status === "active");
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
    lines.push("", "Stale:");
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

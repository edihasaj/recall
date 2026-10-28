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

import { and, eq, gte, like, or } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import {
  approvalRequests,
  auditTrail,
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
import {
  createLoopCoverageCache,
  loadInjectedMemoryIds,
  loopRepoForMemory,
} from "./loop-activity.js";
import { RESTORE_ACTOR, RESTORE_REASON_PREFIX } from "./restore.js";

const DEFAULT_CONFIG: PruneConfig = {
  candidate_unconfirmed_days: 30,
  candidate_max_age_days: 60,
  stale_days: 90,
  rejected_retention_days: 30,
  transient_retention_days: 7,
  min_health_score: 0.2,
  dry_run: false,
};

export interface PruneResult {
  /** Unconfirmed, never-used candidates archived from automatic injection. */
  unconfirmed_archived: string[];
  /**
   * Unconfirmed candidates kept in automatic injection because the injection
   * loop did not cover the window for their repo: selection opportunity is
   * unproven, so "never selected" is unmeasured. Not counted in `total`.
   */
  unconfirmed_skipped_loop_inactive: string[];
  /**
   * Candidates archived from automatic injection because they stayed
   * unconfirmed and unrepeated past `candidate_max_age_days`, whether or not
   * they were selected or the loop covered their repo.
   */
  candidate_age_archived: string[];
  /** Stale memories archived out of auto-injection (still active + retrievable). */
  stale_archived: string[];
  /** Stale candidates kept for the same reason. Active rows are never skipped. Not counted in `total`. */
  stale_skipped_loop_inactive: string[];
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
    unconfirmed_archived: [],
    unconfirmed_skipped_loop_inactive: [],
    candidate_age_archived: [],
    stale_archived: [],
    stale_skipped_loop_inactive: [],
    rejected_pruned: [],
    transient_pruned: [],
    unhealthy_demoted: [],
    total: 0,
  };
  const nowIso = new Date(now).toISOString();
  const loopCovered = createLoopCoverageCache(db);

  // 1. Archive candidates that never earned a second-session signal and were
  // never selected. Keep the row searchable and confirmable; only remove it
  // from automatic prompt injection. This bounds provisional memory growth
  // without treating uncertainty as rejection.
  //
  // "Never selected" is only evidence when selection was possible: the
  // injection loop must have covered the whole window for the memory's repo.
  // A memory the compiler did select (a ledger row) without any reported
  // outcome is unmeasured too, not unused.
  const unconfirmedCutoff = new Date(
    now - cfg.candidate_unconfirmed_days * dayMs,
  ).toISOString();
  const selected = loadInjectedMemoryIds(db);
  const unconfirmed = queryMemories(db, {
    repo: cfg.repo,
    status: "candidate",
    auto_inject: true,
  }).filter((mem) =>
    mem.created_at < unconfirmedCutoff &&
    mem.repetition_count < 2 &&
    mem.injection_count === 0 &&
    !selected.has(mem.id)
  );
  const skippedLoopInactive = new Set<string>();
  for (const mem of unconfirmed) {
    if (!loopCovered(loopRepoForMemory(mem), unconfirmedCutoff, nowIso)) {
      result.unconfirmed_skipped_loop_inactive.push(mem.id);
      skippedLoopInactive.add(mem.id);
      continue;
    }
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
        `Archived unconfirmed candidate after ${cfg.candidate_unconfirmed_days}d without selection or repetition`,
      );
    }
    result.unconfirmed_archived.push(mem.id);
  }

  // 1b. Hard age limit. Step 1 refuses to read "never selected" as evidence
  // when the loop did not cover a repo, and it never touches a candidate the
  // compiler did select. Both are correct for measurement, but they let a
  // candidate stay in automatic injection forever: repos worked on another
  // machine never drain, and a candidate that keeps being injected without
  // ever being confirmed or repeated keeps its slot. Past the age limit, an
  // unearned candidate leaves automatic injection. It stays searchable and
  // `recall confirm` restores it.
  if (cfg.candidate_max_age_days > 0) {
    const maxAgeCutoff = new Date(now - cfg.candidate_max_age_days * dayMs).toISOString();
    const archivedInStep1 = new Set(result.unconfirmed_archived);
    // An explicit `--restore-unmeasured` readmits a candidate; its age counts
    // from that decision, so the next prune does not silently undo it.
    const recentlyRestored = new Set(db.select({ memory_id: auditTrail.memory_id })
      .from(auditTrail)
      .where(and(
        eq(auditTrail.action, "policy_applied"),
        eq(auditTrail.actor, RESTORE_ACTOR),
        like(auditTrail.reason, `${RESTORE_REASON_PREFIX}%`),
        gte(auditTrail.timestamp, maxAgeCutoff),
      ))
      .all()
      .map((row) => row.memory_id));
    const aged = queryMemories(db, {
      repo: cfg.repo,
      status: "candidate",
      auto_inject: true,
    }).filter((mem) =>
      mem.created_at < maxAgeCutoff &&
      mem.repetition_count < 2 &&
      !archivedInStep1.has(mem.id) &&
      !recentlyRestored.has(mem.id)
    );
    for (const mem of aged) {
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
          `Archived candidate past ${cfg.candidate_max_age_days}d max age without confirmation or repetition`,
        );
      }
      result.candidate_age_archived.push(mem.id);
    }
    const agedIds = new Set(result.candidate_age_archived);
    result.unconfirmed_skipped_loop_inactive = result.unconfirmed_skipped_loop_inactive
      .filter((id) => !agedIds.has(id));
  }

  // 2. Archive stale active/candidate memories.
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
    if (result.unconfirmed_archived.includes(mem.id)) continue;
    if (result.candidate_age_archived.includes(mem.id)) continue;
    if (skippedLoopInactive.has(mem.id)) continue;
    const lastActivity =
      mem.last_validated_at ?? mem.last_injected_at ?? mem.updated_at;

    if (lastActivity < staleCutoff && mem.auto_inject) {
      // Same guard as step 1, for candidates only: an active rule earned its
      // place, so disuse alone still retires it from ambient injection.
      if (
        mem.status === "candidate" &&
        !loopCovered(loopRepoForMemory(mem), staleCutoff, nowIso)
      ) {
        result.stale_skipped_loop_inactive.push(mem.id);
        continue;
      }
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

  // 3. Delete rejected memories past retention
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

  // 5. Demote unhealthy active memories
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
    result.unconfirmed_archived.length +
    result.candidate_age_archived.length +
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
    `Unconfirmed archived:${String(result.unconfirmed_archived.length).padStart(5)}`,
    `Unconfirmed skipped (loop inactive): ${result.unconfirmed_skipped_loop_inactive?.length ?? 0}`,
    `Candidates past max age archived: ${result.candidate_age_archived?.length ?? 0}`,
    `Stale archived:    ${result.stale_archived.length}`,
    `Stale skipped (loop inactive): ${result.stale_skipped_loop_inactive?.length ?? 0}`,
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

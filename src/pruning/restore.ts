/**
 * Undo archival that happened while the injection loop could not measure it.
 *
 * A candidate archived from automatic injection "for lacking selection" while
 * nothing could select it was demoted on no evidence. This restores those
 * rows above the confidence gate, skipping anything a person should look at
 * first (destructive or trigger-shaped rules, generated or non-user evidence).
 */

import { desc, eq, sql } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { auditTrail, memories } from "../db/schema.js";
import { getMemory, queryMemories } from "../models/memory.js";
import { recordAuditWithSnapshot } from "../audit/trail.js";
import { isHighRiskRule } from "../capture/correction.js";
import { isNonUserCaptureContext } from "../capture/context.js";
import { hasNonDurableProvenance } from "../capture/provenance.js";
import { CONFIDENCE, type MemoryItem } from "../types.js";
import {
  createLoopCoverageCache,
  loadInjectedMemoryIds,
  loopRepoForMemory,
} from "./loop-activity.js";

const DAY_MS = 86_400_000;
const CONFIDENCE_EPSILON = 1e-9;

export const RESTORE_ACTOR = "auto-pruner";
export const RESTORE_REASON_PREFIX = "Restored to auto-injection: demoted while the injection loop was inactive";

export interface RestoreUnmeasuredOptions {
  repo?: string;
  /** Defaults to `CONFIDENCE.ACTIVE_MIN`. */
  minConfidence?: number;
  /** Defaults to 30. */
  lookbackDays?: number;
  dryRun?: boolean;
  /** Clock override for tests. */
  now?: number;
}

export interface RestoreUnmeasuredResult {
  restored: string[];
  skipped_below_gate: number;
  /** The loop covered the lookback window for the repo: the archival was measured. */
  skipped_loop_active: number;
  /** Destructive/trigger-shaped text, generated provenance, or only non-user evidence. */
  skipped_risky: number;
  /** No matching, unchanged auto-pruner archival; an opt-out or quarantine must remain intact. */
  skipped_not_pruner_archived: number;
  min_confidence: number;
  lookback_days: number;
  dry_run: boolean;
}

/** Automatic restore never vouches for a rule a person must confirm. */
export function isRiskyToRestore(memory: MemoryItem): boolean {
  if (isHighRiskRule(memory.text) || isNonUserCaptureContext(memory.text)
    || hasNonDurableProvenance(memory)) return true;
  const contexts = memory.evidence
    .filter((entry) => entry.type === "session_correction" || entry.type === "review_feedback")
    .map((entry) => entry.context?.trim())
    .filter((context): context is string => Boolean(context));
  return contexts.length > 0 && contexts.every(isNonUserCaptureContext);
}

/**
 * Absence of injections cannot tell an archive from an intentional opt-out or
 * foreign-sync quarantine. Only reverse a recorded auto-pruner archival whose
 * after-state is still the current state, with no later audit mutation.
 *
 * Older pruners recorded an after-snapshot but not a before-snapshot. Preserve
 * that compatibility; when a before-snapshot is present it must show a real
 * transition from auto-injection.
 */
function prunerArchivalAt(db: RecallDb, memory: MemoryItem): string | null {
  const latest = db.select().from(auditTrail)
    .where(eq(auditTrail.memory_id, memory.id))
    .orderBy(desc(auditTrail.timestamp), sql`rowid DESC`)
    .limit(1).get();
  if (!latest || latest.action !== "demoted" || latest.actor !== RESTORE_ACTOR
    || !/^Archived (?:unconfirmed candidate after \d+(?:\.\d+)?d without selection or repetition|from auto-injection: no activity since )/.test(latest.reason ?? "")
    || !latest.after_snapshot) return null;
  try {
    const after = JSON.parse(latest.after_snapshot) as Record<string, unknown> | null;
    if (!after || typeof after !== "object" || Array.isArray(after)) return null;
    const fields = [
      "id", "type", "text", "scope", "repo", "path_scope", "status",
      "confidence", "source", "created_at", "updated_at", "last_validated_at",
      "last_injected_at", "injection_count", "override_count", "repetition_count",
      "auto_inject", "evidence", "capture_context", "supersedes",
    ] as const;
    if (fields.some((field) =>
      JSON.stringify(after[field]) !== JSON.stringify(memory[field])
    ) || (after.note ?? null) !== (memory.note ?? null)) return null;
    if (latest.before_snapshot) {
      const before = JSON.parse(latest.before_snapshot) as Record<string, unknown> | null;
      if (!before || before.auto_inject !== true) return null;
    }
    return typeof after.updated_at === "string" && Number.isFinite(Date.parse(after.updated_at))
      ? after.updated_at : null;
  } catch {
    return null;
  }
}

export function restoreUnmeasuredCandidates(
  db: RecallDb,
  options: RestoreUnmeasuredOptions = {},
): RestoreUnmeasuredResult {
  const minConfidence = options.minConfidence ?? CONFIDENCE.ACTIVE_MIN;
  const lookbackDays = options.lookbackDays ?? 30;
  const dryRun = options.dryRun ?? false;
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new RangeError("minConfidence must be a number between 0 and 1");
  }
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) {
    throw new RangeError("lookbackDays must be a positive number");
  }
  const now = options.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const sinceIso = new Date(now - lookbackDays * DAY_MS).toISOString();
  const loopCovered = createLoopCoverageCache(db);

  const result: RestoreUnmeasuredResult = {
    restored: [],
    skipped_below_gate: 0,
    skipped_loop_active: 0,
    skipped_risky: 0,
    skipped_not_pruner_archived: 0,
    min_confidence: minConfidence,
    lookback_days: lookbackDays,
    dry_run: dryRun,
  };

  const restore = () => {
    const selected = loadInjectedMemoryIds(db);
    const archived = queryMemories(db, {
      repo: options.repo,
      status: "candidate",
      auto_inject: false,
    }).filter((memory) => memory.injection_count === 0 && !selected.has(memory.id));

    for (const before of archived) {
      if (before.confidence + CONFIDENCE_EPSILON < minConfidence) {
        result.skipped_below_gate++;
        continue;
      }
      if (isRiskyToRestore(before)) {
        result.skipped_risky++;
        continue;
      }
      const archivedAt = prunerArchivalAt(db, before);
      if (!archivedAt) {
        result.skipped_not_pruner_archived++;
        continue;
      }
      const archiveWindowStart = new Date(Date.parse(archivedAt) - lookbackDays * DAY_MS).toISOString();
      // Check both the original archival window and the current window. A
      // correctly measured archive must not be undone after later downtime.
      // The current guard also prevents immediate re-archival after restore.
      const repo = loopRepoForMemory(before);
      if (loopCovered(repo, archiveWindowStart, archivedAt) || loopCovered(repo, sinceIso, nowIso)) {
        result.skipped_loop_active++;
        continue;
      }
      result.restored.push(before.id);
      if (dryRun) continue;
      db.update(memories)
        .set({ auto_inject: true, updated_at: nowIso })
        .where(eq(memories.id, before.id))
        .run();
      // "restored" is not an AuditAction and the schema is frozen. Not
      // "reactivated" either: the scanner treats that as a human touch and
      // would stop retracting the fact.
      const reason = `${RESTORE_REASON_PREFIX} (no injection coverage in ${lookbackDays}d; archival ${archivedAt})`;
      recordAuditWithSnapshot(db, before.id, "policy_applied", RESTORE_ACTOR, reason,
        before, getMemory(db, before.id) ?? null);
    }
  };
  // Fence the proof read and writes against an external sync updating a row
  // between selection and restoration. Preview needs only a read snapshot.
  const transaction = db.$client.transaction(restore);
  if (dryRun) transaction();
  else transaction.immediate();
  return result;
}

export function formatRestoreReport(result: RestoreUnmeasuredResult): string {
  const prefix = result.dry_run ? "[DRY RUN] " : "";
  const lines = [
    `${prefix}Restore Unmeasured Candidates`,
    ``,
    `Gate: confidence >= ${result.min_confidence.toFixed(2)}, loop window ${result.lookback_days}d`,
    `${result.dry_run ? "Would restore" : "Restored"}:     ${result.restored.length}`,
    `Below gate:        ${result.skipped_below_gate}`,
    `Loop active:       ${result.skipped_loop_active}`,
    `Risky (confirm):   ${result.skipped_risky}`,
    `No pruner proof:   ${result.skipped_not_pruner_archived}`,
  ];
  if (result.restored.length > 0) {
    lines.push("", result.dry_run ? "Would restore:" : "Restored:");
    for (const id of result.restored.slice(0, 10)) lines.push(`  ${id.slice(0, 8)}`);
    if (result.restored.length > 10) lines.push(`  ... and ${result.restored.length - 10} more`);
  }
  return lines.join("\n");
}

/**
 * Was the injection loop running, so a candidate could have been selected?
 *
 * Retention used to archive a candidate for "N days without selection"
 * without asking whether selection was possible. If the daemon is unloaded or
 * hooks are missing, candidates can look unused without a chance to generate
 * selection evidence. These helpers
 * read the `memory_injections` ledger (one row per memory per session the
 * compiler selected it in) to tell "unmeasured" apart from "measured and not
 * chosen".
 */

import { and, gte, inArray, lte, sql } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { memoryInjections } from "../db/schema.js";
import { memoryRepoAliases } from "../repo/aliases.js";

const DAY_MS = 86_400_000;

export interface LoopActivityQuery {
  /**
   * Repository whose injections count. `null` means a memory that is not tied
   * to one repository (global scope): an injection in any repository counts.
   */
  repo: string | null;
  sinceIso: string;
}

export interface LoopCoverageQuery extends LoopActivityQuery {
  untilIso: string;
  /** Longest tolerated stretch without an injection. Defaults to {@link defaultMaxGapDays}. */
  maxGapDays?: number;
}

function repoCondition(db: RecallDb, repo: string | null) {
  if (!repo) return undefined;
  // Injections are recorded under the compile request's repo, which may be a
  // basename or `owner/name` where the memory stores the other form.
  return inArray(memoryInjections.repo, memoryRepoAliases(db, repo));
}

/** True iff `memory_injections` has at least one row since `sinceIso` for this repo. */
export function isInjectionLoopAlive(db: RecallDb, query: LoopActivityQuery): boolean {
  const row = db.select({ id: memoryInjections.id })
    .from(memoryInjections)
    .where(and(gte(memoryInjections.injected_at, query.sinceIso), repoCondition(db, query.repo)))
    .limit(1)
    .get();
  return Boolean(row);
}

/** Conservative exposure bound; longer gaps leave coverage unproven. */
export function defaultMaxGapDays(windowDays: number): number {
  return Math.min(7, Math.max(1, Math.floor(windowDays / 2)));
}

/**
 * True when injections cover the whole window: no stretch longer than
 * `maxGapDays` between the window start, each day with an injection, and the
 * window end.
 *
 * A single injection is not enough. A loop that restarts after months of
 * downtime records one injection, and "alive since the cutoff" would then
 * archive every old candidate in the next maintenance pass, including ones
 * just restored, after one day of real exposure.
 *
 * A zero-length window is covered: there is nothing to measure.
 */
export function isInjectionLoopCovering(db: RecallDb, query: LoopCoverageQuery): boolean {
  const startMs = Date.parse(query.sinceIso);
  const endMs = Date.parse(query.untilIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  if (endMs <= startMs) return true;
  if (!isInjectionLoopAlive(db, query)) return false;

  const windowDays = (endMs - startMs) / DAY_MS;
  const maxGapMs = (query.maxGapDays ?? defaultMaxGapDays(windowDays)) * DAY_MS;
  // One row per day (first and last injection) keeps this exact without
  // reading every ledger row.
  const days = db.select({
    first: sql<string>`min(${memoryInjections.injected_at})`,
    last: sql<string>`max(${memoryInjections.injected_at})`,
  })
    .from(memoryInjections)
    .where(and(
      gte(memoryInjections.injected_at, query.sinceIso),
      lte(memoryInjections.injected_at, query.untilIso),
      repoCondition(db, query.repo),
    ))
    .groupBy(sql`substr(${memoryInjections.injected_at}, 1, 10)`)
    .orderBy(sql`substr(${memoryInjections.injected_at}, 1, 10)`)
    .all();
  if (days.length === 0) return false;

  let previous = startMs;
  for (const day of days) {
    if (Date.parse(day.first) - previous > maxGapMs) return false;
    previous = Date.parse(day.last);
  }
  return endMs - previous <= maxGapMs;
}

export type LoopCoverageCache = (repo: string | null, sinceIso: string, untilIso: string) => boolean;

/** Memoizes coverage per repo and window for one prune or restore run. */
export function createLoopCoverageCache(db: RecallDb): LoopCoverageCache {
  const cache = new Map<string, boolean>();
  return (repo, sinceIso, untilIso) => {
    const key = `${repo ?? "\u0000any"}|${sinceIso}|${untilIso}`;
    let covered = cache.get(key);
    if (covered === undefined) {
      covered = isInjectionLoopCovering(db, { repo, sinceIso, untilIso });
      cache.set(key, covered);
    }
    return covered;
  };
}

/** Repository whose loop activity measures this memory; null when it applies everywhere. */
export function loopRepoForMemory(memory: { repo: string | null; scope: string }): string | null {
  return memory.scope === "global" ? null : memory.repo;
}

/**
 * Memories the compiler selected at least once. `injection_count` only moves
 * when an agent reports an outcome, so a selected memory without feedback
 * still reads as "never injected" there. Loaded once per run: one statement
 * instead of one per row (uses the `memory_id` index).
 */
export function loadInjectedMemoryIds(db: RecallDb): Set<string> {
  return new Set(
    db.selectDistinct({ memory_id: memoryInjections.memory_id })
      .from(memoryInjections)
      .all()
      .map((row) => row.memory_id),
  );
}

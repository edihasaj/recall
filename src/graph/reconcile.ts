/**
 * Graph reconciliation: keep the knowledge graph a clean projection of
 * *active* (verified) memories only.
 *
 * The extractor rules evolve (e.g. dropping generic `pnpm build` command
 * nodes). When they do, every existing install carries junk entities that a
 * plain idempotent backfill can only add to, never remove. `GRAPH_EXTRACTOR_VERSION`
 * is bumped whenever the rules change; the daemon runs a one-time rebuild on
 * startup when the stored marker is behind, so the cleanup happens automatically
 * for all users on upgrade rather than requiring a manual `graph backfill --rebuild`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RecallDb } from "../db/client.js";
import { queryMemories } from "../models/memory.js";
import { clearGraph } from "./store.js";
import { ingestMemoryHeuristic } from "./ingest.js";

/**
 * Bump this whenever the heuristic extractor's rules change in a way that
 * should retroactively clean existing graphs. History:
 *   1 — original extractor.
 *   2 — drop generic package/runtime command nodes, tool-name filler
 *       ("pnpm as"), and shell/lang builtins misread as libraries.
 */
export const GRAPH_EXTRACTOR_VERSION = 2;

export interface ReconcileResult {
  memories: number;
  entity_touches: number;
  relation_touches: number;
}

/**
 * Rebuild the entire graph from active memories. Clears all existing
 * entities/relations first so nodes produced by older/looser rules or by
 * now-unverified memories are dropped.
 */
export function reconcileGraph(db: RecallDb): ReconcileResult {
  clearGraph(db);
  const rows = queryMemories(db, { status: "active", limit: 100000 });
  let entityTouches = 0;
  let relationTouches = 0;
  for (const row of rows) {
    const s = ingestMemoryHeuristic(db, { id: row.id, text: row.text, repo: row.repo });
    entityTouches += s.entities_created_or_updated;
    relationTouches += s.relations_created_or_updated;
  }
  return { memories: rows.length, entity_touches: entityTouches, relation_touches: relationTouches };
}

/**
 * Run {@link reconcileGraph} once per extractor-version bump. The marker is a
 * small file in the data dir (no schema migration needed), so this is safe on
 * any install. Returns the result when a rebuild ran, or null when the graph
 * was already current.
 */
export function reconcileGraphIfStale(db: RecallDb, dataDir: string): ReconcileResult | null {
  const markerPath = join(dataDir, ".graph-extractor-version");
  if (readMarker(markerPath) >= GRAPH_EXTRACTOR_VERSION) return null;
  const result = reconcileGraph(db);
  writeMarker(markerPath, GRAPH_EXTRACTOR_VERSION);
  return result;
}

function readMarker(path: string): number {
  try {
    if (!existsSync(path)) return 0;
    const parsed = parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeMarker(path: string, version: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${version}\n`, "utf8");
  } catch {
    // Best-effort: if we can't persist the marker the rebuild simply re-runs
    // next start, which is idempotent, so this is non-fatal.
  }
}

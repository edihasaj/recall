/**
 * Glue: take a memory row, extract entities, persist them into the graph.
 *
 * The heuristic pass always runs (cheap, deterministic). The LLM enrichment
 * pass is left to the maintenance dispatcher — capture-path latency stays
 * regex-bounded, the graph fills in asynchronously.
 */
import type { RecallDb } from "../db/client.js";
import { getMemory } from "../models/memory.js";
import {
  heuristic,
  mergeExtractions,
  type ExtractionResult,
} from "./extractor.js";
import {
  upsertEntity,
  linkMemoryToEntity,
  upsertRelation,
  type EntityRow,
  type EntityRelationRow,
} from "./store.js";

export interface IngestSummary {
  memory_id: string;
  entities_created_or_updated: number;
  relations_created_or_updated: number;
}

export interface MemoryLike {
  id: string;
  text: string;
  repo: string | null;
}

/**
 * Run the heuristic extractor on a memory and persist entities + relations.
 * Idempotent: calling twice for the same memory bumps mention counts but
 * does not duplicate rows. Safe to call from capture-path hot code.
 */
export function ingestMemoryHeuristic(db: RecallDb, memory: MemoryLike): IngestSummary {
  const extraction = heuristic(memory.text);
  return persistExtraction(db, memory, extraction);
}

/**
 * Apply a pre-computed ExtractionResult (e.g. from an LLM pass merged with
 * the heuristic pass) for a memory. Used by the maintenance dispatcher.
 */
export function ingestMemoryExtraction(
  db: RecallDb,
  memory: MemoryLike,
  extraction: ExtractionResult,
): IngestSummary {
  return persistExtraction(db, memory, extraction);
}

export function mergeAndIngest(
  db: RecallDb,
  memory: MemoryLike,
  passes: ExtractionResult[],
): IngestSummary {
  return persistExtraction(db, memory, mergeExtractions(...passes));
}

function persistExtraction(
  db: RecallDb,
  memory: MemoryLike,
  extraction: ExtractionResult,
): IngestSummary {
  const entityIndex = new Map<string, EntityRow>(); // dedupe by (kind|normalized) for relation lookup
  let entitiesTouched = 0;
  for (const ent of extraction.entities) {
    const row = upsertEntity(db, {
      kind: ent.kind,
      name: ent.name,
      repo: memory.repo,
      first_seen_memory_id: memory.id,
    });
    entityIndex.set(`${row.kind}|${row.normalized_name}`, row);
    linkMemoryToEntity(db, {
      memory_id: memory.id,
      entity_id: row.id,
      source: ent.source,
      weight: ent.weight,
    });
    entitiesTouched++;
  }

  let relationsTouched = 0;
  const lookupRow = (kind: string, name: string): EntityRow | undefined => {
    // upsertEntity normalizes internally, so we have to mirror that to look up
    // by the index key. Skip if the related entity wasn't in this batch.
    for (const row of entityIndex.values()) {
      if (row.kind === kind && row.name === name) return row;
    }
    return undefined;
  };

  for (const rel of extraction.relations) {
    const src = lookupRow(rel.source.kind, rel.source.name)
      ?? upsertEntity(db, { kind: rel.source.kind, name: rel.source.name, repo: memory.repo });
    const tgt = lookupRow(rel.target.kind, rel.target.name)
      ?? upsertEntity(db, { kind: rel.target.kind, name: rel.target.name, repo: memory.repo });
    if (src.id === tgt.id) continue;
    upsertRelation(db, {
      source_entity_id: src.id,
      target_entity_id: tgt.id,
      relation_type: rel.relation,
      source_memory_id: memory.id,
      confidence: rel.confidence,
    });
    relationsTouched++;
  }

  return {
    memory_id: memory.id,
    entities_created_or_updated: entitiesTouched,
    relations_created_or_updated: relationsTouched,
  };
}

/**
 * Best-effort heuristic ingest by memory id. Used by capture-path callers
 * (daemon /correct, /review, /scan) that want graph ingest to be a no-op on
 * failure rather than aborting the originating request.
 *
 * Only *active* (verified) memories enter the graph — candidate/transient
 * memories are skipped so the graph stays a projection of verified knowledge.
 * A candidate that is later promoted is ingested at promotion time.
 *
 * Returns the summary on success, `null` if the memory was not found, not
 * active, or if any error was swallowed.
 */
export function safeIngestMemoryById(db: RecallDb, memoryId: string): IngestSummary | null {
  try {
    const mem = getMemory(db, memoryId);
    if (!mem) return null;
    if (mem.status !== "active") return null;
    return ingestMemoryHeuristic(db, { id: mem.id, text: mem.text, repo: mem.repo });
  } catch (err) {
    console.error("[recall] graph ingest failed:", { memory_id: memoryId, error: err });
    return null;
  }
}

// Re-export the row types so callers don't have to know about the
// store layer's internal naming.
export type { EntityRow, EntityRelationRow };

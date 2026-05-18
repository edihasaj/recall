/**
 * Graph-aware retrieval. Pipeline:
 *   1. Seed: run the existing hybrid (FTS + vector) search to get the
 *      most-relevant memories for the query.
 *   2. Pivot: collect the entities those seed memories mention.
 *   3. Expand: walk the entity graph N hops. Each new memory mentioned
 *      by an expanded entity becomes a candidate.
 *   4. Re-rank: combine seed score + graph distance + entity overlap.
 *
 * This is what makes a question like "how does the api handle session
 * expiry" surface memories that don't textually match "expiry" but mention
 * `jose` or `auth-middleware.ts`, which the seed memory connected to.
 */
import { hybridSearch } from "../embeddings/embeddings.js";
import { searchMemoryFtsIndex } from "../vector/sqlite-fts.js";
import type { RecallDb } from "../db/client.js";
import type { EmbeddingConfig, MemoryItem } from "../types.js";
import { getMemory } from "../models/memory.js";
import {
  listEntitiesForMemory,
  listMemoryIdsForEntity,
  neighborsOf,
  type EntityRow,
  type RelationType,
} from "./store.js";

export interface GraphRetrievalOptions {
  repo?: string;
  /** Initial seed pool (FTS/hybrid). */
  seedLimit?: number;
  /** Max graph hops from each seed entity. */
  hops?: number;
  /** Final result cap. */
  limit?: number;
  /** Restrict graph walk to specific relation types (optional). */
  relationTypes?: RelationType[];
}

export interface GraphRetrievalHit {
  memory: MemoryItem;
  /** 'seed' if surfaced by hybrid, 'graph' if added by graph expansion. */
  via: "seed" | "graph";
  /** Final blended score (0..~2). */
  score: number;
  /** Hops from a seed entity (0 for seed memories). */
  hops: number;
  /** Entities of this memory that the query also touches via the graph. */
  shared_entities: EntityRow[];
}

export interface GraphRetrievalResult {
  hits: GraphRetrievalHit[];
  seed_count: number;
  expanded_entities: number;
  /** Map of entity id → entity row, for callers that want to render a graph. */
  entities: Record<string, EntityRow>;
}

const SEED_WEIGHT = 1.0;
const GRAPH_WEIGHT = 0.6;
const ENTITY_OVERLAP_BONUS = 0.15;
const HOP_DECAY = 0.55;

/**
 * Hybrid + graph retrieval. Always returns at least the hybrid seeds (so
 * callers can swap a plain hybrid call with this one without surprises).
 */
export async function graphQuery(
  db: RecallDb,
  query: string,
  embeddingConfig: EmbeddingConfig | null,
  options: GraphRetrievalOptions = {},
): Promise<GraphRetrievalResult> {
  const seedLimit = options.seedLimit ?? 10;
  const hops = Math.max(0, Math.min(4, options.hops ?? 2));
  const limit = options.limit ?? 15;

  // --- Step 1: seeds via hybrid (falls back to FTS-only when no embedder) ---
  let seedHits: Array<{ memory: MemoryItem; score: number }>;
  if (embeddingConfig) {
    const hybrid = await hybridSearch(db, query, embeddingConfig, {
      repo: options.repo,
      limit: seedLimit,
    });
    seedHits = hybrid.map((h) => ({ memory: h.memory, score: h.score }));
  } else {
    const fts = searchMemoryFtsIndex(db, query, {
      repo: options.repo,
      limit: seedLimit,
    });
    seedHits = fts
      .map((row, i) => {
        const mem = getMemory(db, row.memory_id);
        if (!mem) return null;
        const score = 1 / (1 + Math.abs(row.lexical_rank) + i);
        return { memory: mem, score };
      })
      .filter((x): x is { memory: MemoryItem; score: number } => x !== null);
  }

  // --- Step 2: collect seed entities ---
  const entityMap = new Map<string, EntityRow>();
  const seedEntityIds = new Set<string>();
  for (const seed of seedHits) {
    const ents = listEntitiesForMemory(db, seed.memory.id);
    for (const e of ents) {
      entityMap.set(e.id, e);
      seedEntityIds.add(e.id);
    }
  }

  // --- Step 3: expand graph ---
  const expandedEntityIds = new Set<string>(seedEntityIds);
  const entityHopDistance = new Map<string, number>();
  for (const id of seedEntityIds) entityHopDistance.set(id, 0);

  if (hops > 0 && seedEntityIds.size > 0) {
    for (const seedId of seedEntityIds) {
      const walk = neighborsOf(db, seedId, {
        hops,
        relationTypes: options.relationTypes,
      });
      for (const ent of walk.entities) {
        entityMap.set(ent.id, ent);
        if (!expandedEntityIds.has(ent.id)) {
          expandedEntityIds.add(ent.id);
          // Approximate hop distance via shortest seen so far. We don't
          // track exact BFS layers per pair (cheaper to over-estimate),
          // so use 1 as the floor for any non-seed entity. Anything deeper
          // gets a softer multiplier through HOP_DECAY ^ hops.
          entityHopDistance.set(ent.id, 1);
        }
      }
    }
  }

  // --- Step 4: collect candidate memories ---
  // For every expanded entity, pull its memories. Seeds are already in
  // there; we'll blend graph and seed scores.
  const hits = new Map<string, GraphRetrievalHit>();

  for (const seed of seedHits) {
    const ents = listEntitiesForMemory(db, seed.memory.id);
    hits.set(seed.memory.id, {
      memory: seed.memory,
      via: "seed",
      score: seed.score * SEED_WEIGHT,
      hops: 0,
      shared_entities: ents,
    });
  }

  // Only pull memories from the graph when hops > 0. At hops=0 the
  // caller wants "seeds only" — the entity map is still returned for
  // visualisation, but we don't expand into other memories.
  if (hops > 0) {
    for (const entId of expandedEntityIds) {
      const hop = entityHopDistance.get(entId) ?? 1;
      const ent = entityMap.get(entId);
      if (!ent) continue;
      const decay = Math.pow(HOP_DECAY, hop);

      const memIds = listMemoryIdsForEntity(db, entId);
      for (const memId of memIds) {
        const existing = hits.get(memId);
        if (existing) {
          // Memory already in hits — bump score with graph overlap bonus.
          // Avoid double-counting the *same* entity twice.
          if (!existing.shared_entities.find((e) => e.id === entId)) {
            existing.shared_entities.push(ent);
            existing.score += ENTITY_OVERLAP_BONUS * decay;
          }
          continue;
        }
        const mem = getMemory(db, memId);
        if (!mem) continue;
        if (options.repo && mem.repo && mem.repo !== options.repo) continue;
        hits.set(memId, {
          memory: mem,
          via: "graph",
          score: GRAPH_WEIGHT * decay,
          hops: hop,
          shared_entities: [ent],
        });
      }
    }
  }

  const sorted = Array.from(hits.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const entitiesOut: Record<string, EntityRow> = {};
  for (const [id, row] of entityMap) entitiesOut[id] = row;

  return {
    hits: sorted,
    seed_count: seedHits.length,
    expanded_entities: expandedEntityIds.size,
    entities: entitiesOut,
  };
}

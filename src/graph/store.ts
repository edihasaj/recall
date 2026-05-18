/**
 * Read/write layer for the knowledge graph tables. Pure DB operations —
 * no LLM calls, no business logic — so they're safe to call from any
 * code path (capture hook, dispatcher, scan, MCP tool).
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { entities, entityRelations, memoryEntities } from "../db/schema.js";
import { normalizeName, type EntityKind } from "./normalize.js";

export type RelationType =
  | "uses"
  | "replaces"
  | "conflicts_with"
  | "tested_by"
  | "depends_on"
  | "references"
  | "part_of";

export interface EntityRow {
  id: string;
  kind: EntityKind;
  name: string;
  normalized_name: string;
  repo: string | null;
  description: string | null;
  mention_count: number;
  first_seen_memory_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EntityRelationRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: RelationType;
  source_memory_id: string | null;
  confidence: number;
  created_at: string;
}

export interface UpsertEntityInput {
  kind: EntityKind;
  name: string;
  repo?: string | null;
  description?: string | null;
  first_seen_memory_id?: string | null;
}

/**
 * Insert or look up an entity by (kind, normalized_name, repo). Returns the
 * canonical row. Increments mention_count on every call so we can rank
 * entities by how often the codebase mentions them.
 */
export function upsertEntity(db: RecallDb, input: UpsertEntityInput): EntityRow {
  const normalized = normalizeName(input.kind, input.name);
  const repo = input.repo ?? null;
  const now = new Date().toISOString();

  const existing = findEntityByNormalized(db, input.kind, normalized, repo);
  if (existing) {
    db.update(entities)
      .set({
        mention_count: existing.mention_count + 1,
        updated_at: now,
        // Backfill description / first_seen if not previously set.
        description: existing.description ?? input.description ?? null,
        first_seen_memory_id: existing.first_seen_memory_id ?? input.first_seen_memory_id ?? null,
      })
      .where(eq(entities.id, existing.id))
      .run();
    return {
      ...existing,
      mention_count: existing.mention_count + 1,
      updated_at: now,
      description: existing.description ?? input.description ?? null,
      first_seen_memory_id: existing.first_seen_memory_id ?? input.first_seen_memory_id ?? null,
    };
  }

  const id = randomUUID();
  db.insert(entities)
    .values({
      id,
      kind: input.kind,
      name: input.name.trim(),
      normalized_name: normalized,
      repo,
      description: input.description ?? null,
      first_seen_memory_id: input.first_seen_memory_id ?? null,
      mention_count: 1,
      created_at: now,
      updated_at: now,
    })
    .run();
  return {
    id,
    kind: input.kind,
    name: input.name.trim(),
    normalized_name: normalized,
    repo,
    description: input.description ?? null,
    mention_count: 1,
    first_seen_memory_id: input.first_seen_memory_id ?? null,
    created_at: now,
    updated_at: now,
  };
}

export function findEntityByNormalized(
  db: RecallDb,
  kind: EntityKind,
  normalized: string,
  repo: string | null,
): EntityRow | null {
  const row = db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.kind, kind),
        eq(entities.normalized_name, normalized),
        repo === null
          ? sql`${entities.repo} IS NULL`
          : eq(entities.repo, repo),
      ),
    )
    .get();
  return (row as EntityRow | undefined) ?? null;
}

export function getEntity(db: RecallDb, id: string): EntityRow | null {
  const row = db.select().from(entities).where(eq(entities.id, id)).get();
  return (row as EntityRow | undefined) ?? null;
}

export interface ListEntitiesOptions {
  repo?: string;
  kind?: EntityKind;
  search?: string;
  limit?: number;
  offset?: number;
}

export function listEntities(db: RecallDb, opts: ListEntitiesOptions = {}): EntityRow[] {
  const conditions: ReturnType<typeof eq>[] = [];
  if (opts.repo) conditions.push(eq(entities.repo, opts.repo));
  if (opts.kind) conditions.push(eq(entities.kind, opts.kind));
  const where = conditions.length === 1 ? conditions[0] : conditions.length > 1 ? and(...conditions) : undefined;
  const builder = where
    ? db.select().from(entities).where(where)
    : db.select().from(entities);
  const rows = builder
    .orderBy(sql`${entities.mention_count} DESC`)
    .limit(opts.limit ?? 200)
    .offset(opts.offset ?? 0)
    .all() as EntityRow[];
  if (opts.search) {
    const needle = opts.search.toLowerCase();
    return rows.filter(
      (r) => r.normalized_name.includes(needle) || r.name.toLowerCase().includes(needle),
    );
  }
  return rows;
}

export interface LinkMemoryEntityInput {
  memory_id: string;
  entity_id: string;
  source: "heuristic" | "llm" | "manual";
  weight?: number;
}

/** Idempotent: links a memory to an entity, no-op if the edge already exists. */
export function linkMemoryToEntity(db: RecallDb, input: LinkMemoryEntityInput): void {
  const existing = db
    .select({ id: memoryEntities.id })
    .from(memoryEntities)
    .where(
      and(
        eq(memoryEntities.memory_id, input.memory_id),
        eq(memoryEntities.entity_id, input.entity_id),
      ),
    )
    .get();
  if (existing) return;
  db.insert(memoryEntities)
    .values({
      id: randomUUID(),
      memory_id: input.memory_id,
      entity_id: input.entity_id,
      source: input.source,
      weight: input.weight ?? 1,
      created_at: new Date().toISOString(),
    })
    .run();
}

export function listEntitiesForMemory(db: RecallDb, memoryId: string): EntityRow[] {
  return db
    .select({
      id: entities.id,
      kind: entities.kind,
      name: entities.name,
      normalized_name: entities.normalized_name,
      repo: entities.repo,
      description: entities.description,
      mention_count: entities.mention_count,
      first_seen_memory_id: entities.first_seen_memory_id,
      created_at: entities.created_at,
      updated_at: entities.updated_at,
    })
    .from(memoryEntities)
    .innerJoin(entities, eq(entities.id, memoryEntities.entity_id))
    .where(eq(memoryEntities.memory_id, memoryId))
    .all() as EntityRow[];
}

export function listMemoryIdsForEntity(db: RecallDb, entityId: string): string[] {
  const rows = db
    .select({ memory_id: memoryEntities.memory_id })
    .from(memoryEntities)
    .where(eq(memoryEntities.entity_id, entityId))
    .all();
  return rows.map((r) => r.memory_id);
}

export interface UpsertRelationInput {
  source_entity_id: string;
  target_entity_id: string;
  relation_type: RelationType;
  source_memory_id?: string | null;
  confidence?: number;
}

/** Idempotent on (source, target, relation_type, source_memory_id). */
export function upsertRelation(db: RecallDb, input: UpsertRelationInput): EntityRelationRow {
  const sourceMem = input.source_memory_id ?? null;
  const existing = db
    .select()
    .from(entityRelations)
    .where(
      and(
        eq(entityRelations.source_entity_id, input.source_entity_id),
        eq(entityRelations.target_entity_id, input.target_entity_id),
        eq(entityRelations.relation_type, input.relation_type),
        sourceMem === null
          ? sql`${entityRelations.source_memory_id} IS NULL`
          : eq(entityRelations.source_memory_id, sourceMem),
      ),
    )
    .get() as EntityRelationRow | undefined;
  if (existing) {
    if (input.confidence !== undefined && input.confidence > existing.confidence) {
      db.update(entityRelations)
        .set({ confidence: input.confidence })
        .where(eq(entityRelations.id, existing.id))
        .run();
      return { ...existing, confidence: input.confidence };
    }
    return existing;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(entityRelations)
    .values({
      id,
      source_entity_id: input.source_entity_id,
      target_entity_id: input.target_entity_id,
      relation_type: input.relation_type,
      source_memory_id: sourceMem,
      confidence: input.confidence ?? 0.6,
      created_at: now,
    })
    .run();
  return {
    id,
    source_entity_id: input.source_entity_id,
    target_entity_id: input.target_entity_id,
    relation_type: input.relation_type,
    source_memory_id: sourceMem,
    confidence: input.confidence ?? 0.6,
    created_at: now,
  };
}

export function neighborsOf(
  db: RecallDb,
  entityId: string,
  options: { hops?: number; relationTypes?: RelationType[] } = {},
): { entities: EntityRow[]; relations: EntityRelationRow[] } {
  const maxHops = Math.max(1, Math.min(5, options.hops ?? 1));
  const visited = new Set<string>([entityId]);
  let frontier = [entityId];
  const collectedRelations = new Map<string, EntityRelationRow>();

  for (let hop = 0; hop < maxHops; hop++) {
    if (frontier.length === 0) break;
    const next: string[] = [];
    const relationFilter = options.relationTypes;
    const outgoing = db
      .select()
      .from(entityRelations)
      .where(
        relationFilter && relationFilter.length > 0
          ? and(
              inArray(entityRelations.source_entity_id, frontier),
              inArray(entityRelations.relation_type, relationFilter),
            )
          : inArray(entityRelations.source_entity_id, frontier),
      )
      .all() as EntityRelationRow[];
    const incoming = db
      .select()
      .from(entityRelations)
      .where(
        relationFilter && relationFilter.length > 0
          ? and(
              inArray(entityRelations.target_entity_id, frontier),
              inArray(entityRelations.relation_type, relationFilter),
            )
          : inArray(entityRelations.target_entity_id, frontier),
      )
      .all() as EntityRelationRow[];

    for (const rel of [...outgoing, ...incoming]) {
      collectedRelations.set(rel.id, rel);
      for (const candidate of [rel.source_entity_id, rel.target_entity_id]) {
        if (!visited.has(candidate)) {
          visited.add(candidate);
          next.push(candidate);
        }
      }
    }
    frontier = next;
  }

  const entityRows = visited.size === 0
    ? []
    : (db
        .select()
        .from(entities)
        .where(inArray(entities.id, Array.from(visited)))
        .all() as EntityRow[]);

  return {
    entities: entityRows,
    relations: Array.from(collectedRelations.values()),
  };
}

export function countEntities(db: RecallDb): number {
  const row = db
    .select({ c: sql<number>`count(*)` })
    .from(entities)
    .get();
  return Number(row?.c ?? 0);
}

export function countRelations(db: RecallDb): number {
  const row = db
    .select({ c: sql<number>`count(*)` })
    .from(entityRelations)
    .get();
  return Number(row?.c ?? 0);
}

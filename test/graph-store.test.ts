import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";
import { installMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";
import {
  countEntities,
  countRelations,
  getEntity,
  linkMemoryToEntity,
  listEntities,
  listEntitiesForMemory,
  listMemoryIdsForEntity,
  neighborsOf,
  upsertEntity,
  upsertRelation,
} from "../src/graph/store.js";
import { ingestMemoryHeuristic } from "../src/graph/ingest.js";

installMockEmbeddingProvider();

let counter = 0;
function freshDb(): RecallDb {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-graph-test-"));
  return initStandaloneDb(join(dir, `graph-${counter++}.db`));
}

describe("graph store", () => {
  let db: RecallDb;
  beforeEach(() => {
    db = freshDb();
  });

  it("upsert is idempotent on (kind, normalized_name, repo)", () => {
    const a = upsertEntity(db, { kind: "library", name: "Drizzle-ORM", repo: "recall" });
    const b = upsertEntity(db, { kind: "library", name: "drizzle-orm", repo: "recall" });
    expect(a.id).toBe(b.id);
    expect(b.mention_count).toBe(2);
  });

  it("separates entities by repo scope", () => {
    const a = upsertEntity(db, { kind: "library", name: "react", repo: "appA" });
    const b = upsertEntity(db, { kind: "library", name: "react", repo: "appB" });
    expect(a.id).not.toBe(b.id);
  });

  it("treats null repo as a distinct global bucket", () => {
    const a = upsertEntity(db, { kind: "library", name: "lodash", repo: null });
    const b = upsertEntity(db, { kind: "library", name: "lodash", repo: null });
    const c = upsertEntity(db, { kind: "library", name: "lodash", repo: "x" });
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });

  it("links memories to entities idempotently", () => {
    const memId = createMemory(db, {
      type: "rule",
      text: "use react",
      scope: "global",
      source: "manual",
    });
    const ent = upsertEntity(db, { kind: "library", name: "react", repo: null });
    linkMemoryToEntity(db, { memory_id: memId, entity_id: ent.id, source: "heuristic" });
    linkMemoryToEntity(db, { memory_id: memId, entity_id: ent.id, source: "heuristic" });
    const ids = listMemoryIdsForEntity(db, ent.id);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe(memId);
  });

  it("upsertRelation dedupes by (source, target, type, source_memory)", () => {
    const a = upsertEntity(db, { kind: "library", name: "jose", repo: null });
    const b = upsertEntity(db, { kind: "library", name: "jsonwebtoken", repo: null });
    const r1 = upsertRelation(db, {
      source_entity_id: a.id,
      target_entity_id: b.id,
      relation_type: "replaces",
      source_memory_id: "mem-1",
      confidence: 0.5,
    });
    const r2 = upsertRelation(db, {
      source_entity_id: a.id,
      target_entity_id: b.id,
      relation_type: "replaces",
      source_memory_id: "mem-1",
      confidence: 0.9,
    });
    expect(r1.id).toBe(r2.id);
    // higher confidence wins
    expect(r2.confidence).toBe(0.9);
    expect(countRelations(db)).toBe(1);
  });

  it("neighborsOf walks N hops bidirectionally", () => {
    const a = upsertEntity(db, { kind: "concept", name: "auth", repo: null });
    const b = upsertEntity(db, { kind: "library", name: "jose", repo: null });
    const c = upsertEntity(db, { kind: "library", name: "openssl", repo: null });
    upsertRelation(db, {
      source_entity_id: a.id,
      target_entity_id: b.id,
      relation_type: "uses",
    });
    upsertRelation(db, {
      source_entity_id: b.id,
      target_entity_id: c.id,
      relation_type: "depends_on",
    });
    const hop1 = neighborsOf(db, a.id, { hops: 1 });
    expect(hop1.entities.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
    const hop2 = neighborsOf(db, a.id, { hops: 2 });
    expect(hop2.entities.map((e) => e.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(hop2.relations).toHaveLength(2);
  });

  it("filters neighbors by relation type", () => {
    const a = upsertEntity(db, { kind: "library", name: "a", repo: null });
    const b = upsertEntity(db, { kind: "library", name: "b", repo: null });
    const c = upsertEntity(db, { kind: "library", name: "c", repo: null });
    upsertRelation(db, { source_entity_id: a.id, target_entity_id: b.id, relation_type: "uses" });
    upsertRelation(db, { source_entity_id: a.id, target_entity_id: c.id, relation_type: "replaces" });
    const usesOnly = neighborsOf(db, a.id, { hops: 1, relationTypes: ["uses"] });
    expect(usesOnly.entities.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("listEntities filters by repo, kind, search", () => {
    upsertEntity(db, { kind: "library", name: "react", repo: "appA" });
    upsertEntity(db, { kind: "library", name: "react-dom", repo: "appA" });
    upsertEntity(db, { kind: "tool", name: "npm", repo: "appA" });
    upsertEntity(db, { kind: "library", name: "vue", repo: "appB" });
    const libs = listEntities(db, { repo: "appA", kind: "library" });
    expect(libs.map((e) => e.name).sort()).toEqual(["react", "react-dom"]);
    const search = listEntities(db, { search: "vue" });
    expect(search.map((e) => e.name)).toEqual(["vue"]);
  });
});

describe("graph ingest", () => {
  let db: RecallDb;
  beforeEach(() => {
    db = freshDb();
  });

  it("ingests heuristic extraction end-to-end", () => {
    const memId = createMemory(db, {
      type: "rule",
      text: "We replaced `jsonwebtoken` with `jose` in `src/auth/middleware.ts`.",
      scope: "repo",
      repo: "recall",
      source: "correction",
    });
    const summary = ingestMemoryHeuristic(db, {
      id: memId,
      text: "We replaced `jsonwebtoken` with `jose` in `src/auth/middleware.ts`.",
      repo: "recall",
    });
    expect(summary.entities_created_or_updated).toBeGreaterThan(0);
    const linked = listEntitiesForMemory(db, memId);
    const names = linked.map((e) => e.name).sort();
    expect(names).toEqual(expect.arrayContaining(["jose", "jsonwebtoken", "src/auth/middleware.ts"]));
    expect(countRelations(db)).toBeGreaterThan(0);
  });

  it("is idempotent on re-ingest of the same memory text", () => {
    const memId = createMemory(db, {
      type: "rule",
      text: "Use `react`.",
      scope: "global",
      source: "manual",
    });
    ingestMemoryHeuristic(db, { id: memId, text: "Use `react`.", repo: null });
    const e1 = countEntities(db);
    const m1 = listEntitiesForMemory(db, memId).length;
    ingestMemoryHeuristic(db, { id: memId, text: "Use `react`.", repo: null });
    expect(countEntities(db)).toBe(e1);
    expect(listEntitiesForMemory(db, memId).length).toBe(m1);
    // mention_count should bump though
    const ent = listEntities(db, { search: "react" })[0];
    expect(getEntity(db, ent.id)!.mention_count).toBeGreaterThanOrEqual(2);
  });
});

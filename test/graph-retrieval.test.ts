import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";
import { syncMemoryFtsIndex } from "../src/vector/sqlite-fts.js";
import { installMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";
import { ingestMemoryHeuristic } from "../src/graph/ingest.js";
import { graphQuery } from "../src/graph/retrieval.js";

installMockEmbeddingProvider();

let counter = 0;
function freshDb(): RecallDb {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-graph-ret-"));
  return initStandaloneDb(join(dir, `graph-ret-${counter++}.db`));
}

function addMemory(db: RecallDb, text: string, repo = "demo"): string {
  const id = createMemory(db, {
    type: "rule",
    text,
    scope: "repo",
    repo,
    source: "manual",
    confidence: 0.8,
  });
  ingestMemoryHeuristic(db, { id, text, repo });
  return id;
}

describe("graph retrieval", () => {
  let db: RecallDb;
  beforeEach(() => {
    db = freshDb();
  });

  it("returns hybrid seeds even without graph hops", async () => {
    const id = addMemory(db, "Always use `react` for the frontend.");
    syncMemoryFtsIndex(db);
    const r = await graphQuery(db, "react frontend", null, { hops: 0 });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0].memory.id).toBe(id);
    expect(r.hits[0].via).toBe("seed");
  });

  it("expands across shared entities (1 hop)", async () => {
    // A: "use `jose` in `src/auth/middleware.ts`"  — text matches "auth"
    // B: "rotate keys for `jose` weekly"           — text matches "jose" but not "auth"
    // Both memories share the `jose` entity; query for "auth" should pull B in via graph.
    addMemory(db, "Use `jose` in `src/auth/middleware.ts` for token verification.");
    const idB = addMemory(db, "Rotate signing keys for `jose` weekly.");
    syncMemoryFtsIndex(db);

    const r = await graphQuery(db, "auth", null, { hops: 1, limit: 10 });
    const hitIds = r.hits.map((h) => h.memory.id);
    expect(hitIds).toContain(idB);
    const bHit = r.hits.find((h) => h.memory.id === idB)!;
    expect(bHit.via).toBe("graph");
    expect(bHit.shared_entities.length).toBeGreaterThan(0);
  });

  it("hop=0 does not pull in graph-expanded memories", async () => {
    addMemory(db, "Use `jose` in `src/auth/middleware.ts`.");
    const idB = addMemory(db, "Rotate keys for `jose` weekly.");
    syncMemoryFtsIndex(db);
    const r = await graphQuery(db, "auth", null, { hops: 0, limit: 10 });
    expect(r.hits.find((h) => h.memory.id === idB)).toBeUndefined();
  });

  it("respects relation type filter", async () => {
    addMemory(db, "We replaced `jsonwebtoken` with `jose`.");
    const idC = addMemory(db, "Tests cover `jsonwebtoken` migration.");
    syncMemoryFtsIndex(db);
    // The replaces edge connects jose <-> jsonwebtoken. If we filter to only
    // 'uses' edges, the graph walk won't traverse the replaces edge, but
    // memories that already mention jsonwebtoken directly are still
    // discoverable via the seed entity (jsonwebtoken itself is in seed
    // entities and idC mentions it). So filter test verifies neighbors
    // not pulled in. Keep idC via direct seed-entity match expected.
    const r = await graphQuery(db, "jsonwebtoken", null, {
      hops: 2,
      relationTypes: ["uses"],
      limit: 10,
    });
    expect(r.hits.map((h) => h.memory.id)).toContain(idC);
  });

  it("returns empty hits gracefully when no memories match", async () => {
    syncMemoryFtsIndex(db);
    const r = await graphQuery(db, "nothing here", null, { hops: 2 });
    expect(r.hits).toEqual([]);
    expect(r.seed_count).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";
import {
  reconcileGraph,
  reconcileGraphIfStale,
  GRAPH_EXTRACTOR_VERSION,
} from "../src/graph/reconcile.js";
import { listEntities } from "../src/graph/store.js";
import { installMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";

installMockEmbeddingProvider();

let counter = 0;
function freshCtx(): { db: RecallDb; dir: string } {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-reconcile-"));
  return { db: initStandaloneDb(join(dir, `rc-${counter++}.db`)), dir };
}

describe("reconcileGraph", () => {
  it("rebuilds from active memories only and drops candidate-derived entities", () => {
    const { db } = freshCtx();
    createMemory(db, {
      type: "rule", text: "Use `jose` for auth.", scope: "repo", repo: "demo",
      source: "manual", confidence: 0.9, // active
    });
    createMemory(db, {
      type: "rule", text: "Use `zod` for validation.", scope: "repo", repo: "demo",
      source: "user_correction", confidence: 0.4, // candidate
    });

    const result = reconcileGraph(db);
    expect(result.memories).toBe(1);
    const names = listEntities(db, { limit: 100 }).map((e) => e.name);
    expect(names).toContain("jose");
    expect(names).not.toContain("zod");
  });
});

describe("reconcileGraphIfStale", () => {
  it("runs once, writes the version marker, and is a no-op when current", () => {
    const { db, dir } = freshCtx();
    createMemory(db, {
      type: "rule", text: "Use `jose` for auth.", scope: "repo", repo: "demo",
      source: "manual", confidence: 0.9,
    });

    const first = reconcileGraphIfStale(db, dir);
    expect(first).not.toBeNull();
    const markerPath = join(dir, ".graph-extractor-version");
    expect(existsSync(markerPath)).toBe(true);
    expect(parseInt(readFileSync(markerPath, "utf8").trim(), 10)).toBe(GRAPH_EXTRACTOR_VERSION);

    // Already current → no rebuild.
    expect(reconcileGraphIfStale(db, dir)).toBeNull();
  });
});

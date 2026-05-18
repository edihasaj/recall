import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";
import { safeIngestMemoryById } from "../src/graph/ingest.js";
import { listEntitiesForMemory } from "../src/graph/store.js";
import { installMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";

installMockEmbeddingProvider();

let counter = 0;
function freshDb(): RecallDb {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-safe-ingest-"));
  return initStandaloneDb(join(dir, `si-${counter++}.db`));
}

describe("safeIngestMemoryById", () => {
  let db: RecallDb;
  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ingests entities for a real memory id", () => {
    const id = createMemory(db, {
      type: "rule",
      text: "Use `jose` in `src/auth/middleware.ts`.",
      scope: "repo",
      repo: "demo",
      source: "manual",
    });
    const summary = safeIngestMemoryById(db, id);
    expect(summary).not.toBeNull();
    expect(summary!.entities_created_or_updated).toBeGreaterThan(0);
    const names = listEntitiesForMemory(db, id).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["jose", "src/auth/middleware.ts"]));
  });

  it("returns null for an unknown memory id (no throw)", () => {
    expect(safeIngestMemoryById(db, "nope")).toBeNull();
  });

  it("swallows downstream errors and logs without throwing", () => {
    const id = createMemory(db, {
      type: "rule",
      text: "Use `react`.",
      scope: "global",
      source: "manual",
    });
    // Close the underlying sqlite handle to force every subsequent statement
    // to throw, simulating a "graph extraction blew up" failure inside the
    // helper.
    (db as any).$client.close();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = safeIngestMemoryById(db, id);
    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(`graph ingest failed for ${id}`),
      expect.anything(),
    );
  });
});

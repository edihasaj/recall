import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq, sql } from "drizzle-orm";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";
import { memories } from "../src/db/schema.js";
import { memoryDedupeKey } from "../src/models/dedupe.js";

let dbCounter = 0;
function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-dedupe-race-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

afterEach(() => {
  delete process.env.RECALL_EMBEDDINGS_DISABLED;
});

describe("createMemory dedupe_key conflict safety", () => {
  const base = {
    type: "command" as const,
    text: "Use pnpm as the package manager",
    scope: "repo" as const,
    repo: "edihasaj/recall",
    source: "config_parse" as const,
    confidence: 0.65,
  };

  it("returns the existing id instead of throwing when the dedupe_key is already taken", () => {
    const db = freshDb();
    const first = createMemory(db, base);

    // Simulate the TOCTOU race / stale-key state: a row already holds the
    // dedupe_key but the pre-check SELECT (status != 'rejected') skips it.
    // Before the onConflictDoNothing fix this second insert threw
    // "UNIQUE constraint failed: memories.dedupe_key" and crashed the hook.
    const key = memoryDedupeKey({
      type: base.type,
      scope: base.scope,
      repo: base.repo,
      path_scope: null,
      text: base.text,
    });
    db.update(memories)
      .set({ status: "rejected" })
      .where(sql`${memories.dedupe_key} = ${key}`)
      .run();

    let second: string | undefined;
    expect(() => {
      second = createMemory(db, base);
    }).not.toThrow();

    expect(second).toBe(first);
    // No duplicate row was written for that key.
    const rows = db.select().from(memories).where(eq(memories.dedupe_key, key)).all();
    expect(rows).toHaveLength(1);
  });

  it("is idempotent: repeated identical captures return the same id", () => {
    const db = freshDb();
    const a = createMemory(db, base);
    const b = createMemory(db, base);
    expect(b).toBe(a);
  });
});

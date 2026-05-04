import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory, getMemory, demoteGlobalMemory } from "../src/models/memory.js";
import { memories } from "../src/db/schema.js";

function dedupeKeyOf(db: ReturnType<typeof initStandaloneDb>, id: string): string | null | undefined {
  return db.select({ k: memories.dedupe_key }).from(memories).where(eq(memories.id, id)).get()?.k;
}

let dbCounter = 0;
function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-demote-global-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

describe("demoteGlobalMemory", () => {
  it("re-scopes a global memory to a single repo when repo is provided", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "Use eslint .",
      scope: "global",
      source: "user_correction",
      confidence: 0.7,
    });

    const result = demoteGlobalMemory(db, id, { repo: "edihasaj/recall" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("rescoped");

    const after = getMemory(db, id)!;
    expect(after.scope).toBe("repo");
    expect(after.repo).toBe("edihasaj/recall");
    expect(after.status).not.toBe("rejected");
    expect(dedupeKeyOf(db, id)).toBeTruthy();
  });

  it("rejects a global memory when no repo target is given", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "Use eslint .",
      scope: "global",
      source: "user_correction",
      confidence: 0.7,
    });

    const result = demoteGlobalMemory(db, id, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("rejected");

    const after = getMemory(db, id)!;
    expect(after.status).toBe("rejected");
    expect(after.confidence).toBe(0);
    expect(dedupeKeyOf(db, id)).toBeNull();
  });

  it("refuses to demote a non-global memory", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "Use uv",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.7,
    });

    const result = demoteGlobalMemory(db, id, { repo: "edihasaj/recall" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_global");
  });

  it("returns not_found for unknown memory ids", () => {
    const db = freshDb();
    const result = demoteGlobalMemory(db, "does-not-exist", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
  });

  it("treats whitespace-only repo as no target (rejects instead of rescoping)", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "Use eslint .",
      scope: "global",
      source: "user_correction",
      confidence: 0.7,
    });

    const result = demoteGlobalMemory(db, id, { repo: "   " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("rejected");
  });
});

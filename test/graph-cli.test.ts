import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";
import { ingestMemoryHeuristic } from "../src/graph/ingest.js";
import { syncMemoryFtsIndex } from "../src/vector/sqlite-fts.js";

const tsxBin = resolve(process.cwd(), "node_modules/.bin/tsx");
const cliEntry = resolve(process.cwd(), "src/cli.ts");

let dataDir = "";

function runCli(args: string[]) {
  const r = spawnSync(tsxBin, [cliEntry, ...args], {
    env: {
      ...process.env,
      RECALL_DATA_DIR: dataDir,
      RECALL_EMBEDDINGS_DISABLED: "true",
    },
    encoding: "utf8",
  });
  return r;
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "recall-cli-graph-"));
  // CLI's getDbPath() uses RECALL_DATA_DIR directly + "recall.db".
  const dbPath = join(dataDir, "recall.db");
  const db = initStandaloneDb(dbPath);
  const id1 = createMemory(db, {
    type: "rule",
    text: "Use `jose` in `src/auth/middleware.ts` for token verification.",
    scope: "repo",
    repo: "edihasaj/recall-cli-test",
    source: "manual",
    confidence: 0.8,
  });
  const id2 = createMemory(db, {
    type: "rule",
    text: "Rotate signing keys for `jose` weekly.",
    scope: "repo",
    repo: "edihasaj/recall-cli-test",
    source: "manual",
    confidence: 0.8,
  });
  ingestMemoryHeuristic(db, {
    id: id1,
    text: "Use `jose` in `src/auth/middleware.ts` for token verification.",
    repo: "edihasaj/recall-cli-test",
  });
  ingestMemoryHeuristic(db, {
    id: id2,
    text: "Rotate signing keys for `jose` weekly.",
    repo: "edihasaj/recall-cli-test",
  });
  syncMemoryFtsIndex(db);
});

describe("recall graph CLI", () => {
  it("graph stats prints entity/relation counts", () => {
    const r = runCli(["graph", "stats"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/entities:\s+\d+/);
    expect(r.stdout).toMatch(/relations:\s+\d+/);
    // We seeded at least 2 memories, each with multiple entities.
    const ents = parseInt(r.stdout.match(/entities:\s+(\d+)/)![1]!, 10);
    expect(ents).toBeGreaterThan(0);
  });

  it("graph entities lists entities, with --search filter", () => {
    const all = runCli(["graph", "entities"]);
    expect(all.status).toBe(0);
    expect(all.stdout).toMatch(/jose/);

    const filtered = runCli(["graph", "entities", "--search", "middleware"]);
    expect(filtered.status).toBe(0);
    expect(filtered.stdout).toMatch(/middleware/);
    expect(filtered.stdout).not.toMatch(/^\s*\d+\s+library\s+jose\s*$/m);
  });

  it("graph entities --kind library only shows libraries", () => {
    const r = runCli(["graph", "entities", "--kind", "library"]);
    expect(r.status).toBe(0);
    // Every non-empty line should mention "library" as the kind column.
    for (const line of r.stdout.split("\n").filter((l) => l.trim())) {
      expect(line).toMatch(/library/);
    }
  });

  it("graph query returns hits for a seeded keyword", () => {
    const r = runCli(["graph", "query", "auth"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/seeds=/);
    expect(r.stdout).toMatch(/expanded_entities=/);
    // At least one hit row.
    expect(r.stdout).toMatch(/\[(seed|graph)\d\]/);
  });

  it("graph backfill is idempotent on the seeded DB", () => {
    const first = runCli(["graph", "backfill"]);
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/Processed \d+ memories/);
    const second = runCli(["graph", "backfill"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/Processed \d+ memories/);
  });
});

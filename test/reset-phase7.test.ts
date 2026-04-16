import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEmbeddingCacheRoot } from "../src/embeddings/cache.js";
import { closeDb, getDbUserVersion, initStandaloneDb, RECALL_DB_USER_VERSION, resetDb } from "../src/db/client.js";
import { queryMemories } from "../src/models/memory.js";
import { runDestructiveResetRollout } from "../src/reset/rollout.js";
import { installMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";

function makeRepo(root: string, remote: string) {
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], {
    cwd: root,
    stdio: "ignore",
  });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: {
        test: "vitest run",
        build: "tsup",
      },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  delete process.env.HOME;
  delete process.env.RECALL_EMBEDDINGS_DISABLED;
  delete process.env.RECALL_EMBEDDING_DIMS;
  delete process.env.RECALL_EMBEDDING_VERSION;
});

describe("phase 7 destructive reset rollout", () => {
  it("purges cached embedding models when requested", () => {
    const home = join(tmpdir(), `recall-phase7-purge-${Date.now()}`);
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;

    const dbPath = join(home, ".recall", "purge.db");
    mkdirSync(join(home, ".recall"), { recursive: true });
    writeFileSync(dbPath, "db");

    const cacheRoot = getEmbeddingCacheRoot();
    mkdirSync(join(cacheRoot, "nomic", "nomic-ai", "nomic-embed-text-v1.5"), { recursive: true });
    writeFileSync(join(cacheRoot, "nomic", "nomic-ai", "nomic-embed-text-v1.5", "weights.bin"), "model");

    resetDb(dbPath, { purgeModels: true });

    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(cacheRoot)).toBe(false);
  });

  it("rescans discovered repos and bootstraps embeddings on schema upgrade", async () => {
    const home = join(tmpdir(), `recall-phase7-home-${Date.now()}`);
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;

    const searchRoot = join(home, "Projects");
    const repoRoot = join(searchRoot, "edihasaj", "phase7-reset");
    makeRepo(repoRoot, "https://github.com/edihasaj/phase7-reset.git");

    const dbPath = join(home, ".recall", "rollout.db");
    mkdirSync(join(home, ".recall"), { recursive: true });
    const db = initStandaloneDb(dbPath);
    db.$client.pragma("user_version = 0");
    db.$client.close();

    installMockEmbeddingProvider((text) => (
      text.toLowerCase().includes("pnpm") ? [1, 0, 0] : [0, 0, 1]
    ));
    process.env.RECALL_EMBEDDING_DIMS = "3";
    process.env.RECALL_EMBEDDING_VERSION = "phase7-test";

    const result = await runDestructiveResetRollout({
      dbPath,
      searchRoots: [searchRoot],
    });

    expect(result.result).toMatchObject({
      performed: true,
      reason: "schema_upgrade",
      previous_user_version: 0,
      target_user_version: RECALL_DB_USER_VERSION,
      repos_scanned: 1,
    });
    expect(result.result.memories_created).toBeGreaterThan(0);
    expect(result.result.embeddings_bootstrapped).toBeGreaterThan(0);
    expect(queryMemories(result.db, { repo: "edihasaj/phase7-reset" }).length).toBeGreaterThan(0);
    expect(getDbUserVersion(dbPath)).toBe(RECALL_DB_USER_VERSION);
  });
});

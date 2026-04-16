import { beforeEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { queryMemories } from "../src/models/memory.js";
import {
  ensureRepoBootstrapped,
  inferRepoSlugFromPath,
  resolveLocalRepoPath,
} from "../src/repo/discovery.js";

let dbCounter = 0;

beforeEach(() => {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
});

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-discovery-db-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

function makeRepo(root: string, remote: string, packageJson = true) {
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], {
    cwd: root,
    stdio: "ignore",
  });
  if (packageJson) {
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
}

describe("repo discovery", () => {
  it("infers repo slug from a local git path", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "recall-discovery-path-"));
    makeRepo(repoRoot, "https://github.com/edihasaj/zapfeed.io.git", false);

    expect(inferRepoSlugFromPath(repoRoot)).toBe("edihasaj/zapfeed.io");
  });

  it("resolves a local clone by remote slug", () => {
    const searchRoot = mkdtempSync(join(tmpdir(), "recall-discovery-search-"));
    const repoRoot = join(searchRoot, "scriptix", "realtime");
    makeRepo(repoRoot, "git@github.com:scriptix/realtime.git", false);

    expect(
      resolveLocalRepoPath("scriptix/realtime", { searchRoots: [searchRoot] }),
    ).toBe(repoRoot);
  });

  it("bootstraps an unseen repo from a direct path hint", () => {
    const db = freshDb();
    const repoRoot = mkdtempSync(join(tmpdir(), "recall-discovery-bootstrap-"));
    makeRepo(repoRoot, "https://github.com/edihasaj/recall-auto.git");

    const result = ensureRepoBootstrapped(db, {
      repo: "edihasaj/recall-auto",
      repoPathHint: repoRoot,
    });

    expect(result.status).toBe("bootstrapped");
    expect(result.repo_path?.endsWith(repoRoot)).toBe(true);
    expect(queryMemories(db, { repo: "edihasaj/recall-auto" }).length).toBeGreaterThan(0);
  });

  it("does not rescan a repo that already has memories", () => {
    const db = freshDb();
    const repoRoot = mkdtempSync(join(tmpdir(), "recall-discovery-repeat-"));
    makeRepo(repoRoot, "https://github.com/edihasaj/repeat.git");

    const first = ensureRepoBootstrapped(db, {
      repo: "edihasaj/repeat",
      repoPathHint: repoRoot,
    });
    const second = ensureRepoBootstrapped(db, {
      repo: "edihasaj/repeat",
      repoPathHint: repoRoot,
    });

    expect(first.status).toBe("bootstrapped");
    expect(second.status).toBe("already_known");
    expect(second.created_ids).toHaveLength(0);
  });
});

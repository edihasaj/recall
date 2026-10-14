import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Simulate a hook host where `git` is not on PATH: every execFileSync of a git
// binary throws ENOENT. Fixtures are built with spawnSync, which stays real.
const gitState = vi.hoisted(() => ({ missing: false }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFileSync = ((file: string, ...rest: unknown[]) => {
    if (gitState.missing && /(^|\/)git$/.test(String(file))) {
      const error = new Error(`spawnSync ${file} ENOENT`) as Error & { code?: string };
      error.code = "ENOENT";
      throw error;
    }
    return (actual.execFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.execFileSync;
  return { ...actual, execFileSync };
});

import { closeDb, initStandaloneDb } from "../src/db/client.js";
import { createActivityEvent } from "../src/models/activity.js";
import { createMemory } from "../src/models/memory.js";
import { canonicalizeRepoSlug } from "../src/repo/aliases.js";
import { inferRepoSlugFromPath } from "../src/repo/discovery.js";
import {
  findGitRoot,
  isUnscopedSessionPath,
  parseRemoteUrl,
  readOriginUrl,
} from "../src/repo/git-root.js";
import { computeReliabilityReport, formatReliabilityReport } from "../src/reliability/report.js";

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function makeRepo(root: string, remote?: string): string {
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Recall Test"]);
  if (remote) git(root, ["remote", "add", "origin", remote]);
  return realpathSync(root);
}

function makeWorktree(repoRoot: string, worktreePath: string): string {
  writeFileSync(join(repoRoot, "README.md"), "fixture\n");
  git(repoRoot, ["add", "README.md"]);
  git(repoRoot, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  git(repoRoot, ["worktree", "add", "-q", "-b", "feature", worktreePath]);
  return realpathSync(worktreePath);
}

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function freshDb() {
  return initStandaloneDb(join(tempDir("recall-attribution-db-"), "recall.db"));
}

beforeEach(() => {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  gitState.missing = false;
});

afterEach(() => {
  gitState.missing = false;
  closeDb();
  delete process.env.RECALL_EMBEDDINGS_DISABLED;
});

describe("parseRemoteUrl", () => {
  it("reads origin and ignores other remotes and comments", () => {
    const config = [
      "[core]",
      "\tbare = false",
      "[remote \"upstream\"]",
      "\turl = https://github.com/other/fork.git",
      "; comment",
      "[remote \"origin\"]",
      "\turl = \"git@github.com:edihasaj/oktapod.git\"",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    ].join("\n");
    expect(parseRemoteUrl(config, "origin")).toBe("git@github.com:edihasaj/oktapod.git");
    expect(parseRemoteUrl(config, "upstream")).toBe("https://github.com/other/fork.git");
    expect(parseRemoteUrl(config, "missing")).toBeNull();
  });
});

describe("findGitRoot / readOriginUrl", () => {
  it("walks up from a subdirectory and reads origin without git", () => {
    const root = makeRepo(join(tempDir("recall-attr-sub-"), "repo"), "https://github.com/edihasaj/recall.git");
    const nested = join(root, "src", "deep");
    mkdirSync(nested, { recursive: true });
    const info = findGitRoot(nested);
    expect(info?.root).toBe(root);
    expect(info ? readOriginUrl(info) : null).toBe("https://github.com/edihasaj/recall.git");
  });

  it("returns null outside a checkout and for a missing path", () => {
    expect(findGitRoot(tempDir("recall-attr-nogit-"))).toBeNull();
    expect(findGitRoot("/definitely/not/a/real/path/recall")).toBeNull();
  });

  it("resolves a linked worktree's .git file to the shared config", () => {
    const base = tempDir("recall-attr-wt-");
    const root = makeRepo(join(base, "main"), "git@github.com:dayshape/dayshape.git");
    const worktree = makeWorktree(root, join(base, "DEVO-1-feature"));
    const info = findGitRoot(worktree);
    expect(info?.root).toBe(worktree);
    expect(info?.gitDir).not.toBe(info?.commonDir);
    expect(info ? readOriginUrl(info) : null).toBe("git@github.com:dayshape/dayshape.git");
  });
});

describe("inferRepoSlugFromPath without git on PATH", () => {
  it("keeps owner/name for HTTPS, SSH, subdirectories and worktrees", () => {
    const base = tempDir("recall-attr-nopath-");
    const https = makeRepo(join(base, "oktapod"), "https://github.com/edihasaj/oktapod.git");
    const ssh = makeRepo(join(base, "eunify"), "git@github.com:EUnifyer/eunify.git");
    const sshWorktree = makeWorktree(ssh, join(base, "eunify-wt"));
    mkdirSync(join(https, "apps", "core"), { recursive: true });

    gitState.missing = true;
    expect(inferRepoSlugFromPath(https)).toBe("edihasaj/oktapod");
    expect(inferRepoSlugFromPath(join(https, "apps", "core"))).toBe("edihasaj/oktapod");
    expect(inferRepoSlugFromPath(ssh)).toBe("EUnifyer/eunify");
    expect(inferRepoSlugFromPath(sshWorktree)).toBe("EUnifyer/eunify");
  });

  it("falls back to the basename only when the checkout has no origin", () => {
    const local = makeRepo(join(tempDir("recall-attr-local-"), "scratch"));
    gitState.missing = true;
    expect(inferRepoSlugFromPath(local)).toBe("scratch");
    expect(inferRepoSlugFromPath(tempDir("recall-attr-plain-"))).toBeNull();
  });
});

describe("isUnscopedSessionPath", () => {
  it("treats an org folder of clones as unscoped and the clones as scoped", () => {
    const org = tempDir("recall-attr-org-");
    const clone = makeRepo(join(org, "api-scriptix"), "https://github.com/scriptix-io/api-scriptix.git");
    mkdirSync(join(clone, "src"), { recursive: true });
    expect(isUnscopedSessionPath(org)).toBe(true);
    expect(isUnscopedSessionPath(clone)).toBe(false);
    expect(isUnscopedSessionPath(join(clone, "src"))).toBe(false);
  });

  it("treats the filesystem root, home-shaped and app paths as unscoped", () => {
    expect(isUnscopedSessionPath("")).toBe(true);
    expect(isUnscopedSessionPath("/")).toBe(true);
    expect(isUnscopedSessionPath("/Users/nobody-recall-test")).toBe(true);
    expect(isUnscopedSessionPath("/Users/nobody-recall-test/Projects")).toBe(true);
    expect(isUnscopedSessionPath("/Users/nobody-recall-test/Library/Application Support/Gateway")).toBe(true);
  });

  it("keeps the historical shape rules for paths that no longer exist", () => {
    expect(isUnscopedSessionPath("/Users/test/Projects/unresolved-repo")).toBe(false);
    expect(isUnscopedSessionPath("/private/var/folders/ab/cdef/T/gateway-codex-x1")).toBe(true);
    expect(isUnscopedSessionPath("/tmp/recall-gone-fixture")).toBe(true);
  });
});

describe("reliability report session scope", () => {
  it("does not count unscoped cwds against repo attribution and reports them", () => {
    const db = freshDb();
    const org = tempDir("recall-attr-report-");
    const attributed = makeRepo(join(org, "dayshape"), "https://github.com/dayshape/dayshape.git");
    const unattributed = makeRepo(join(org, "other"), "https://github.com/dayshape/other.git");
    const events: Array<{ id: string; repo: string | null; path: string }> = [
      { id: "s-attributed", repo: "dayshape/dayshape", path: attributed },
      { id: "s-org", repo: null, path: org },
      { id: "s-root", repo: null, path: "/" },
      { id: "s-missed", repo: null, path: unattributed },
    ];
    for (const event of events) {
      createActivityEvent(db, {
        session_id: event.id,
        repo: event.repo,
        source: "hook:codex",
        event_type: "session_start",
        request: { repo_path: event.path },
      });
    }

    const report = computeReliabilityReport(db, { since: "2000-01-01T00:00:00.000Z" });
    expect(report.sessions).toBe(4);
    expect(report.sessions_requiring_repo).toBe(2);
    expect(report.sessions_with_repo).toBe(1);
    expect(report.sessions_unscoped).toBe(2);
    expect(report.repo_attribution_rate).toBe(0.5);
    expect(report.unscoped_top_paths.map((entry) => entry.path).sort()).toEqual(["/", org].sort());
    expect(report.checks.find((check) => check.name === "session_scope_coverage")?.status).toBe("pass");
    const text = formatReliabilityReport(report);
    expect(text).toContain("2 unscoped");
    expect(text).toContain("Unscoped cwd");
  });

  it("warns when most sessions start outside any checkout", () => {
    const db = freshDb();
    const org = tempDir("recall-attr-warn-");
    const clone = makeRepo(join(org, "repo"), "https://github.com/edihasaj/repo.git");
    createActivityEvent(db, {
      session_id: "w-1",
      repo: "edihasaj/repo",
      source: "hook:codex",
      event_type: "session_start",
      request: { repo_path: clone },
    });
    for (const id of ["w-2", "w-3", "w-4"]) {
      createActivityEvent(db, {
        session_id: id,
        repo: null,
        source: "hook:codex",
        event_type: "session_start",
        request: { repo_path: org },
      });
    }
    const report = computeReliabilityReport(db, { since: "2000-01-01T00:00:00.000Z" });
    expect(report.repo_attribution_rate).toBe(1);
    expect(report.checks.find((check) => check.name === "repo_attribution")?.status).toBe("pass");
    expect(report.checks.find((check) => check.name === "session_scope_coverage")?.status).toBe("warn");
    expect(report.unscoped_top_paths).toEqual([{ path: org, sessions: 3 }]);
  });
});

describe("canonicalizeRepoSlug", () => {
  it("normalizes agent-supplied repo names without merging owners", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "Keep oktapod separate from Recall.",
      scope: "repo",
      repo: "edihasaj/oktapod",
      source: "user_correction",
      confidence: 0.8,
    });
    createMemory(db, { type: "rule", text: "Rule for one eunify.", scope: "repo", repo: "EUnifyer/eunify", source: "user_correction", confidence: 0.8 });
    createMemory(db, { type: "rule", text: "Rule for another eunify.", scope: "repo", repo: "someone/eunify", source: "user_correction", confidence: 0.8 });

    expect(canonicalizeRepoSlug(db, "oktapod")).toBe("edihasaj/oktapod");
    expect(canonicalizeRepoSlug(db, "edihasaj/oktapod")).toBe("edihasaj/oktapod");
    expect(canonicalizeRepoSlug(db, "https://github.com/edihasaj/oktapod.git")).toBe("edihasaj/oktapod");
    expect(canonicalizeRepoSlug(db, "git@github.com:edihasaj/oktapod.git")).toBe("edihasaj/oktapod");
    expect(canonicalizeRepoSlug(db, "eunify")).toBe("eunify");
    expect(canonicalizeRepoSlug(db, "scriptix")).toBe("scriptix");
    expect(canonicalizeRepoSlug(db, "Projects")).toBeNull();
    expect(canonicalizeRepoSlug(db, "  ")).toBeNull();
    expect(canonicalizeRepoSlug(db, null)).toBeNull();
  });
});

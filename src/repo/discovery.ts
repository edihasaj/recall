import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import type { RecallDb } from "../db/client.js";
import { queryMemories } from "../models/memory.js";
import { scanAndStore } from "../scanner/repo.js";

const repoPathCache = new Map<string, string | null>();
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".venv",
  "venv",
]);

export interface RepoBootstrapOptions {
  repo?: string | null;
  repoPathHint?: string | null;
  searchRoots?: string[];
}

export interface RepoBootstrapResult {
  repo: string | null;
  repo_path: string | null;
  created_ids: string[];
  status:
    | "skipped"
    | "already_known"
    | "bootstrapped"
    | "scanned_empty"
    | "unresolved";
}

export interface DiscoveredRepo {
  repo: string | null;
  repo_path: string;
}

export function ensureRepoBootstrapped(
  db: RecallDb,
  opts: RepoBootstrapOptions,
): RepoBootstrapResult {
  const repo = normalizeRepoSlug(opts.repo);
  const repoPathHint = opts.repoPathHint ?? null;

  if (!repo && !repoPathHint) {
    return {
      repo: null,
      repo_path: null,
      created_ids: [],
      status: "skipped",
    };
  }

  const resolvedRepo = repo ?? inferRepoSlugFromPath(repoPathHint);
  if (!resolvedRepo) {
    return {
      repo: null,
      repo_path: null,
      created_ids: [],
      status: "unresolved",
    };
  }

  if (queryMemories(db, { repo: resolvedRepo }).length > 0) {
    return {
      repo: resolvedRepo,
      repo_path: null,
      created_ids: [],
      status: "already_known",
    };
  }

  const repoPath = resolveLocalRepoPath(resolvedRepo, {
    repoPathHint,
    searchRoots: opts.searchRoots,
  });
  if (!repoPath) {
    return {
      repo: resolvedRepo,
      repo_path: null,
      created_ids: [],
      status: "unresolved",
    };
  }

  const createdIds = scanAndStore(db, repoPath);
  return {
    repo: resolvedRepo,
    repo_path: repoPath,
    created_ids: createdIds,
    status: createdIds.length > 0 ? "bootstrapped" : "scanned_empty",
  };
}

export function resolveLocalRepoPath(
  repo: string,
  opts: Omit<RepoBootstrapOptions, "repo"> = {},
): string | null {
  const normalizedRepo = normalizeRepoSlug(repo);
  if (!normalizedRepo) return null;

  if (repoPathCache.has(normalizedRepo)) {
    return repoPathCache.get(normalizedRepo) ?? null;
  }

  const directHint = normalizeRepoPathHint(opts.repoPathHint);
  if (directHint && pathMatchesRepo(directHint, normalizedRepo)) {
    repoPathCache.set(normalizedRepo, directHint);
    return directHint;
  }

  const candidates = collectCandidateRepos(opts.searchRoots ?? getDefaultSearchRoots());
  const basenameMatches: string[] = [];

  for (const candidate of candidates) {
    const candidateRepo = inferRepoSlugFromPath(candidate);
    if (candidateRepo === normalizedRepo) {
      repoPathCache.set(normalizedRepo, candidate);
      return candidate;
    }
    if (candidate.endsWith(`/${normalizedRepo.split("/").at(-1)}`)) {
      basenameMatches.push(candidate);
    }
  }

  const fallback = basenameMatches.length === 1 ? basenameMatches[0] : null;
  repoPathCache.set(normalizedRepo, fallback);
  return fallback;
}

export function inferRepoSlugFromPath(repoPath?: string | null): string | null {
  const root = normalizeRepoPathHint(repoPath);
  if (!root) return null;

  try {
    const remote = execFileSync(
      "git",
      ["-C", root, "remote", "get-url", "origin"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return extractRepoSlugFromRemote(remote);
  } catch {
    const parts = root.split("/").filter(Boolean);
    return parts.at(-1) ?? null;
  }
}

export function discoverLocalRepos(searchRoots?: string[]): DiscoveredRepo[] {
  const seen = new Set<string>();
  const repos: DiscoveredRepo[] = [];

  for (const repoPath of collectCandidateRepos(searchRoots ?? getDefaultSearchRoots())) {
    const repo = inferRepoSlugFromPath(repoPath);
    const key = `${repo ?? "-"}::${repoPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push({ repo, repo_path: repoPath });
  }

  return repos;
}

export function extractRepoSlugFromRemote(remote: string): string | null {
  const trimmed = remote.trim().replace(/\.git$/, "");
  const parts = trimmed.split(/[:/]/).filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts.at(-2)}/${parts.at(-1)}`;
}

function pathMatchesRepo(repoPath: string, repo: string): boolean {
  const inferred = inferRepoSlugFromPath(repoPath);
  if (inferred === repo) return true;
  return repoPath.endsWith(`/${repo.split("/").at(-1)}`);
}

function normalizeRepoSlug(repo?: string | null): string | null {
  if (!repo) return null;
  const trimmed = repo.trim().replace(/\.git$/, "").replace(/^https?:\/\/[^/]+\//, "");
  if (!trimmed.includes("/")) return null;
  return trimmed.replace(/^git@[^:]+:/, "");
}

function normalizeRepoPathHint(repoPath?: string | null): string | null {
  if (!repoPath) return null;
  const expanded = repoPath.trim().replace(/^~(?=\/)/, process.env.HOME ?? "~");
  try {
    const root = execFileSync(
      "git",
      ["-C", expanded, "rev-parse", "--show-toplevel"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return root || null;
  } catch {
    const resolved = resolve(expanded);
    return existsSync(join(resolved, ".git")) ? resolved : null;
  }
}

function getDefaultSearchRoots(): string[] {
  const configured = process.env.RECALL_REPO_ROOTS
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured?.length) return configured;

  const home = process.env.HOME ?? process.cwd();
  return [join(home, "Projects")];
}

function collectCandidateRepos(searchRoots: string[]): string[] {
  const seen = new Set<string>();
  const repos: string[] = [];

  for (const root of searchRoots) {
    walkRepos(resolve(root), 4, seen, repos);
  }

  return repos;
}

function walkRepos(
  dir: string,
  depthRemaining: number,
  seen: Set<string>,
  repos: string[],
): void {
  if (depthRemaining < 0 || seen.has(dir) || !existsSync(dir)) return;
  seen.add(dir);

  if (existsSync(join(dir, ".git"))) {
    repos.push(dir);
    return;
  }

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    walkRepos(join(dir, entry.name), depthRemaining - 1, seen, repos);
  }
}

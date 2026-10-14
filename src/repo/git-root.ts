import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Git work-tree discovery without spawning `git`.
 *
 * Desktop agents launch Recall hooks with a minimal PATH, and on some hosts
 * `git` is not on it. The resolver used to fall back to the directory
 * basename when `git remote get-url origin` failed, so the same checkout was
 * recorded as `oktapod` on one device and `edihasaj/oktapod` on another.
 * Reading `.git/config` directly makes the slug independent of PATH, and the
 * same walk tells the reliability report whether a session's cwd could have
 * belonged to a repository at all.
 */
export interface GitRootInfo {
  /** Top-level work-tree directory (realpath). */
  root: string;
  /** Git directory of this checkout; for a linked worktree, its private gitdir. */
  gitDir: string;
  /** Shared git directory (`commondir`); equals `gitDir` for a primary checkout. */
  commonDir: string;
}

const MAX_WALK_DEPTH = 64;
const TEMP_RE = /\/(?:private\/)?(?:var\/folders\/[^/]+\/[^/]+\/T|tmp)(?:\/|$)/;
const HOME_RE = /^\/(?:Users|home)\/[^/]+$/;

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readTrimmed(path: string): string | null {
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return null;
  }
}

function resolveCommonDir(gitDir: string): string {
  const pointer = readTrimmed(join(gitDir, "commondir"));
  if (!pointer) return gitDir;
  const common = isAbsolute(pointer) ? pointer : resolve(gitDir, pointer);
  return safeRealpath(common) ?? common;
}

/** Resolve a `.git` entry (a directory, or a `gitdir: …` pointer file) to gitdir + commondir. */
function resolveGitEntry(root: string, entry: string): Pick<GitRootInfo, "gitDir" | "commonDir"> | null {
  if (isDirectory(entry)) {
    const gitDir = safeRealpath(entry) ?? entry;
    return { gitDir, commonDir: resolveCommonDir(gitDir) };
  }
  if (!isFile(entry)) return null;
  const match = readTrimmed(entry)?.match(/^gitdir:\s*(.+)$/m);
  if (!match) return null;
  const target = match[1].trim();
  const gitDirRaw = isAbsolute(target) ? target : resolve(root, target);
  if (!isDirectory(gitDirRaw)) return null;
  const gitDir = safeRealpath(gitDirRaw) ?? gitDirRaw;
  return { gitDir, commonDir: resolveCommonDir(gitDir) };
}

/**
 * Walk up from `startPath` to the nearest ancestor that holds a `.git`
 * entry. Returns null when the path does not exist or no ancestor is a git
 * checkout. Never spawns a process.
 */
export function findGitRoot(startPath: string): GitRootInfo | null {
  const real = safeRealpath(startPath);
  if (!real) return null;
  let current = isDirectory(real) ? real : dirname(real);
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    const entry = join(current, ".git");
    if (existsSync(entry)) {
      const resolved = resolveGitEntry(current, entry);
      if (resolved) return { root: current, ...resolved };
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export function isInsideGitWorkTree(path: string): boolean {
  return findGitRoot(path) !== null;
}

/** Minimal INI reader for git config: the `url` under `[remote "<name>"]`. */
export function parseRemoteUrl(config: string, remoteName: string): string | null {
  let inRemote = false;
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      const named = section[1].trim().match(/^remote\s+"(.+)"$/);
      inRemote = Boolean(named && named[1] === remoteName);
      continue;
    }
    if (!inRemote) continue;
    const url = line.match(/^url\s*=\s*(.+)$/);
    if (url) return url[1].trim().replace(/^"(.*)"$/, "$1");
  }
  return null;
}

/**
 * `remote.origin.url` read from the checkout's config files. A linked
 * worktree keeps its remotes in the shared `commondir` config; the
 * per-worktree files are consulted first so a worktree-local override wins.
 */
export function readOriginUrl(info: GitRootInfo): string | null {
  const candidates = info.gitDir === info.commonDir
    ? [join(info.gitDir, "config")]
    : [join(info.gitDir, "config.worktree"), join(info.gitDir, "config"), join(info.commonDir, "config")];
  for (const file of candidates) {
    const content = readTrimmed(file);
    if (!content) continue;
    const url = parseRemoteUrl(content, "origin");
    if (url) return url;
  }
  return null;
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

/**
 * True when a session's cwd cannot belong to a repository, so the
 * reliability report counts the session as unscoped instead of as an
 * attribution failure. An existing directory is unscoped when no ancestor is
 * a git checkout — the filesystem root, the home directory, `~/Projects`, an
 * org folder that merely contains clones, app-support paths. A temporary
 * directory is unscoped unless it is itself a checkout (test fixtures and
 * probe clones are). For a path that no longer exists, the shape decides.
 */
export function isUnscopedSessionPath(repoPath: string): boolean {
  const normalized = normalizeSlashes(repoPath.trim());
  if (normalized.length === 0) return true;
  if (TEMP_RE.test(normalized)) return !isInsideGitWorkTree(normalized);
  if (existsSync(normalized)) return !isInsideGitWorkTree(normalized);
  if (normalized === "/" || HOME_RE.test(normalized)) return true;
  if (normalized === normalizeSlashes(process.env.HOME ?? homedir())) return true;
  if (/\/Projects$/i.test(normalized)) return true;
  if (/\/(?:Library|Applications)(?:\/|$)/.test(normalized)) return true;
  return false;
}

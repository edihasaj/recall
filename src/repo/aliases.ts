import type { RecallDb } from "../db/client.js";
import { memories } from "../db/schema.js";

// Recover basename fallbacks without mixing two owners' repositories.
export function memoryRepoAliases(db: RecallDb, repo: string): string[] {
  // The CLI historically permits an omitted repo for an unscoped compile.
  // Keep that behavior; alias resolution only applies to named repositories.
  if (!repo) return [repo];
  const known = db.selectDistinct({ repo: memories.repo }).from(memories).all()
    .map((row) => row.repo).filter((name): name is string => Boolean(name));
  const basename = repo.split("/").at(-1)!;
  const qualified = known.filter((name) => name.includes("/") && name.split("/").at(-1) === basename);
  if (repo.includes("/") && !qualified.includes(repo)) qualified.push(repo);
  if (qualified.length !== 1) return [repo];
  return [...new Set([repo, basename, qualified[0]])];
}

// Mirrors isWorkspaceRootAlias in maintenance/cleanup.ts. Kept local so this
// module (imported by the compiler) does not pull in the cleanup tier.
const WORKSPACE_ROOT_ALIASES = new Set(["Projects"]);

/**
 * Canonical storage form of an agent-supplied repo name. MCP tools accept a
 * free-form `repo`, and agents pass the cwd basename (`oktapod`, `scriptix`)
 * or a remote URL as often as `owner/name`. A bare name resolves to the one
 * known `owner/name` with that basename; a workspace-root alias is not a
 * repo; a URL is reduced to `owner/name`. Ambiguous or unknown bare names are
 * returned unchanged so two owners' repositories are never merged.
 */
export function canonicalizeRepoSlug(db: RecallDb, repo: string | null | undefined): string | null {
  const trimmed = (repo ?? "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (!trimmed || WORKSPACE_ROOT_ALIASES.has(trimmed)) return null;
  const remote = trimmed.match(/^(?:[a-z][a-z0-9+.-]*:\/\/[^/]+\/|[^@\s/]+@[^:\s]+:)(.+)$/i);
  const candidate = remote ? remote[1] : trimmed;
  if (candidate.includes("/")) {
    const parts = candidate.split("/").filter(Boolean);
    return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : parts[0] ?? null;
  }
  const qualified = memoryRepoAliases(db, candidate).filter((name) => name.includes("/"));
  return qualified.length === 1 ? qualified[0] : candidate;
}

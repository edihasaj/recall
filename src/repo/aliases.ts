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

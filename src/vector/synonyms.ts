/**
 * Query-time synonym expansion. Loaded once per process from a bundled
 * English dictionary (src/data/synonyms.en.json) plus an optional override
 * file via RECALL_SYNONYMS_PATH. Each token in the user's query that maps
 * into a synonym group gets expanded into a FTS5 OR-clause:
 *
 *   degree → (degree OR diploma OR qualification OR credential)
 *
 * This is intentionally query-side only — we don't bloat the FTS index
 * with synonyms at write time. Set RECALL_SYNONYMS=false to disable.
 */
import { readFileSync, existsSync } from "node:fs";
import bundledSynonyms from "../data/synonyms.en.json" with { type: "json" };

interface SynonymFile {
  groups: string[][];
}

let cached: Map<string, string[]> | null = null;

function loadSynonymsFromFile(path: string): SynonymFile | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as SynonymFile;
    if (!parsed.groups || !Array.isArray(parsed.groups)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function loadBundled(): SynonymFile | null {
  const data = bundledSynonyms as SynonymFile;
  if (!data.groups || !Array.isArray(data.groups)) return null;
  return { groups: data.groups };
}

function buildMap(files: SynonymFile[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const file of files) {
    for (const group of file.groups) {
      const lowered = group.map((t) => t.toLowerCase());
      for (const token of lowered) {
        const existing = map.get(token);
        const merged = existing ? [...existing, ...lowered] : [...lowered];
        // De-dup, drop the token itself from its own expansion so we don't
        // emit `(degree OR degree OR diploma ...)`.
        const unique = [...new Set(merged)].filter((t) => t !== token);
        map.set(token, unique);
      }
    }
  }
  return map;
}

function getSynonymMap(): Map<string, string[]> {
  if (cached) return cached;
  if (process.env.RECALL_SYNONYMS === "false") {
    cached = new Map();
    return cached;
  }
  const files: SynonymFile[] = [];
  const bundled = loadBundled();
  if (bundled) files.push(bundled);
  const overridePath = process.env.RECALL_SYNONYMS_PATH;
  if (overridePath && existsSync(overridePath)) {
    const override = loadSynonymsFromFile(overridePath);
    if (override) files.push(override);
  }
  cached = buildMap(files);
  return cached;
}

/**
 * Returns the lowercased synonyms for `token` (excluding `token` itself),
 * or an empty array if it's not in the dictionary. Token lookup is
 * case-insensitive but morphology-blind — Porter stemming on the FTS5
 * side closes the gap for cases like `graduate`/`graduating` so we keep
 * the dictionary surface-form-only.
 */
export function getSynonyms(token: string): string[] {
  const map = getSynonymMap();
  return map.get(token.toLowerCase()) ?? [];
}

// Test helper: discard cache so per-test env tweaks take effect.
export function resetSynonymCache(): void {
  cached = null;
}

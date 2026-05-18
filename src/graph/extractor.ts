/**
 * Entity extractor. Pulls entities (files, functions, libraries, tools,
 * concepts, paths, commands, URLs) plus typed relations out of memory text.
 *
 * Two paths:
 *   1. heuristic() — always runs, cheap, regex-based, deterministic.
 *      Catches paths, package-like names, identifier-shaped function calls,
 *      common CLI tools, URLs. Used on every memory write.
 *
 *   2. llmEnrich() — opt-in; runs when an LLM provider is configured.
 *      Reads the memory text + the heuristic seed and returns canonical
 *      entity names + relations between them. Drives multi-hop graph walks.
 */
import type { RelationType } from "./store.js";
import type { EntityKind } from "./normalize.js";
import { isPlausibleEntityName } from "./normalize.js";

export interface ExtractedEntity {
  kind: EntityKind;
  name: string;
  /** 'heuristic' for regex output, 'llm' for model-extracted, 'manual' for user. */
  source: "heuristic" | "llm" | "manual";
  /** Where this mention came from in the source text, if known. */
  weight?: number;
}

export interface ExtractedRelation {
  source: { kind: EntityKind; name: string };
  target: { kind: EntityKind; name: string };
  relation: RelationType;
  confidence: number;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

// ---- Heuristic extractor ----------------------------------------------------

// File paths: src/foo/bar.ts, ./scripts/x.sh, docs/README.md
const PATH_RE = /(?:^|[\s`'"(])((?:\.{0,2}\/)?(?:[A-Za-z0-9_.-]+\/){1,}[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})/g;
// Inline-coded short identifiers: `foo()`, `Bar.method()`
const FUNC_RE = /`([A-Za-z_][\w.]{1,}\(\))`/g;
// Package-like names in backticks: `react`, `@scope/pkg`, `drizzle-orm`.
// Two flavours:
//  - SCOPED_PACKAGE_RE: @scope/name and hyphenated names — high-confidence
//  - SIMPLE_PACKAGE_RE: single lowercase words in backticks — gated by a stop-list
const SCOPED_PACKAGE_RE = /`(@[a-z0-9_-]+\/[a-z0-9_.-]+|[a-z][a-z0-9_-]*(?:-[a-z0-9]+)+)`/g;
const SIMPLE_PACKAGE_RE = /`([a-z][a-z0-9_]{2,30})`/g;
// Common English / generic words that look package-shaped but aren't.
const PACKAGE_STOPWORDS = new Set([
  "the", "and", "but", "for", "use", "uses", "used", "with", "from", "this",
  "that", "have", "has", "true", "false", "null", "void", "data", "code",
  "test", "tests", "build", "run", "runs", "name", "type", "types", "main",
  "yes", "no", "ok", "all", "any", "new", "old", "more", "less", "always",
  "never", "todo", "fixme", "note", "warn", "info", "error", "ts", "js",
]);
// Bare CLI invocation lines: `npm test`, `pnpm i`, `cargo build`
const CLI_RE = /\b(npm|pnpm|yarn|bun|cargo|go|uv|pip|node|deno|claude|codex|cursor|recall|brew|gh|git)\s+([a-z][a-z-]{0,30})\b/g;
// URLs
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)]+/g;

// Relation keyword cues. Order matters — first match wins for a sentence.
const RELATION_CUES: Array<{ rx: RegExp; relation: RelationType; flip?: boolean }> = [
  { rx: /\b(?:replaces?|replaced|supersedes?|superseded|deprecates?|deprecated)\b/i, relation: "replaces" },
  { rx: /\b(?:conflicts? with|incompatible with|clashes? with)\b/i, relation: "conflicts_with" },
  { rx: /\b(?:tested by|covered by)\b/i, relation: "tested_by" },
  { rx: /\b(?:depends on|requires|required by)\b/i, relation: "depends_on" },
  { rx: /\b(?:uses?|used|relies on|via)\b/i, relation: "uses" },
  { rx: /\b(?:references?|see also|cf\.)\b/i, relation: "references" },
  { rx: /\b(?:part of|inside|under)\b/i, relation: "part_of" },
];

export function heuristic(text: string): ExtractionResult {
  const entities = new Map<string, ExtractedEntity>(); // dedupe by (kind|name)
  const relations: ExtractedRelation[] = [];

  const push = (kind: EntityKind, name: string, weight = 1) => {
    if (!isPlausibleEntityName(kind, name)) return;
    const key = `${kind}|${name}`;
    const existing = entities.get(key);
    if (existing) {
      existing.weight = (existing.weight ?? 1) + weight;
    } else {
      entities.set(key, { kind, name, source: "heuristic", weight });
    }
  };

  // Files / paths
  for (const m of text.matchAll(PATH_RE)) {
    const raw = m[1];
    // Discriminate `repo_path` (no extension) vs `file` — both produce graph
    // nodes, but only `file` is treated as a file-system artifact.
    if (raw.includes(".") && !raw.endsWith("/")) {
      push("file", raw);
    } else {
      push("repo_path", raw);
    }
  }

  // Functions in backticks
  for (const m of text.matchAll(FUNC_RE)) {
    push("function", m[1]);
  }

  // Packages in backticks — scoped/hyphenated first (high confidence)
  for (const m of text.matchAll(SCOPED_PACKAGE_RE)) {
    push("library", m[1]);
  }
  // Single-word backticked tokens, filtered by stop-list
  for (const m of text.matchAll(SIMPLE_PACKAGE_RE)) {
    const candidate = m[1];
    if (PACKAGE_STOPWORDS.has(candidate)) continue;
    push("library", candidate, 0.7);
  }

  // CLI commands
  for (const m of text.matchAll(CLI_RE)) {
    push("tool", m[1]);
    push("command", `${m[1]} ${m[2]}`);
  }

  // URLs
  for (const m of text.matchAll(URL_RE)) {
    push("url", m[0]);
  }

  // Relations: split into sentences, look for a cue + two entity mentions.
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    const cue = RELATION_CUES.find((c) => c.rx.test(sentence));
    if (!cue) continue;
    const mentioned: Array<{ kind: EntityKind; name: string; idx: number }> = [];
    for (const ent of entities.values()) {
      const idx = sentence.indexOf(ent.name);
      if (idx >= 0) mentioned.push({ kind: ent.kind, name: ent.name, idx });
    }
    if (mentioned.length < 2) continue;
    mentioned.sort((a, b) => a.idx - b.idx);
    relations.push({
      source: { kind: mentioned[0].kind, name: mentioned[0].name },
      target: { kind: mentioned[1].kind, name: mentioned[1].name },
      relation: cue.relation,
      confidence: 0.5,
    });
  }

  return { entities: Array.from(entities.values()), relations };
}

// ---- LLM enrichment --------------------------------------------------------

export const ENTITY_EXTRACTION_SYSTEM = `You extract code-graph entities and typed relations from short engineering notes (rules, decisions, gotchas).

Return STRICT JSON only — no prose, no fences. Shape:
{
  "entities": [{"kind": "<one of: file|function|library|tool|concept|repo_path|command|url>", "name": "<canonical surface form>"}],
  "relations": [{"source": {"kind": "...", "name": "..."}, "target": {"kind": "...", "name": "..."}, "relation": "<one of: uses|replaces|conflicts_with|tested_by|depends_on|references|part_of>", "confidence": 0.0-1.0}]
}

Rules:
- Only include entities the text actually mentions. Do NOT invent.
- Prefer the most specific kind: a file path is "file", a library name is "library", a CLI like "npm install" is "command".
- "concept" is a last resort for domain words ("authentication", "rate limiting").
- Skip generic English (pronouns, verbs, adjectives).
- If the text is purely about user preferences or behaviour with no nameable artifact, return {"entities": [], "relations": []}.
- Be conservative on relations — only include one when the text clearly states it.`;

export interface LlmExtractInput {
  memoryText: string;
  /** Optional seed list from the heuristic pass — saves the LLM a step. */
  seed?: ExtractedEntity[];
}

export function buildExtractionPrompt(input: LlmExtractInput): string {
  const seedBlock = input.seed && input.seed.length > 0
    ? `\n\nHeuristic seed (use as hints, refine or override):\n${input.seed
        .slice(0, 20)
        .map((e) => `- ${e.kind}: ${e.name}`)
        .join("\n")}`
    : "";
  return `Memory text:\n"""\n${input.memoryText}\n"""${seedBlock}\n\nReturn STRICT JSON.`;
}

/**
 * Parse the LLM response into an ExtractionResult, tolerating fenced code
 * and surrounding prose. Returns null if no valid shape is recognised.
 */
export function parseLlmExtraction(raw: string): ExtractionResult | null {
  let text = raw.trim();
  // Strip code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const entities = sanitiseEntities(obj.entities);
  const relations = sanitiseRelations(obj.relations);
  return { entities, relations };
}

const VALID_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>([
  "file", "function", "library", "tool", "concept", "repo_path", "command", "url",
]);
const VALID_RELATIONS: ReadonlySet<RelationType> = new Set<RelationType>([
  "uses", "replaces", "conflicts_with", "tested_by", "depends_on", "references", "part_of",
]);

function sanitiseEntities(raw: unknown): ExtractedEntity[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedEntity[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = String(o.kind ?? "");
    const name = String(o.name ?? "").trim();
    if (!VALID_KINDS.has(kind as EntityKind)) continue;
    if (!isPlausibleEntityName(kind as EntityKind, name)) continue;
    out.push({ kind: kind as EntityKind, name, source: "llm" });
  }
  return out;
}

function sanitiseRelations(raw: unknown): ExtractedRelation[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedRelation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const rel = String(o.relation ?? "");
    if (!VALID_RELATIONS.has(rel as RelationType)) continue;
    const source = parseEndpoint(o.source);
    const target = parseEndpoint(o.target);
    if (!source || !target) continue;
    const confidence = typeof o.confidence === "number"
      ? Math.max(0, Math.min(1, o.confidence))
      : 0.6;
    out.push({ source, target, relation: rel as RelationType, confidence });
  }
  return out;
}

function parseEndpoint(raw: unknown): { kind: EntityKind; name: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = String(o.kind ?? "");
  const name = String(o.name ?? "").trim();
  if (!VALID_KINDS.has(kind as EntityKind)) return null;
  if (!isPlausibleEntityName(kind as EntityKind, name)) return null;
  return { kind: kind as EntityKind, name };
}

/**
 * Merge a heuristic pass with an LLM pass. LLM entries override heuristic
 * ones on the same (kind, name) — the model's source tag takes precedence
 * because it's the higher-quality signal.
 */
export function mergeExtractions(...passes: ExtractionResult[]): ExtractionResult {
  const entities = new Map<string, ExtractedEntity>();
  for (const pass of passes) {
    for (const ent of pass.entities) {
      const key = `${ent.kind}|${ent.name}`;
      const prev = entities.get(key);
      if (!prev || (prev.source === "heuristic" && ent.source === "llm")) {
        entities.set(key, ent);
      }
    }
  }
  // Deduplicate relations on (source, target, relation).
  const relations = new Map<string, ExtractedRelation>();
  for (const pass of passes) {
    for (const rel of pass.relations) {
      const key = `${rel.source.kind}|${rel.source.name}->${rel.relation}->${rel.target.kind}|${rel.target.name}`;
      const prev = relations.get(key);
      if (!prev || rel.confidence > prev.confidence) {
        relations.set(key, rel);
      }
    }
  }
  return {
    entities: Array.from(entities.values()),
    relations: Array.from(relations.values()),
  };
}

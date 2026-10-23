/**
 * Benchmark-only additive evidence: the established supplemental rendering of
 * the original twenty sources stays an exact prefix, then complete
 * query-focused units from lexical candidates outside those twenty are appended
 * under a separate budget. Lexical order is supplied by the caller; this module
 * never ranks and never writes storage identifiers or positions into the text.
 */
import { preferredEvidenceSpeaker, renderEvidenceSources } from "../src/history/evidence.js";
import { corpusObservationDate } from "./longmemeval-focused-evidence.js";
import type { Ranked } from "./longmemeval-qa-support.js";
import { buildSupplementalEvidence } from "./longmemeval-supplemental-evidence.js";

export const ADDITIVE_ORIGINAL_COUNT = 20;
export const ADDITIVE_LEXICAL_LIMIT = 20;
export const ADDITIVE_BASE_CAP = 180_000;
export const ADDITIVE_EXTRA_CAP = 80_000;
export const ADDITIVE_TOTAL_CAP = 260_000;
export const ADDITIVE_SOURCE_LIMIT = 40;
export const ADDITIVE_FRAMED_CAP = 4_000;
export const ADDITIVE_RAW_UNIT_CAP = 3_800;

const RENDERER_HEADER = "## Memory 1\n";
const SEPARATOR = "\n\n";
const MAX_RANGE_EXPANSION = 4;
const TOO_SMALL = "max_chars is too small to render an evidence label and a complete source unit";

type Range = { start: number; end: number };
export type AdditiveOmissionReason = "no_complete_unit" | "budget";
type Source = {
  id: string; occurrence: number; date: string;
  full_chars: number; used_chars: number; truncated: boolean; ranges: Range[];
};

/**
 * Protocol limits. A caller may only tighten them (to test budget edges with
 * small inputs): each value must be an integer within its protocol ceiling.
 */
export interface AdditiveLimits {
  extra_chars: number;
  framed_chars: number;
  raw_unit_chars: number;
}

const DEFAULT_LIMITS: AdditiveLimits = {
  extra_chars: ADDITIVE_EXTRA_CAP,
  framed_chars: ADDITIVE_FRAMED_CAP,
  raw_unit_chars: ADDITIVE_RAW_UNIT_CAP,
};

export function buildAdditiveLexicalEvidence(
  original: readonly Ranked[],
  lexical: readonly Ranked[],
  question: string,
  limits: Partial<AdditiveLimits> = {},
) {
  const budget = resolveLimits(limits);
  if (typeof question !== "string") throw new TypeError("Additive evidence question must be a string");
  const originalOccurrences = validateRows(original, lexical);
  const selected = selectLexical(lexical, originalOccurrences);

  const base = buildSupplementalEvidence([...original], question, ADDITIVE_BASE_CAP, false);
  if (!("supplemental" in base)) throw new Error("Additive evidence expected supplemental base diagnostics");

  let text = base.text;
  let extraUsed = 0;
  const sources: Source[] = base.sources.map((source) => ({ ...source, ranges: source.ranges.map((r) => ({ ...r })) }));
  const included: number[] = [];
  const omitted: { source_rank: number; occurrence: number; reason: AdditiveOmissionReason }[] = [];
  const speaker = preferredEvidenceSpeaker(question);

  for (const [index, row] of selected.entries()) {
    const sourceRank = ADDITIVE_ORIGINAL_COUNT + index + 1;
    const separator = text.length === 0 ? "" : SEPARATOR;
    const allowance = Math.min(budget.framed_chars, budget.extra_chars - extraUsed - separator.length);
    if (allowance <= 0) {
      sources.push(omittedSource(row));
      omitted.push({ source_rank: sourceRank, occurrence: row.occurrence, reason: "budget" });
      continue;
    }
    const fitted = fitBlock(row, question, speaker, `## Lexical Memory ${sourceRank}`, allowance, budget);
    if ("reason" in fitted) {
      sources.push(omittedSource(row));
      omitted.push({ source_rank: sourceRank, occurrence: row.occurrence, reason: fitted.reason });
      continue;
    }
    text += separator + fitted.block;
    extraUsed += separator.length + fitted.block.length;
    sources.push(sourceMetadata(row, fitted.source));
    included.push(sourceRank);
  }

  if (extraUsed > budget.extra_chars) throw new Error("Additive evidence exceeded its extra budget");
  if (text.length > ADDITIVE_TOTAL_CAP) throw new Error("Additive evidence exceeded its total cap");
  if (sources.length > ADDITIVE_SOURCE_LIMIT) throw new Error("Additive evidence exceeded its source limit");
  return {
    text,
    chars: text.length,
    full_chars: text.length + sources.reduce((sum, source) => sum + source.full_chars - source.used_chars, 0),
    sources,
    supplemental: base.supplemental,
    additive: {
      base_chars: base.text.length,
      extra_chars: extraUsed,
      selected_occurrences: selected.map((row) => row.occurrence),
      included_ranks: included,
      omitted,
    },
  };
}

/**
 * Render one lexical candidate with a raw-unit ceiling and relabel only the
 * renderer's trusted initial header. The first anchor choice can change
 * non-monotonically with the ceiling, so a coarse jump can skip a feasible
 * value. Search every ceiling downward by one and keep the largest that yields
 * a complete block within the allowance; selected units are never cropped.
 * No ceiling below the shortest source line can hold a complete unit, which
 * bounds the search without skipping any feasible value.
 */
function fitBlock(
  row: Ranked,
  question: string,
  speaker: ReturnType<typeof preferredEvidenceSpeaker>,
  label: string,
  allowance: number,
  budget: AdditiveLimits,
): { block: string; source: Source } | { reason: AdditiveOmissionReason } {
  const floor = Math.max(1, shortestLineLength(row.text));
  let renderedAny = false;
  for (let raw = budget.raw_unit_chars; raw >= floor; raw--) {
    const rendered = renderOne(row, question, speaker, raw, budget.raw_unit_chars);
    if (rendered === null) continue;
    renderedAny = true;
    if (!rendered.text.startsWith(RENDERER_HEADER)) {
      throw new Error("Additive evidence renderer returned an unexpected source label");
    }
    const block = `${label}\n${rendered.text.slice(RENDERER_HEADER.length)}`;
    if (block.length <= allowance) return { block, source: rendered.source };
  }
  return { reason: renderedAny && allowance < budget.framed_chars ? "budget" : "no_complete_unit" };
}

function shortestLineLength(text: string): number {
  let shortest = Number.POSITIVE_INFINITY;
  for (const line of text.split("\n")) if (line.length > 0 && line.length < shortest) shortest = line.length;
  return Number.isFinite(shortest) ? shortest : 1;
}

function renderOne(
  row: Ranked,
  question: string,
  speaker: ReturnType<typeof preferredEvidenceSpeaker>,
  rawChars: number,
  probeRawChars: number,
) {
  try {
    const rendered = renderEvidenceSources([{
      text: row.text,
      observed_at: corpusObservationDate(row.date),
    }], {
      query: question,
      max_chars: probeRawChars * MAX_RANGE_EXPANSION + 256,
      per_source_chars: rawChars,
      preferred_speaker: speaker,
      reserve_speaker_units: true,
    });
    const source = rendered.sources[0]!;
    return source.ranges.length === 0 ? null : { text: rendered.text, source };
  } catch (error) {
    if (error instanceof RangeError && error.message === TOO_SMALL) return null;
    throw error;
  }
}

function resolveLimits(limits: Partial<AdditiveLimits>): AdditiveLimits {
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) {
    throw new TypeError("Additive evidence limits must be an object");
  }
  const bounds: Record<keyof AdditiveLimits, [number, number]> = {
    extra_chars: [0, ADDITIVE_EXTRA_CAP],
    framed_chars: [1, ADDITIVE_FRAMED_CAP],
    raw_unit_chars: [1, ADDITIVE_RAW_UNIT_CAP],
  };
  for (const key of Object.keys(limits)) {
    if (!(key in bounds)) throw new TypeError(`Unknown additive evidence limit: ${key}`);
  }
  const resolved = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(bounds) as (keyof AdditiveLimits)[]) {
    const value = limits[key];
    if (value === undefined) continue;
    const [min, max] = bounds[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new RangeError(`Additive evidence limit ${key} must be an integer from ${min} to ${max}`);
    }
    resolved[key] = value;
  }
  return resolved;
}

function validateRows(original: readonly Ranked[], lexical: readonly Ranked[]): Set<number> {
  if (!Array.isArray(original)) throw new TypeError("Additive original evidence must be an array");
  if (!Array.isArray(lexical)) throw new TypeError("Additive lexical evidence must be an array");
  if (original.length !== ADDITIVE_ORIGINAL_COUNT) {
    throw new RangeError(`Additive evidence requires exactly ${ADDITIVE_ORIGINAL_COUNT} original sources`);
  }
  const seen = new Map<number, Ranked>();
  const originalOccurrences = new Set<number>();
  for (const row of original) {
    assertRow(row);
    if (originalOccurrences.has(row.occurrence)) {
      throw new Error("Additive original evidence repeats an occurrence");
    }
    originalOccurrences.add(row.occurrence);
    seen.set(row.occurrence, row);
  }
  // Every lexical row is checked, including rows beyond the selected twenty.
  for (const row of lexical) {
    assertRow(row);
    const previous = seen.get(row.occurrence);
    if (previous === undefined) seen.set(row.occurrence, row);
    else if (previous.id !== row.id || previous.text !== row.text || previous.date !== row.date) {
      throw new Error("Additive evidence has inconsistent duplicate occurrence");
    }
  }
  return originalOccurrences;
}

function selectLexical(lexical: readonly Ranked[], originalOccurrences: ReadonlySet<number>): Ranked[] {
  const selected: Ranked[] = [];
  const taken = new Set<number>();
  for (const row of lexical) {
    if (selected.length >= ADDITIVE_LEXICAL_LIMIT) break;
    if (originalOccurrences.has(row.occurrence) || taken.has(row.occurrence)) continue;
    taken.add(row.occurrence);
    selected.push(row);
  }
  return selected;
}

function assertRow(row: Ranked): void {
  if (!row || typeof row !== "object") throw new TypeError("Invalid additive evidence source");
  if (typeof row.id !== "string") throw new TypeError("Additive evidence source id must be a string");
  if (typeof row.occurrence !== "number" || !Number.isSafeInteger(row.occurrence) || row.occurrence < 0) {
    throw new TypeError("Additive evidence source occurrence must be a non-negative safe integer");
  }
  if (typeof row.date !== "string") throw new TypeError("Additive evidence source date must be a string");
  if (typeof row.text !== "string") throw new TypeError("Additive evidence source text must be a string");
}

function sourceMetadata(
  row: Ranked,
  source: { full_chars: number; used_chars: number; truncated: boolean; ranges: Range[] },
): Source {
  return {
    id: row.id, occurrence: row.occurrence, date: row.date,
    full_chars: source.full_chars, used_chars: source.used_chars, truncated: source.truncated,
    ranges: source.ranges.map((range) => ({ ...range })),
  };
}

function omittedSource(row: Ranked): Source {
  return {
    id: row.id, occurrence: row.occurrence, date: row.date,
    full_chars: row.text.length, used_chars: 0, truncated: row.text.length > 0, ranges: [],
  };
}

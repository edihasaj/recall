/**
 * Benchmark-only statement evidence: the exact original twenty sources plus the
 * first twenty distinct lexical occurrences outside them are rendered together
 * by the shared evidence renderer, with complete preferred-speaker statements
 * reserved in every selected source. Ranking is supplied by the caller. The
 * module adds no facts, resolves no dates and never puts identifiers into the
 * text; they stay in the scorer-side source metadata.
 */
import {
  preferredEvidenceSpeaker, renderEvidenceSources, type EvidenceSpeakerSpan,
} from "../src/history/evidence.js";
import { corpusObservationDate } from "./longmemeval-focused-evidence.js";
import type { Ranked } from "./longmemeval-qa-support.js";

export const STATEMENT_ORIGINAL_COUNT = 20;
export const STATEMENT_LEXICAL_POOL = 80;
export const STATEMENT_LEXICAL_LIMIT = 20;
export const STATEMENT_MAX_CHARS = 180_000;
export const STATEMENT_PER_SOURCE_CHARS = 4_000;

/**
 * Rows must carry trusted host speaker spans built from the original structured
 * messages. They are never inferred from flattened text.
 */
export type StatementRanked = Ranked & { speaker_spans?: readonly EvidenceSpeakerSpan[] };

type Range = { start: number; end: number };
export interface StatementSource {
  id: string; occurrence: number; date: string;
  ranges: Range[]; full_chars: number; used_chars: number; truncated: boolean;
}

export function buildStatementEvidence(
  original: readonly StatementRanked[],
  lexical: readonly StatementRanked[],
  question: string,
) {
  if (typeof question !== "string") throw new TypeError("Statement evidence question must be a string");
  const originalOccurrences = validateRows(original, lexical);
  const extras = selectLexical(lexical, originalOccurrences);
  const selected = [...original, ...extras];
  for (const row of selected) {
    if (row.speaker_spans === undefined) {
      throw new TypeError("Statement evidence requires trusted speaker_spans on every selected source");
    }
  }
  const speaker = preferredEvidenceSpeaker(question);

  const rendered = renderEvidenceSources(selected.map((row) => ({
    text: row.text,
    observed_at: corpusObservationDate(row.date),
    speaker_spans: row.speaker_spans,
  })), {
    query: question,
    max_chars: STATEMENT_MAX_CHARS,
    per_source_chars: STATEMENT_PER_SOURCE_CHARS,
    preferred_speaker: speaker,
    reserve_speaker_units: true,
  });
  if (rendered.text.length > STATEMENT_MAX_CHARS) throw new Error("Statement evidence exceeded its character budget");
  if (rendered.sources.length !== selected.length) throw new Error("Statement evidence renderer returned unexpected sources");

  const sources: StatementSource[] = [];
  for (const meta of [...rendered.sources].sort((a, b) => a.source_index - b.source_index)) {
    const row = selected[meta.source_index];
    if (row === undefined || meta.source_index !== sources.length) {
      throw new Error("Statement evidence renderer returned unexpected source indexes");
    }
    sources.push({
      id: row.id, occurrence: row.occurrence, date: row.date,
      ranges: meta.ranges.map((range) => ({ ...range })),
      full_chars: meta.full_chars, used_chars: meta.used_chars, truncated: meta.truncated,
    });
  }

  return {
    text: rendered.text,
    chars: rendered.text.length,
    full_chars: rendered.text.length + sources.reduce((sum, s) => sum + s.full_chars - s.used_chars, 0),
    sources,
    statements: {
      selected_occurrences: selected.map((row) => row.occurrence),
      lexical_pool: STATEMENT_LEXICAL_POOL,
      lexical_limit: STATEMENT_LEXICAL_LIMIT,
      per_source_raw_chars: STATEMENT_PER_SOURCE_CHARS,
      max_chars: STATEMENT_MAX_CHARS,
      preferred_speaker: speaker,
      omitted_occurrences: sources.filter((s) => s.ranges.length === 0).map((s) => s.occurrence),
    },
  };
}

function validateRows(original: readonly StatementRanked[], lexical: readonly StatementRanked[]): Set<number> {
  if (!Array.isArray(original)) throw new TypeError("Statement original evidence must be an array");
  if (!Array.isArray(lexical)) throw new TypeError("Statement lexical evidence must be an array");
  if (original.length !== STATEMENT_ORIGINAL_COUNT) {
    throw new RangeError(`Statement evidence requires exactly ${STATEMENT_ORIGINAL_COUNT} original sources`);
  }
  const seen = new Map<number, StatementRanked>();
  const originalOccurrences = new Set<number>();
  for (const row of original) {
    assertRow(row);
    if (originalOccurrences.has(row.occurrence)) throw new Error("Statement original evidence repeats an occurrence");
    originalOccurrences.add(row.occurrence);
    seen.set(row.occurrence, row);
  }
  // Every lexical row is checked, including rows beyond the selected twenty.
  for (const row of lexical) {
    assertRow(row);
    const previous = seen.get(row.occurrence);
    if (previous === undefined) seen.set(row.occurrence, row);
    else if (previous.id !== row.id || previous.text !== row.text || previous.date !== row.date
      || (previous.speaker_spans !== undefined && row.speaker_spans !== undefined
        && JSON.stringify(previous.speaker_spans) !== JSON.stringify(row.speaker_spans))) {
      throw new Error("Statement evidence has inconsistent duplicate occurrence");
    }
  }
  return originalOccurrences;
}

function selectLexical(
  lexical: readonly StatementRanked[],
  originalOccurrences: ReadonlySet<number>,
): StatementRanked[] {
  const selected: StatementRanked[] = [];
  const taken = new Set<number>();
  for (const row of lexical) {
    if (selected.length >= STATEMENT_LEXICAL_LIMIT) break;
    if (originalOccurrences.has(row.occurrence) || taken.has(row.occurrence)) continue;
    taken.add(row.occurrence);
    selected.push(row);
  }
  return selected;
}

function assertRow(row: StatementRanked): void {
  if (!row || typeof row !== "object") throw new TypeError("Invalid statement evidence source");
  if (typeof row.id !== "string") throw new TypeError("Statement evidence source id must be a string");
  if (typeof row.occurrence !== "number" || !Number.isSafeInteger(row.occurrence) || row.occurrence < 0) {
    throw new TypeError("Statement evidence source occurrence must be a non-negative safe integer");
  }
  if (typeof row.date !== "string") throw new TypeError("Statement evidence source date must be a string");
  if (typeof row.text !== "string") throw new TypeError("Statement evidence source text must be a string");
}

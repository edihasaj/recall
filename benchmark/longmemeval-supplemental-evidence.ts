/**
 * Extends the highlighted top-ten evidence with bounded, query-focused units
 * from ranks 11 through 20. This is a benchmark-only opt-in renderer.
 */
import { preferredEvidenceSpeaker, renderEvidenceSources } from "../src/history/evidence.js";
import { corpusObservationDate } from "./longmemeval-focused-evidence.js";
import { buildHighlightedEvidence } from "./longmemeval-highlighted-evidence.js";
import type { Ranked } from "./longmemeval-qa-support.js";

const PRIMARY_SOURCE_LIMIT = 10;
const SOURCE_LIMIT = 20;
const SUPPLEMENT_PER_SOURCE_CHARS = 4_000;
const PROBE_MAX_CHARS = SUPPLEMENT_PER_SOURCE_CHARS * 4 + 128;
const MAX_RENDERED_RANGE_EXPANSION = 4;
const TOO_SMALL_FOR_COMPLETE_UNIT = "max_chars is too small to render an evidence label and a complete source unit";

type Range = { start: number; end: number };
type OmissionReason = "no_complete_unit" | "budget";
type Source = {
  id: string;
  occurrence: number;
  date: string;
  full_chars: number;
  used_chars: number;
  truncated: boolean;
  ranges: Range[];
};
type SupplementalDiagnostics = {
  included_ranks: number[];
  omitted: { source_rank: number; reason: OmissionReason }[];
};

/**
 * Render the established highlighted primary evidence unchanged, then append
 * complete query-focused units from ranks 11–20 only when they fit the same
 * cap. Every supplied ranked source remains observable in source metadata.
 */
export function buildSupplementalEvidence(
  rows: Ranked[],
  question: string,
  cap: number,
  includeGuidance = true,
) {
  if (rows.length > SOURCE_LIMIT) {
    throw new RangeError(`Supplemental evidence supports at most ${SOURCE_LIMIT} ranked sources`);
  }

  const primary = rows.slice(0, PRIMARY_SOURCE_LIMIT);
  // Returning directly is intentional: callers with <=10 rows get exact
  // byte/object-shape parity with the established highlighted renderer.
  const base = buildHighlightedEvidence(primary, question, cap, includeGuidance);
  if (rows.length <= PRIMARY_SOURCE_LIMIT) return base;

  let text = base.text;
  const sources: Source[] = [...base.sources];
  const diagnostics: SupplementalDiagnostics = { included_ranks: [], omitted: [] };
  const speaker = preferredEvidenceSpeaker(question);

  for (const [index, row] of rows.slice(PRIMARY_SOURCE_LIMIT).entries()) {
    const sourceRank = PRIMARY_SOURCE_LIMIT + index + 1;
    assertSupplementalSource(row);
    // The availability probe must not be constrained by the caller's full
    // cap: a long source can have a 4,000-character candidate that exceeds
    // it even though a smaller complete unit fits the leftover budget.
    const probe = renderOne(row, question, speaker, PROBE_MAX_CHARS);
    if (probe === null) {
      sources.push(omittedSource(row));
      diagnostics.omitted.push({ source_rank: sourceRank, reason: "no_complete_unit" });
      continue;
    }

    const block = additionalBlock(probe.text, row.text, probe.source.ranges, sourceRank);
    const separator = text.length === 0 ? "" : "\n\n";
    const remainingBlockChars = cap - text.length - separator.length;
    if (remainingBlockChars <= 0) {
      sources.push(omittedSource(row));
      diagnostics.omitted.push({ source_rank: sourceRank, reason: "budget" });
      continue;
    }

    const standardHeaderChars = probe.text.length - renderedRanges(row.text, probe.source.ranges).length;
    const customHeaderChars = block.length - renderedRanges(row.text, probe.source.ranges).length;
    const constrainedCap = remainingBlockChars - (customHeaderChars - standardHeaderChars);
    // The renderer's per-source cap governs raw verbatim ranges. Start below
    // the available framed content budget, then admit only a block whose
    // actual labels and ellipses fit the remaining shared budget.
    const availableContentChars = Math.min(
      SUPPLEMENT_PER_SOURCE_CHARS,
      constrainedCap - standardHeaderChars,
    );
    if (constrainedCap <= 0 || availableContentChars <= 0) {
      sources.push(omittedSource(row));
      diagnostics.omitted.push({ source_rank: sourceRank, reason: "budget" });
      continue;
    }

    const constrained = renderFittingOne(
      row,
      question,
      speaker,
      PROBE_MAX_CHARS,
      availableContentChars,
      remainingBlockChars,
      sourceRank,
    );
    if (constrained === null) {
      sources.push(omittedSource(row));
      diagnostics.omitted.push({ source_rank: sourceRank, reason: "budget" });
      continue;
    }
    const selected = additionalBlock(
      constrained.text,
      row.text,
      constrained.source.ranges,
      sourceRank,
    );
    if (selected.length > remainingBlockChars) {
      throw new Error("Supplemental evidence renderer exceeded its character budget");
    }
    text += separator + selected;
    sources.push(sourceMetadata(row, constrained.source));
    diagnostics.included_ranks.push(sourceRank);
  }

  if (text.length > cap) throw new Error("Supplemental evidence exceeded context cap");
  return {
    text,
    chars: text.length,
    full_chars: text.length + sources.reduce(
      (sum, source) => sum + source.full_chars - source.used_chars,
      0,
    ),
    sources,
    supplemental: diagnostics,
  };
}

/**
 * `renderEvidenceSources` selects complete units before its shared-budget
 * admission. Retry bounded raw-unit ceilings against a safe probe cap, then
 * measure the actual custom block, including its header and ellipses.
 * Each rendered retry reduces by the observed overage (at least one), never
 * crops a selected unit, and leaves an exact-fit whole source untouched.
 */
function renderFittingOne(
  row: Ranked,
  question: string,
  speaker: ReturnType<typeof preferredEvidenceSpeaker>,
  maxChars: number,
  contentChars: number,
  remainingBlockChars: number,
  sourceRank: number,
) {
  for (let perSourceChars = contentChars; perSourceChars > 0;) {
    const rendered = renderOne(row, question, speaker, maxChars, perSourceChars);
    // The application found no complete unit under this ceiling. A smaller
    // raw-unit ceiling cannot make a complete unit fit.
    if (rendered === null) return null;
    const block = additionalBlock(rendered.text, row.text, rendered.source.ranges, sourceRank);
    if (block.length <= remainingBlockChars) return rendered;
    // A verbatim range can add at most three framing characters per UTF-16
    // unit plus a fixed leading/trailing ellipsis. Scale the observed framed
    // overage so dense disjoint ranges cannot jump past smaller whole units.
    perSourceChars -= Math.max(
      1,
      Math.ceil((block.length - remainingBlockChars) / MAX_RENDERED_RANGE_EXPANSION),
    );
  }
  return null;
}

function renderOne(
  row: Ranked,
  question: string,
  speaker: ReturnType<typeof preferredEvidenceSpeaker>,
  maxChars: number,
  perSourceChars = SUPPLEMENT_PER_SOURCE_CHARS,
) {
  try {
    const rendered = renderEvidenceSources([{
      text: row.text,
      observed_at: corpusObservationDate(row.date),
    }], {
      query: question,
      max_chars: maxChars,
      per_source_chars: perSourceChars,
      preferred_speaker: speaker,
    });
    const source = rendered.sources[0]!;
    if (source.ranges.length === 0) return null;
    return { text: rendered.text, source };
  } catch (error) {
    if (isTooSmallForCompleteUnit(error)) return null;
    throw error;
  }
}

function assertSupplementalSource(row: Ranked): asserts row is Ranked {
  if (!row || typeof row !== "object") throw new TypeError("Invalid supplemental evidence source");
  if (typeof row.id !== "string") throw new TypeError("Supplemental evidence source id must be a string");
  if (typeof row.occurrence !== "number" || !Number.isSafeInteger(row.occurrence) || row.occurrence < 0) {
    throw new TypeError("Supplemental evidence source occurrence must be a non-negative safe integer");
  }
  if (typeof row.date !== "string") throw new TypeError("Supplemental evidence source date must be a string");
  if (typeof row.text !== "string") throw new TypeError("Supplemental evidence source text must be a string");
}

function isTooSmallForCompleteUnit(error: unknown): boolean {
  return error instanceof RangeError && error.message === TOO_SMALL_FOR_COMPLETE_UNIT;
}

function additionalBlock(
  rendered: string,
  text: string,
  ranges: readonly Range[],
  sourceRank: number,
): string {
  const body = renderedRanges(text, ranges);
  if (!rendered.endsWith(body)) {
    throw new Error("Supplemental evidence renderer returned an unexpected source block");
  }
  const header = rendered.slice(0, rendered.length - body.length);
  const replacement = `## Additional Memory ${sourceRank}`;
  if (!header.startsWith("## Memory 1\n")) {
    throw new Error("Supplemental evidence renderer returned an unexpected source label");
  }
  return `${replacement}${header.slice("## Memory 1".length)}${body}`;
}

function renderedRanges(text: string, ranges: readonly Range[]): string {
  return ranges.map((range, index) => {
    const prefix = range.start > 0 && index === 0 ? "…\n" : "";
    const gap = index > 0 ? "\n…\n" : "";
    const suffix = range.end < text.length && index === ranges.length - 1 ? "\n…" : "";
    return `${gap}${prefix}${text.slice(range.start, range.end)}${suffix}`;
  }).join("");
}

function sourceMetadata(
  row: Ranked,
  source: { full_chars: number; used_chars: number; truncated: boolean; ranges: Range[] },
): Source {
  return {
    id: row.id,
    occurrence: row.occurrence,
    date: row.date,
    full_chars: source.full_chars,
    used_chars: source.used_chars,
    truncated: source.truncated,
    ranges: source.ranges.map((range) => ({ ...range })),
  };
}

function omittedSource(row: Ranked): Source {
  return {
    id: row.id,
    occurrence: row.occurrence,
    date: row.date,
    full_chars: row.text.length,
    used_chars: 0,
    truncated: row.text.length > 0,
    ranges: [],
  };
}

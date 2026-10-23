/** Query-focused source index plus verbatim LongMemEval session preservation. */
import { preferredEvidenceSpeaker, renderEvidenceSources } from "../src/history/evidence.js";
import { EVIDENCE_USE_GUIDANCE, corpusObservationDate } from "./longmemeval-focused-evidence.js";
import { buildEvidence, type Ranked } from "./longmemeval-qa-support.js";

const PREVIEW_SOURCE_CHARS = 800;
const PREVIEW_OMITTED = "[No complete preview unit fits the preview budget.]";
const FULL_OMITTED = "[Full session omitted or truncated to fit the context budget.]";

type Range = { start: number; end: number };

export function buildHighlightedEvidence(rows: Ranked[], question: string, cap: number, includeGuidance = true) {
  const guidance = includeGuidance ? EVIDENCE_USE_GUIDANCE : "";
  if (!Number.isSafeInteger(cap) || cap <= 0 || cap < guidance.length) {
    throw new Error("Evidence guidance exceeds context cap");
  }
  if (rows.length === 0) {
    return { text: guidance, chars: guidance.length, full_chars: guidance.length, sources: [] };
  }

  const previews = rows.map((row) => previewFor(row, question));
  const previewBlocks = previews.map((preview, index) =>
    fullLabel(rows[index]!, index) + preview.body,
  );
  const previewSection = `## Evidence previews\n${previewBlocks.join("\n\n")}`;
  const fullTitle = "## Original session evidence\n";
  const fixed = `${guidance ? guidance + "\n\n" : ""}${previewSection}\n\n${fullTitle}`;
  const fullBudget = cap - fixed.length;
  if (fullBudget < 0) throw new Error("Highlighted evidence overhead exceeds context cap");
  const full = allocateFullBlocks(rows, fullBudget);
  const text = fixed + full.map((item) => item.block).join("\n\n");
  if (text.length > cap) throw new Error("Highlighted evidence exceeded context cap");

  const sources = rows.map((row, index) => {
    const ranges = mergeRanges([
      ...previews[index]!.ranges,
      ...(full[index]!.end > 0 ? [{ start: 0, end: full[index]!.end }] : []),
    ]);
    const used_chars = ranges.reduce((total, range) => total + range.end - range.start, 0);
    return {
      id: row.id,
      occurrence: row.occurrence,
      date: row.date,
      full_chars: row.text.length,
      used_chars,
      truncated: !isWhole(ranges, row.text.length),
      ranges,
    };
  });
  return {
    text,
    chars: text.length,
    full_chars: text.length + sources.reduce((total, source) => total + source.full_chars - source.used_chars, 0),
    sources,
  };
}

function allocateFullBlocks(rows: Ranked[], fullBudget: number) {
  let allocatorCap = fullBudget;
  for (let attempt = 0; attempt <= rows.length; attempt++) {
    // Keep the established fair, redistributing prefix allocator. Its neutral
    // labels also define the full-session label format below.
    const allocated = buildEvidence(rows, allocatorCap).sources;
    const full = rows.map((row, index) => {
      const end = completePrefixEnd(row.text, allocated[index]!.used_chars);
      const body = end === row.text.length
        ? row.text
        : end > 0
          ? `${row.text.slice(0, end)}\n${FULL_OMITTED}`
          : FULL_OMITTED;
      return { end, block: fullLabel(row, index) + body };
    });
    const renderedChars = full.map((item) => item.block).join("\n\n").length;
    if (renderedChars <= fullBudget) return full;
    allocatorCap -= renderedChars - fullBudget;
  }
  throw new Error("Highlighted full-session markers exceed context cap");
}

function previewFor(row: Ranked, question: string): { body: string; ranges: Range[] } {
  const rendered = renderEvidenceSources([{
    text: row.text,
    observed_at: corpusObservationDate(row.date),
  }], {
    query: question,
    max_chars: PREVIEW_SOURCE_CHARS + 128,
    per_source_chars: PREVIEW_SOURCE_CHARS,
    preferred_speaker: preferredEvidenceSpeaker(question),
  });
  const ranges = rendered.sources[0]?.ranges ?? [];
  return {
    body: ranges.length > 0 ? renderRanges(row.text, ranges) : PREVIEW_OMITTED,
    ranges,
  };
}

function fullLabel(row: Ranked, index: number): string {
  return `## Memory ${index + 1}\nConversation date: ${row.date}.\n`;
}

function completePrefixEnd(text: string, requested: number): number {
  if (requested >= text.length) return text.length;
  if (requested <= 0) return 0;
  const newline = text.lastIndexOf("\n", requested - 1);
  return newline > 0 ? newline : 0;
}

function renderRanges(text: string, ranges: readonly Range[]): string {
  return ranges.map((range, index) => {
    const prefix = range.start > 0 && index === 0 ? "…\n" : "";
    const gap = index > 0 ? "\n…\n" : "";
    const suffix = range.end < text.length && index === ranges.length - 1 ? "\n…" : "";
    return `${gap}${prefix}${text.slice(range.start, range.end)}${suffix}`;
  }).join("");
}

function mergeRanges(ranges: readonly Range[]): Range[] {
  return [...ranges]
    .sort((left, right) => left.start - right.start)
    .reduce<Range[]>((merged, range) => {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push({ ...range });
      return merged;
    }, []);
}

function isWhole(ranges: readonly Range[], length: number): boolean {
  return ranges.length === 1 && ranges[0]!.start === 0 && ranges[0]!.end === length;
}

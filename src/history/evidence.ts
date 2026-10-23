import { matchTokens } from "../text/match.js";

export interface EvidenceSource {
  text: string;
  observed_at?: string;
  date_kind?: "observed" | "record_updated";
}

export interface EvidenceOptions {
  max_chars: number;
  query?: string;
  per_source_chars?: number;
  preferred_speaker?: "user" | "assistant";
}

export interface EvidenceRange {
  start: number;
  end: number;
}

export interface RenderedEvidenceSource {
  source_index: number;
  ranges: EvidenceRange[];
  full_chars: number;
  used_chars: number;
  truncated: boolean;
}

export interface RenderedEvidence {
  text: string;
  sources: RenderedEvidenceSource[];
}

interface SourceState {
  source: EvidenceSource;
  sourceIndex: number;
  date?: ValidDate;
}

interface ValidDate {
  text: string;
  time: number;
}

const ELLIPSIS = "…";
const GENERIC_QUERY_TOKENS = new Set([
  "am", "are", "can", "could", "did", "doe", "does", "had", "has", "have",
  "how", "me", "mine", "my", "our", "please", "should", "tell",
  "the", "us", "what", "when", "where", "which", "who", "why",
  "was", "were", "will", "would", "you", "your", "yours",
]);

/**
 * Choose whose past words should lead evidence ranking. This is a retrieval
 * preference only: it never authenticates a source or changes its authority.
 */
export function preferredEvidenceSpeaker(query: string): "user" | "assistant" {
  const normalized = query.toLowerCase();
  const assistantPastVerb = "(?:recommended|suggested|advised|told|said|proposed|provided|listed|gave|shared|mentioned|offered)";
  const assistantBaseVerb = "(?:recommend|suggest|advise|tell|say|propose|provide|list|give|share|mention|offer)";
  const recallsAssistantAction = new RegExp(
    `\\b(?:what|which|who|where|when|how)\\b[\\s\\S]{0,80}\\b(?:did|have|had)\\s+you\\b[\\s\\S]{0,80}\\b${assistantBaseVerb}\\w*\\b`,
  ).test(normalized);
  const explicitPastAttribution = new RegExp(
    `\\byou\\s+(?:(?:have|had)\\s+)?${assistantPastVerb}\\b`,
  ).test(normalized)
    || new RegExp(`\\b(?:have|had)\\s+you\\s+${assistantPastVerb}\\b`).test(normalized);
  const asksForPastAdvice = /\byour\s+(?:earlier|previous|prior|past)\s+(?:advice|recommendation|suggestion|guidance|answer|response)\b/.test(normalized);
  const recallsNamedAdvice = /\b(?:earlier|previous|prior|past)\s+(?:advice|recommendation|suggestion|guidance)\b[\s\S]{0,80}\byou\b/.test(normalized);
  return recallsAssistantAction || explicitPastAttribution || asksForPastAdvice || recallsNamedAdvice
    ? "assistant"
    : "user";
}

/**
 * Render source excerpts for model context without exposing storage IDs.
 *
 * Ranges always index the input `text` in JavaScript UTF-16 code units. This
 * lets diagnostics prove exactly what was shown without adding opaque source
 * identifiers to the prompt.
 */
export function renderEvidenceSources(
  sources: readonly EvidenceSource[],
  options: EvidenceOptions,
): RenderedEvidence {
  const perSourceChars = validateOptions(options);
  if (sources.length === 0) return { text: "", sources: [] };

  const states = sources.map((source, sourceIndex) => ({
    source,
    sourceIndex,
    date: parseEvidenceDate(source.observed_at),
  }));
  const metadata = sources.map((source, sourceIndex) => ({
    source_index: sourceIndex,
    ranges: [] as EvidenceRange[],
    full_chars: source.text.length,
    used_chars: 0,
    truncated: source.text.length > 0,
  }));
  const candidates = states
    .filter((state) => state.source.text.length > 0)
    .map((state) => makeCandidate(state, options.query, perSourceChars, options.preferred_speaker))
    .filter((candidate): candidate is EvidenceCandidate => candidate !== undefined);
  if (candidates.length === 0) return { text: "", sources: metadata };

  const included = selectCandidates(candidates, options.max_chars);
  if (included.length === 0) {
    throw new RangeError("max_chars is too small to render an evidence label and a complete source unit");
  }
  const ordered = [...included].sort((left, right) => compareSourceState(left.state, right.state));
  const text = renderCandidates(ordered);
  for (const candidate of ordered) {
    const metadataEntry = metadata[candidate.state.sourceIndex]!;
    metadataEntry.ranges = candidate.ranges;
    metadataEntry.used_chars = candidate.ranges.reduce((total, range) => total + range.end - range.start, 0);
    metadataEntry.truncated = !isWholeSource(candidate.ranges, candidate.state.source.text.length);
  }
  if (text.length > options.max_chars) {
    throw new Error("Evidence renderer exceeded its character budget");
  }
  return { text, sources: metadata };
}

function validateOptions(options: EvidenceOptions): number {
  if (!Number.isSafeInteger(options.max_chars) || options.max_chars <= 0) {
    throw new RangeError("max_chars must be a positive safe integer");
  }
  if (
    options.per_source_chars !== undefined
    && (!Number.isSafeInteger(options.per_source_chars) || options.per_source_chars <= 0)
  ) {
    throw new RangeError("per_source_chars must be a positive safe integer");
  }
  return options.per_source_chars ?? options.max_chars;
}

function compareSourceState(left: SourceState, right: SourceState): number {
  if (left.date && right.date) {
    return left.date.time - right.date.time || left.sourceIndex - right.sourceIndex;
  }
  if (left.date) return -1;
  if (right.date) return 1;
  return left.sourceIndex - right.sourceIndex;
}

function headerFor(state: SourceState, number: number): string {
  const title = `## Memory ${number}\n`;
  if (!state.date) return title;
  const label = state.source.date_kind === "record_updated" ? "Record updated" : "Observed";
  return `${title}${label}: ${state.date.text}\n`;
}

interface EvidenceCandidate {
  state: SourceState;
  ranges: EvidenceRange[];
  text: string;
}

function makeCandidate(
  state: SourceState,
  query: string | undefined,
  sourceCap: number,
  preferredSpeaker: EvidenceOptions["preferred_speaker"],
): EvidenceCandidate | undefined {
  const ranges = chooseSemanticRanges(state.source.text, query, sourceCap, preferredSpeaker);
  if (ranges.length === 0) return undefined;
  return { state, ranges, text: renderRanges(state.source.text, ranges) };
}

function selectCandidates(candidates: readonly EvidenceCandidate[], maxChars: number): EvidenceCandidate[] {
  const included: EvidenceCandidate[] = [];
  // Complete short sources win the shared budget first; text is still emitted
  // in its chronological source order below.
  const priority = [...candidates].sort((left, right) =>
    left.text.length - right.text.length || left.state.sourceIndex - right.state.sourceIndex,
  );
  for (const candidate of priority) {
    const prospective = [...included, candidate].sort((left, right) =>
      compareSourceState(left.state, right.state),
    );
    if (renderCandidates(prospective).length <= maxChars) included.push(candidate);
  }
  return included;
}

function renderCandidates(candidates: readonly EvidenceCandidate[]): string {
  return candidates.map((candidate, index) =>
    `${headerFor(candidate.state, index + 1)}${candidate.text}`,
  ).join("\n\n");
}

function chooseSemanticRanges(
  text: string,
  query: string | undefined,
  charCap: number,
  preferredSpeaker: EvidenceOptions["preferred_speaker"],
): EvidenceRange[] {
  if (text.length <= charCap) return [{ start: 0, end: text.length }];
  const queryTokens = informativeQueryTokens(query ?? "");
  const units = semanticUnits(text, queryTokens);
  const ranked = units
    .filter((unit) => unit.score > 0)
    .sort((left, right) => speakerRank(left, preferredSpeaker) - speakerRank(right, preferredSpeaker)
      || right.score - left.score
      || right.index - left.index);
  if (ranked.length === 0) {
    for (const unit of units) {
      if (fitsIndexes(new Set(), [...unit.context, unit.index], units, charCap)) {
        return mergeRanges([...unit.context, unit.index].map((candidate) => units[candidate]!.range));
      }
    }
    return [];
  }
  const selected = new Set<number>();
  const primary = new Set<number>();
  for (const unit of ranked) {
    if (fitsIndexes(selected, [...unit.context, unit.index], units, charCap)) {
      for (const index of unit.context) selected.add(index);
      selected.add(unit.index);
      primary.add(unit.index);
    }
  }
  // Add immediate context after preserving every independently relevant fact.
  // A neighbor brings its mandatory role, heading, and negating scope too.
  for (const index of [...primary].sort((left, right) => left - right)) {
    for (const adjacent of [index - 1, index + 1]) {
      const adjacentUnit = units[adjacent];
      if (!adjacentUnit || selected.has(adjacent)) continue;
      if (fitsIndexes(selected, [...adjacentUnit.context, adjacent], units, charCap)) {
        for (const context of adjacentUnit.context) selected.add(context);
        selected.add(adjacent);
      }
    }
  }
  return mergeRanges([...selected].map((index) => units[index]!.range));
}

interface SemanticUnit {
  index: number;
  range: EvidenceRange;
  score: number;
  context: number[];
  speaker?: string;
}

function semanticUnits(text: string, queryTokens: ReadonlySet<string>): SemanticUnit[] {
  const ranges: EvidenceRange[] = [];
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    if (lineStart < lineEnd) {
      ranges.push({ start: lineStart, end: lineEnd });
    }
    lineStart = newline === -1 ? text.length : newline + 1;
  }
  const windows = ranges.length > 0 ? ranges : [{ start: 0, end: text.length }];
  const units: SemanticUnit[] = [];
  let activeRole = -1;
  let activeSpeaker: string | undefined;
  let activeHeading = -1;
  let previousNegatingScope = -1;
  for (const [index, range] of windows.entries()) {
    const unitText = text.slice(range.start, range.end).trim();
    const explicitSpeaker = roleSpeaker(unitText);
    const isRole = explicitSpeaker !== undefined;
    const context = isRole
      ? []
      : [activeRole, activeHeading, previousNegatingScope]
        .flatMap((candidate) => candidate >= 0
          ? [candidate, ...units[candidate]!.context]
          : [],
        )
        .filter((candidate) => candidate !== index);
    units.push({
      index,
      range,
      score: overlapScore(unitText, queryTokens),
      context: [...new Set(context)],
      speaker: explicitSpeaker ?? activeSpeaker,
    });
    if (isRole) {
      activeRole = index;
      activeSpeaker = explicitSpeaker;
      activeHeading = -1;
    } else if (unitText.endsWith(":")) {
      activeHeading = index;
    }
    previousNegatingScope = isNegatingScope(unitText) ? index : -1;
  }
  return units;
}

function roleSpeaker(text: string): string | undefined {
  return /^(user|assistant|system|tool):\s*/i.exec(text)?.[1]?.toLowerCase();
}

function isNegatingScope(text: string): boolean {
  return /\b(?:not|never|reject(?:ed|ion)?|avoid|deprecated|obsolete|do\s+not|don['’]?t)\b/i.test(text);
}

function fitsIndexes(
  selected: ReadonlySet<number>,
  additions: readonly number[],
  units: readonly SemanticUnit[],
  charCap: number,
): boolean {
  const ranges = mergeRanges([
    ...[...selected].map((index) => units[index]!.range),
    ...additions.map((index) => units[index]!.range),
  ]);
  return ranges.reduce((total, range) => total + range.end - range.start, 0) <= charCap;
}

function overlapScore(text: string, queryTokens: ReadonlySet<string>): number {
  if (queryTokens.size === 0) return 0;
  const tokens = new Set(matchTokens(text));
  let overlap = 0;
  for (const token of tokens) if (queryTokens.has(token)) overlap++;
  return overlap * 1_000 + (overlap > 0 ? Math.min(tokens.size, 999) : 0);
}

function informativeQueryTokens(query: string): Set<string> {
  return new Set(matchTokens(query).filter((token) => !GENERIC_QUERY_TOKENS.has(token)));
}

function speakerRank(
  unit: SemanticUnit,
  preferredSpeaker: EvidenceOptions["preferred_speaker"],
): number {
  return preferredSpeaker && unit.speaker === preferredSpeaker ? 0 : 1;
}

function mergeRanges(ranges: readonly EvidenceRange[]): EvidenceRange[] {
  return [...ranges]
    .sort((left, right) => left.start - right.start)
    .reduce<EvidenceRange[]>((merged, range) => {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end + 1) {
        previous.end = Math.max(previous.end, range.end);
      } else {
        merged.push({ ...range });
      }
      return merged;
    }, []);
}

function renderRanges(text: string, ranges: readonly EvidenceRange[]): string {
  return ranges.map((range, index) => {
    const prefix = range.start > 0 && index === 0 ? `${ELLIPSIS}\n` : "";
    const gap = index > 0 ? `\n${ELLIPSIS}\n` : "";
    const suffix = range.end < text.length && index === ranges.length - 1 ? `\n${ELLIPSIS}` : "";
    return `${gap}${prefix}${text.slice(range.start, range.end)}${suffix}`;
  }).join("");
}

function isWholeSource(ranges: readonly EvidenceRange[], length: number): boolean {
  return ranges.length === 1 && ranges[0]!.start === 0 && ranges[0]!.end === length;
}

function parseEvidenceDate(value: string | undefined): ValidDate | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, , zone] = match;
  if (!isRealCalendarDate(Number(year), Number(month), Number(day))) return undefined;
  const dateTime = Date.parse(`${year}-${month}-${day}T00:00:00Z`);
  if (!Number.isFinite(dateTime)) return undefined;
  if (hour === undefined) return { text: value, time: dateTime };
  if (!zone || Number(hour) > 23 || Number(minute) > 59 || (second !== undefined && Number(second) > 59)) {
    return undefined;
  }
  if (zone !== "Z") {
    const [offsetHour, offsetMinute] = zone.slice(1).split(":").map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return undefined;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? { text: value, time } : undefined;
}

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const monthLengths = [
    31,
    (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ];
  return day <= monthLengths[month - 1]!;
}

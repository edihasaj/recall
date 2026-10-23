import { normalizeTemporalTimestamp } from "../src/temporal/intake-contract.js";

// Offline calendar helper for source-relative English date words.
//
// resolveSourceDateExpression resolves ONE complete expression against the day a source statement
// was recorded. Its whole grammar is optional outer whitespace around today, yesterday, tomorrow or
// "last <full weekday name>". Anything larger or different is "unsupported" with no candidates; no
// sub-phrase is ever extracted, so qualifiers ("in June", "two years ago") cannot be silently dropped.
//
// discoverSourceDateMentions only locates candidate words in raw prose. Every mention stays
// "unresolved" and carries no date or clock until a complete phrase is selected and reviewed elsewhere.
//
// Neither function identifies events, or asserts completion, plans, negation, status or authorship.
// Text is evidence data: quoted metadata inside it is never a trusted role. No question clock, id,
// gold answer or category is accepted.
//
// Calendar basis assumption: `observedAt` keeps the calendar day as recorded (its first ten
// characters). A timestamp is validated with normalizeTemporalTimestamp but NOT converted to UTC for
// the day, so "2026-03-01T23:30:00-05:00" is recorded day 2026-03-01 although its UTC instant is
// 2026-03-02. This assumes the offset reflects the author's wall clock; it is not proof of the
// author's actual timezone.

export const MAX_SOURCE_TEXT_LENGTH = 16000;

export interface DateCandidate {
  date: string;
  bases: string[];
}

export interface SourceDateResolution {
  status: "resolved" | "ambiguous" | "unsupported";
  expression: string;
  source_calendar_day: string;
  candidates: DateCandidate[];
}

export interface SourceDateMention {
  start: number; // UTF-16 code unit offsets into the scanned text
  end: number;
  expression: string;
  status: "unresolved";
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const PHRASE = `today|yesterday|tomorrow|last\\s+(?:${WEEKDAYS.join("|")})`;
const SUPPORTED = new RegExp(`^\\s*(?:(today|yesterday|tomorrow)|last\\s+(${WEEKDAYS.join("|")}))\\s*$`, "iu");
const MENTION = new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${PHRASE})(?![\\p{L}\\p{N}_-])`, "giu");

export function resolveSourceDateExpression(expression: string, observedAt: string): SourceDateResolution {
  const day = recordedCalendarDay(observedAt);
  checkText(expression, "expression");
  const match = SUPPORTED.exec(expression);
  if (match === null) return { status: "unsupported", expression, source_calendar_day: day, candidates: [] };
  const observedDays = dayNumber(day);
  const candidates = match[1] !== undefined
    ? fixedOffsetCandidates(match[1].toLowerCase(), observedDays)
    : lastWeekdayCandidates(WEEKDAYS.indexOf(match[2].toLowerCase()), observedDays);
  return {
    status: candidates.length > 1 ? "ambiguous" : "resolved",
    expression,
    source_calendar_day: day,
    candidates,
  };
}

export function discoverSourceDateMentions(text: string): SourceDateMention[] {
  checkText(text, "text");
  return [...text.matchAll(MENTION)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    expression: m[0],
    status: "unresolved" as const,
  }));
}

function checkText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  if (value.length > MAX_SOURCE_TEXT_LENGTH) {
    throw new RangeError(`${name} must be at most ${MAX_SOURCE_TEXT_LENGTH} UTF-16 code units`);
  }
}

function recordedCalendarDay(observedAt: string): string {
  if (typeof observedAt !== "string") throw new TypeError("observedAt must be a string");
  if (normalizeTemporalTimestamp(observedAt) === null) {
    throw new RangeError("observedAt must be a real YYYY-MM-DD date or an ISO timestamp with a timezone");
  }
  return observedAt.slice(0, 10);
}

function fixedOffsetCandidates(word: string, observedDays: number): DateCandidate[] {
  if (word === "today") return merge([["observed_day", observedDays]]);
  if (word === "yesterday") return merge([["observed_day_minus_1", observedDays - 1]]);
  return merge([["observed_day_plus_1", observedDays + 1]]);
}

function lastWeekdayCandidates(target: number, observedDays: number): DateCandidate[] {
  const observedWeekday = weekdayOf(observedDays);
  // Most recent strictly preceding occurrence; the same weekday means seven days ago.
  const back = (observedWeekday - target + 7) % 7 || 7;
  // The same weekday inside the previous ISO calendar week (Monday..Sunday).
  const sinceMonday = (observedWeekday + 6) % 7;
  const previousWeek = observedDays - sinceMonday - 7 + ((target + 6) % 7);
  return merge([
    ["most_recent_preceding_weekday", observedDays - back],
    ["previous_iso_week_weekday", previousWeek],
  ]);
}

// Deduplicates by date, merging basis labels; candidates are ordered by date, with no winner.
function merge(readings: Array<[string, number]>): DateCandidate[] {
  const byDate = new Map<string, string[]>();
  for (const [basis, days] of readings) {
    const date = formatDay(days);
    const bases = byDate.get(date) ?? [];
    if (!bases.includes(basis)) bases.push(basis);
    byDate.set(date, bases);
  }
  return [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, bases]) => ({ date, bases }));
}

// Proleptic Gregorian day arithmetic that avoids Date.UTC's two-digit-year remapping. Day 0 is 1970-01-01.
function dayNumber(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + date - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function formatDay(days: number): string {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const date = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime < 10 ? monthPrime + 3 : monthPrime - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  if (year < 0 || year > 9999) throw new RangeError("calendar arithmetic left years 0000..9999");
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
}

// 0 = Sunday .. 6 = Saturday; 1970-01-01 was a Thursday.
function weekdayOf(days: number): number {
  return (((days + 4) % 7) + 7) % 7;
}

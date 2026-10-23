import { createHash } from "node:crypto";

export type IntakeRoute = "temporal" | "ordinary" | "ignore" | "defer";

export interface CaptureFactProposal {
  key_id?: string | null;
  subject?: string;
  predicate?: string;
  value: string;
  valid_from: string | null;
  valid_to: string | null;
  time_basis: "explicit" | "observed";
  quote: string;
  supersedes_event_id: string | null;
  replacement_quote?: string;
}

export interface CaptureResponse {
  route: IntakeRoute;
  memory_type?: "rule" | "command" | "gotcha" | "decision" | "review_pattern";
  facts?: CaptureFactProposal[];
}

export interface QueryResponse {
  route: "temporal" | "fallback";
  key_id?: string;
  as_of?: string;
  observed_before?: string;
}

export function canonicalLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  return normalized && normalized.length <= 500 ? normalized : null;
}

export function canonicalPredicate(value: unknown): string | null {
  const label = canonicalLabel(value);
  if (!label) return null;
  const snake = label.replace(/[\s-]+/g, "_");
  return /^[a-z][a-z0-9_]{0,499}$/.test(snake) ? snake : null;
}

export function stableTemporalKey(repo: string, subject: string, predicate: string): string {
  // A JSON tuple keeps embedded separators unambiguous and uses the exact
  // canonical labels the store uses when it groups an assertion key.
  const tuple = [
    repo.trim(),
    canonicalLabel(subject) ?? subject.trim().toLocaleLowerCase("en-US"),
    canonicalPredicate(predicate) ?? predicate.trim().toLocaleLowerCase("en-US"),
  ];
  return createHash("sha256").update(JSON.stringify(tuple)).digest("hex").slice(0, 24);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** Matches the store's public timestamp contract without reaching into its internals. */
export function normalizeTemporalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = DATE_ONLY.exec(value);
  if (date) {
    const [year, month, day] = date.slice(1).map(Number);
    if (!realDate(year, month, day)) return null;
    const result = new Date(0);
    result.setUTCHours(0, 0, 0, 0);
    result.setUTCFullYear(year, month - 1, day);
    return result.toISOString();
  }
  const match = ISO_WITH_OFFSET.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offset] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  if (!realDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  if (offset !== "Z") {
    const [offsetHour, offsetMinute] = offset.slice(1).split(":").map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getUTCFullYear() < 0 || parsed.getUTCFullYear() > 9999) return null;
  return parsed.toISOString();
}

function realDate(year: number, month: number, day: number): boolean {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maximum = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return month >= 1 && month <= 12 && day >= 1 && day <= maximum;
}

export function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

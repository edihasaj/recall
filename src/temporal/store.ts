import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";

export interface TemporalFact {
  id: string;
  repo: string;
  event_id: string;
  subject: string;
  predicate: string;
  value: string;
  valid_from: string;
  valid_to: string | null;
  observed_at: string;
  evidence: string;
  source: string | null;
  confidence: number;
  supersedes_id: string | null;
  recorded_at: string;
}

export interface AppendTemporalFactInput {
  repo: string;
  event_id: string;
  subject: string;
  predicate: string;
  value: string;
  valid_from: string;
  valid_to?: string | null;
  observed_at: string;
  evidence: string;
  source?: string | null;
  confidence?: number;
  supersedes_id?: string | null;
}

export interface TemporalQueryInput {
  repo: string;
  subject: string;
  predicate: string;
  as_of?: string;
  observed_before?: string;
  mode?: "snapshot" | "history";
  limit?: number;
}

export interface TemporalQueryResult {
  facts: TemporalFact[];
  conflict: boolean;
  matched_count: number;
  truncated: boolean;
  as_of: string;
  observed_before: string;
  mode: "snapshot" | "history";
}

interface NormalizedAppendInput extends Omit<AppendTemporalFactInput, "valid_to" | "source" | "confidence" | "supersedes_id"> {
  valid_to: string | null;
  source: string | null;
  confidence: number;
  supersedes_id: string | null;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

export function appendTemporalFact(db: RecallDb, input: AppendTemporalFactInput): TemporalFact {
  const normalized = normalizeAppendInput(input);
  const existing = findByEvent(db, normalized.repo, normalized.event_id);
  if (existing) {
    if (samePayload(existing, normalized)) return existing;
    throw new Error("temporal event_id already exists with different assertion data");
  }

  if (normalized.supersedes_id) {
    const superseded = findById(db, normalized.supersedes_id);
    if (!superseded) throw new Error("supersedes_id does not reference an existing assertion");
    if (
      superseded.repo !== normalized.repo
      || superseded.subject !== normalized.subject
      || superseded.predicate !== normalized.predicate
    ) {
      throw new Error("supersedes_id must reference the same repo, subject, and predicate");
    }
    if (Date.parse(normalized.observed_at) < Date.parse(superseded.observed_at)) {
      throw new Error("observed_at cannot predate the assertion being superseded");
    }
  }

  const fact: TemporalFact = {
    id: randomUUID(),
    ...normalized,
    recorded_at: new Date().toISOString(),
  };
  try {
    db.$client.prepare(`
      insert into temporal_facts (
        id, repo, event_id, subject, predicate, value, valid_from, valid_to,
        observed_at, evidence, source, confidence, supersedes_id, recorded_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fact.id, fact.repo, fact.event_id, fact.subject, fact.predicate, fact.value,
      fact.valid_from, fact.valid_to, fact.observed_at, fact.evidence, fact.source,
      fact.confidence, fact.supersedes_id, fact.recorded_at,
    );
  } catch (error) {
    // A concurrent replay can lose the race after its first lookup. Preserve
    // idempotence without making an event id a mutable upsert key.
    const raced = findByEvent(db, normalized.repo, normalized.event_id);
    if (raced && samePayload(raced, normalized)) return raced;
    throw error;
  }
  return fact;
}

export function queryTemporalFacts(db: RecallDb, input: TemporalQueryInput): TemporalQueryResult {
  const repo = normalizedIdentifier(input.repo, "repo", 500, false);
  const subject = normalizedIdentifier(input.subject, "subject", 500, true);
  const predicate = normalizedIdentifier(input.predicate, "predicate", 500, true);
  const now = new Date().toISOString();
  const asOf = normalizeTimestamp(input.as_of ?? now, "as_of");
  const observedBefore = normalizeTimestamp(input.observed_before ?? now, "observed_before");
  const mode = input.mode ?? "snapshot";
  if (mode !== "snapshot" && mode !== "history") throw new Error("mode must be snapshot or history");
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer from 1 to 100");
  }

  const visible = db.$client.prepare(`
    select * from temporal_facts
    where repo = ? and subject = ? and predicate = ? and observed_at <= ?
    order by observed_at asc, valid_from asc, id asc
  `).all(repo, subject, predicate, observedBefore) as TemporalFact[];
  const resolved = mode === "history" ? visible : resolveSnapshot(visible, asOf);
  const matchedCount = resolved.length;
  return {
    facts: resolved.slice(0, limit),
    conflict: mode === "snapshot" && new Set(resolved.map((fact) => fact.value)).size > 1,
    matched_count: matchedCount,
    truncated: matchedCount > limit,
    as_of: asOf,
    observed_before: observedBefore,
    mode,
  };
}

function resolveSnapshot(visible: TemporalFact[], asOf: string): TemporalFact[] {
  const retired = new Set<string>();
  for (const successor of visible) {
    if (successor.supersedes_id && successor.valid_from <= asOf) retired.add(successor.supersedes_id);
  }
  return visible.filter((fact) => (
    !retired.has(fact.id)
    && fact.valid_from <= asOf
    && (fact.valid_to === null || asOf < fact.valid_to)
  ));
}

function normalizeAppendInput(input: AppendTemporalFactInput): NormalizedAppendInput {
  const repo = normalizedIdentifier(input.repo, "repo", 500, false);
  const event_id = normalizedIdentifier(input.event_id, "event_id", 200, false);
  const subject = normalizedIdentifier(input.subject, "subject", 500, true);
  const predicate = normalizedIdentifier(input.predicate, "predicate", 500, true);
  const value = requiredOriginalText(input.value, "value", 4000);
  const evidence = requiredOriginalText(input.evidence, "evidence", 16000);
  const valid_from = normalizeTimestamp(input.valid_from, "valid_from");
  const valid_to = input.valid_to == null ? null : normalizeTimestamp(input.valid_to, "valid_to");
  if (valid_to && valid_to <= valid_from) throw new Error("valid_to must be after valid_from");
  const observed_at = normalizeTimestamp(input.observed_at, "observed_at");
  const source = input.source == null ? null : boundedText(input.source, "source", 1000);
  const confidence = input.confidence ?? 0.5;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("confidence must be a finite number from 0 to 1");
  }
  const supersedes_id = input.supersedes_id == null ? null : normalizedIdentifier(input.supersedes_id, "supersedes_id", 1000, false);
  return {
    repo, event_id, subject, predicate, value, valid_from, valid_to, observed_at,
    evidence, source, confidence, supersedes_id,
  };
}

function normalizedIdentifier(value: unknown, field: string, max: number, fold: boolean): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must not be blank`);
  const normalized = fold ? trimmed.replace(/\s+/g, " ").toLocaleLowerCase("en-US") : trimmed;
  if (normalized.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return normalized;
}

function requiredOriginalText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must not be blank`);
  if (value.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return value;
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  if (value.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return value;
}

function normalizeTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be an ISO timestamp or YYYY-MM-DD date`);
  const date = DATE_ONLY.exec(value);
  if (date) {
    const [year, month, day] = date.slice(1).map(Number);
    assertCalendarDate(year, month, day, field);
    return utcDate(year, month, day).toISOString();
  }
  const timestamp = ISO_WITH_OFFSET.exec(value);
  if (!timestamp) throw new Error(`${field} must include a timezone offset`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offset] = timestamp;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  assertCalendarDate(year, month, day, field);
  if (hour > 23 || minute > 59 || second > 59) throw new Error(`${field} contains an invalid time`);
  if (offset !== "Z") {
    const [offsetHour, offsetMinute] = offset.slice(1).split(":").map(Number);
    if (offsetHour > 23 || offsetMinute > 59) throw new Error(`${field} contains an invalid timezone offset`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be a real timestamp`);
  if (parsed.getUTCFullYear() < 0 || parsed.getUTCFullYear() > 9999) {
    throw new Error(`${field} must normalize to a four-digit UTC year`);
  }
  return parsed.toISOString();
}

function assertCalendarDate(year: number, month: number, day: number, field: string) {
  const daysInMonth = month === 2
    ? (isLeapYear(year) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) {
    throw new Error(`${field} must be a real calendar date`);
  }
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function findByEvent(db: RecallDb, repo: string, eventId: string): TemporalFact | null {
  return (db.$client.prepare("select * from temporal_facts where repo = ? and event_id = ?").get(repo, eventId) as TemporalFact | undefined) ?? null;
}

function findById(db: RecallDb, id: string): TemporalFact | null {
  return (db.$client.prepare("select * from temporal_facts where id = ?").get(id) as TemporalFact | undefined) ?? null;
}

function samePayload(existing: TemporalFact, input: NormalizedAppendInput): boolean {
  return existing.repo === input.repo
    && existing.event_id === input.event_id
    && existing.subject === input.subject
    && existing.predicate === input.predicate
    && existing.value === input.value
    && existing.valid_from === input.valid_from
    && existing.valid_to === input.valid_to
    && existing.observed_at === input.observed_at
    && existing.evidence === input.evidence
    && existing.source === input.source
    && existing.confidence === input.confidence
    && existing.supersedes_id === input.supersedes_id;
}

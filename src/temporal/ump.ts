import { createHash } from "node:crypto";
import { validateDraft, type MemoryDraft } from "@universalmemoryprotocol/core";
import { initStandaloneDb, type RecallDb } from "../db/client.js";
import { redactSensitiveText } from "../security/redaction.js";
import {
  captureTemporalSource,
  type PredicatePolicy,
  type TemporalCaptureResult,
  type TemporalLanguageSource,
} from "./intake-v3.js";
import {
  canonicalLabel,
  normalizeTemporalTimestamp,
  type CaptureFactProposal,
} from "./intake-contract.js";
import { appendTemporalFact, queryTemporalFacts, type TemporalFact, type TemporalQueryResult } from "./store.js";

const PROFILE = "recall.temporal.v1";
const UNSUPPORTED_FIELDS = [
  "id", "consent", "relations", "supersedes", "superseded_by", "integrity", "lifecycle",
] as const;

export interface UmpTemporalContext {
  owner: string;
  source: TemporalLanguageSource;
  predicates?: readonly PredicatePolicy[];
}

export interface UmpTemporalQuery {
  owner: string;
  repo: string;
  subject: string;
  predicate: string;
  as_of?: string;
  observed_before?: string;
  mode?: "snapshot" | "history";
  limit?: number;
}

interface UmpTemporalProposal extends CaptureFactProposal {
  subject: string;
  predicate: string;
  value: string;
  quote: string;
  valid_from: string;
  valid_to: string | null;
  time_basis: "observed" | "explicit";
  supersedes_event_id: string | null;
  replacement_quote?: string;
}

interface ParsedRecord {
  proposal: UmpTemporalProposal;
  canonical_record: Record<string, unknown>;
}

/**
 * Captures one state assertion from a deliberately narrow UMP profile.
 *
 * This adapter neither writes ordinary Recall memories nor accepts arbitrary
 * UMP lifecycle, consent, relationship, or integrity fields. The temporal
 * language adapter remains the final authority for grounding, ownership,
 * uncertainty, dates, replacements, sensitivity, and evidence receipts.
 */
export async function captureUmpTemporalRecord(
  db: RecallDb,
  record: unknown,
  context: UmpTemporalContext,
): Promise<TemporalCaptureResult> {
  const parsed = parseRecord(record, context);
  if (typeof parsed === "string") return deferred(parsed);

  const source = namespacedSource(context.owner, context.source);
  if (!source) return deferred("invalid_context");

  const sourceIdentity = trustedSourceIdentity(context.source);
  if (!sourceIdentity) return deferred("invalid_context");
  const prior = sourceFacts(db, source);
  if (prior.length > 1) return deferred("replay_conflict");
  if (prior.length === 1) {
    if (!sameReceipt(prior, parsed.canonical_record, sourceIdentity)) return deferred("replay_conflict");
    return { route: "temporal", stored: prior, rejected: [], error: null, raw_output: null };
  }

  // Validate away from the real namespace so capture-v3 never sees the current
  // source and short-circuits through its source-text replay path. The source
  // history is copied with original IDs, preserving replacement checks.
  const scratch = initStandaloneDb(":memory:");
  try {
    const catalog = visibleSourceFacts(db, source);
    if (catalog.length > 200) return deferred("catalog_overflow");
    copyFacts(scratch, catalog);
    const checked = await captureTemporalSource(scratch, source, {
      predicates: context.predicates,
      model: async () => JSON.stringify({ route: "temporal", facts: [parsed.proposal] }),
    });
    if (checked.stored.length === 0) return checked;

    const receipt = JSON.stringify({
      version: "ump-temporal-v1",
      record: parsed.canonical_record,
      source: sourceIdentity,
      validated_evidence: checked.stored[0]!.evidence,
    });
    if (receipt.length > 16_000 || sensitive(receipt)) return deferred("receipt_too_large");

    let stored: TemporalFact[] = [];
    let raced: TemporalFact[] | null = null;
    try {
      db.$client.transaction(() => {
        // Re-read inside the write transaction so an identical concurrent
        // replay succeeds, while a different profile fails closed.
        const current = sourceFacts(db, source);
        if (current.length !== 0) {
          raced = current;
          return;
        }
        stored = checked.stored.map((fact) => appendTemporalFact(db, {
          repo: source.repo,
          event_id: fact.event_id,
          subject: fact.subject,
          predicate: fact.predicate,
          value: fact.value,
          valid_from: fact.valid_from,
          valid_to: fact.valid_to,
          observed_at: fact.observed_at,
          evidence: receipt,
          source: source.event_id,
          confidence: fact.confidence,
          supersedes_id: fact.supersedes_id,
        }));
      })();
    } catch {
      return deferred("store_rejected");
    }
    if (raced) {
      if (!sameReceipt(raced, parsed.canonical_record, sourceIdentity)) return deferred("replay_conflict");
      return { route: "temporal", stored: raced, rejected: [], error: null, raw_output: null };
    }
    return { ...checked, stored };
  } finally {
    scratch.$client.close();
  }
}

/** Query the private temporal namespace for one UMP owner and project. */
export function queryUmpTemporalRecords(
  db: RecallDb,
  input: UmpTemporalQuery,
): TemporalQueryResult {
  const repo = namespace(input.owner, input.repo);
  if (!repo) throw new Error("owner and repo must be non-blank strings");
  return queryTemporalFacts(db, {
    repo,
    subject: input.subject,
    predicate: input.predicate,
    as_of: input.as_of,
    observed_before: input.observed_before,
    mode: input.mode,
    limit: input.limit,
  });
}

/**
 * Creates the supported UMP draft shape from a v3-compatible proposal.
 * It is pure and intentionally omits server-managed IDs and lifecycle fields.
 */
export function toUmpTemporalDraft(
  source: TemporalLanguageSource,
  owner: string,
  proposal: UmpTemporalProposal,
): MemoryDraft {
  const observed = normalizeTemporalTimestamp(source.observed_at);
  const validFrom = proposal.time_basis === "observed"
    ? observed
    : normalizeTemporalTimestamp(proposal.valid_from);
  const validTo = proposal.valid_to === null ? null : normalizeTemporalTimestamp(proposal.valid_to);
  if (!normalizedText(owner) || !normalizedText(source.repo) || !normalizedText(source.event_id)
    || !observed || !validFrom || (proposal.valid_to !== null && !validTo)) {
    throw new Error("invalid temporal UMP draft inputs");
  }
  return {
    ump: "0.1",
    kind: "semantic",
    body: {
      text: proposal.quote,
      structured: {
        profile: PROFILE,
        subject: proposal.subject,
        predicate: proposal.predicate,
        value: proposal.value,
        quote: proposal.quote,
        time_basis: proposal.time_basis,
        supersedes_event_id: proposal.supersedes_event_id,
        ...(proposal.replacement_quote === undefined ? {} : { replacement_quote: proposal.replacement_quote }),
      },
    },
    scope: { owner, project: source.repo, visibility: "private" },
    time: { observed, valid_from: validFrom, valid_to: validTo },
    provenance: {
      actor: owner,
      actor_kind: "user",
      method: "source_assertion",
      source: { ref: source.event_id },
    },
  };
}

function parseRecord(record: unknown, context: UmpTemporalContext): ParsedRecord | string {
  if (!isObject(record) || !boundedTrustedText(context.owner, 500) || !canonicalTrustedSource(context.source)) return "invalid_ump_record";
  if (UNSUPPORTED_FIELDS.some((field) => Object.hasOwn(record, field))) return "unsupported_ump_field";
  if (!onlyKeys(record, ["ump", "kind", "body", "scope", "time", "provenance"])) return "unsupported_ump_field";
  if (record.ump !== undefined && record.ump !== "0.1") return "invalid_ump_record";
  if (record.kind !== "semantic" && record.kind !== "identity") return "unsupported_ump_kind";
  if (!isObject(record.body) || !onlyKeys(record.body, ["text", "structured"]) || typeof record.body.text !== "string"
    || !isObject(record.body.structured)) return "invalid_ump_record";
  if (!isObject(record.scope) || !onlyKeys(record.scope, ["owner", "project", "visibility"])
    || record.scope.owner !== context.owner || record.scope.project !== context.source.repo
    || record.scope.visibility !== "private") return "scope_mismatch";
  if (!isObject(record.time) || !onlyKeys(record.time, ["observed", "valid_from", "valid_to"])
    || typeof record.time.observed !== "string" || typeof record.time.valid_from !== "string"
    || (record.time.valid_to !== null && typeof record.time.valid_to !== "string")) return "invalid_ump_record";
  if (normalizeTemporalTimestamp(record.time.observed) !== normalizeTemporalTimestamp(context.source.observed_at)) return "time_mismatch";
  if (!isObject(record.provenance) || !onlyKeys(record.provenance, ["actor", "actor_kind", "method", "source"])
    || record.provenance.actor !== context.owner || record.provenance.actor_kind !== "user"
    || record.provenance.method !== "source_assertion" || !isObject(record.provenance.source)
    || !onlyKeys(record.provenance.source, ["ref"]) || record.provenance.source.ref !== context.source.event_id) return "provenance_mismatch";

  const structured = record.body.structured;
  if (!onlyKeys(structured, [
    "profile", "subject", "predicate", "value", "quote", "time_basis", "supersedes_event_id", "replacement_quote",
  ]) || structured.profile !== PROFILE || typeof structured.subject !== "string"
    || typeof structured.predicate !== "string" || typeof structured.value !== "string"
    || typeof structured.quote !== "string" || record.body.text !== structured.quote
    || (structured.time_basis !== "observed" && structured.time_basis !== "explicit")
    || (structured.supersedes_event_id !== null && typeof structured.supersedes_event_id !== "string")
    || (structured.replacement_quote !== undefined && typeof structured.replacement_quote !== "string")) return "invalid_temporal_profile";
  if (!context.source.text.includes(structured.quote)) return "quote_not_in_source";

  const validFrom = normalizeTemporalTimestamp(record.time.valid_from);
  const validTo = record.time.valid_to === null ? null : normalizeTemporalTimestamp(record.time.valid_to);
  if (!validFrom || (record.time.valid_to !== null && !validTo)
    || (validTo !== null && validTo <= validFrom)
    || (structured.time_basis === "observed" && validFrom !== normalizeTemporalTimestamp(context.source.observed_at))) {
    return "time_mismatch";
  }

  const draft: MemoryDraft = record as unknown as MemoryDraft;
  if (validateDraft(draft).length > 0) return "invalid_ump_record";
  const canonical_record = canonicalRecord(record.kind, context.owner, context.source, {
    subject: structured.subject,
    predicate: structured.predicate,
    value: structured.value,
    quote: structured.quote,
    valid_from: validFrom,
    valid_to: validTo,
    time_basis: structured.time_basis,
    supersedes_event_id: structured.supersedes_event_id,
    ...(structured.replacement_quote === undefined ? {} : { replacement_quote: structured.replacement_quote }),
  });
  return {
    proposal: {
      subject: structured.subject,
      predicate: structured.predicate,
      value: structured.value,
      quote: structured.quote,
      valid_from: record.time.valid_from,
      valid_to: record.time.valid_to,
      time_basis: structured.time_basis,
      supersedes_event_id: structured.supersedes_event_id,
      ...(structured.replacement_quote === undefined ? {} : { replacement_quote: structured.replacement_quote }),
    },
    canonical_record,
  };
}

function sourceFacts(db: RecallDb, source: TemporalLanguageSource): TemporalFact[] {
  return db.$client.prepare(
    "select * from temporal_facts where repo = ? and source = ? order by event_id asc",
  ).all(source.repo, source.event_id) as TemporalFact[];
}

function visibleSourceFacts(db: RecallDb, source: TemporalLanguageSource): TemporalFact[] {
  const observedAt = normalizeTemporalTimestamp(source.observed_at);
  if (!observedAt) return [];
  return db.$client.prepare(`
    select * from temporal_facts
    where repo = ? and observed_at <= ? and source != ?
    order by observed_at asc, valid_from asc, id asc
  `).all(source.repo, observedAt, source.event_id) as TemporalFact[];
}

function copyFacts(db: RecallDb, facts: readonly TemporalFact[]): void {
  const insert = db.$client.prepare(`
    insert into temporal_facts (
      id, repo, event_id, subject, predicate, value, valid_from, valid_to,
      observed_at, evidence, source, confidence, supersedes_id, recorded_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const pending = new Map(facts.map((fact) => [fact.id, fact]));
  const copied = new Set<string>();
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((fact) => !fact.supersedes_id || copied.has(fact.supersedes_id));
    if (ready.length === 0) throw new Error("temporal predecessor is absent from scratch catalog");
    for (const fact of ready) {
      insert.run(
        fact.id, fact.repo, fact.event_id, fact.subject, fact.predicate, fact.value,
        fact.valid_from, fact.valid_to, fact.observed_at, fact.evidence, fact.source,
        fact.confidence, fact.supersedes_id, fact.recorded_at,
      );
      copied.add(fact.id);
      pending.delete(fact.id);
    }
  }
}

function canonicalRecord(
  kind: "semantic" | "identity",
  owner: string,
  source: TemporalLanguageSource,
  proposal: UmpTemporalProposal,
): Record<string, unknown> {
  return {
    ump: "0.1",
    kind,
    body: {
      text: proposal.quote,
      structured: {
        profile: PROFILE,
        subject: proposal.subject,
        predicate: proposal.predicate,
        value: proposal.value,
        quote: proposal.quote,
        time_basis: proposal.time_basis,
        supersedes_event_id: proposal.supersedes_event_id,
        ...(proposal.replacement_quote === undefined ? {} : { replacement_quote: proposal.replacement_quote }),
      },
    },
    scope: { owner, project: source.repo, visibility: "private" },
    time: {
      observed: normalizeTemporalTimestamp(source.observed_at),
      valid_from: proposal.valid_from,
      valid_to: proposal.valid_to,
    },
    provenance: {
      actor: owner,
      actor_kind: "user",
      method: "source_assertion",
      source: { ref: source.event_id },
    },
  };
}

function trustedSourceIdentity(source: TemporalLanguageSource): Record<string, unknown> | null {
  const trusted = canonicalTrustedSource(source);
  if (!trusted) return null;
  const identity: Record<string, unknown> = {
    repo: trusted.repo,
    event_id: trusted.event_id,
    text: trusted.text,
    observed_at: trusted.observed_at,
  };
  if (trusted.speaker_spans !== undefined) identity.speaker_spans = trusted.speaker_spans;
  return identity;
}

function parseReceipt(evidence: string): { record: Record<string, unknown>; source: Record<string, unknown> } | null {
  try {
    const value: unknown = JSON.parse(evidence);
    return isObject(value) && value.version === "ump-temporal-v1" && isObject(value.record) && isObject(value.source)
      && typeof value.validated_evidence === "string" ? { record: value.record, source: value.source } : null;
  } catch {
    return null;
  }
}

function sameReceipt(
  facts: readonly TemporalFact[],
  record: Record<string, unknown>,
  source: Record<string, unknown>,
): boolean {
  if (facts.length !== 1) return false;
  const receipt = parseReceipt(facts[0]!.evidence);
  return !!receipt
    && JSON.stringify(receipt.record) === JSON.stringify(record)
    && JSON.stringify(receipt.source) === JSON.stringify(source);
}

function namespacedSource(owner: string, source: TemporalLanguageSource): TemporalLanguageSource | null {
  const trusted = canonicalTrustedSource(source);
  const repo = namespace(owner, trusted?.repo);
  return trusted && repo ? { ...trusted, repo } : null;
}

function namespace(owner: unknown, repo: unknown): string | null {
  const validOwner = boundedTrustedText(owner, 500), validRepo = boundedTrustedText(repo, 500);
  if (!validOwner || !validRepo) return null;
  const hash = createHash("sha256").update(JSON.stringify([validOwner, validRepo])).digest("hex");
  return `ump-temporal:${hash}`;
}

function canonicalTrustedSource(source: TemporalLanguageSource): TemporalLanguageSource | null {
  const repo = boundedTrustedText(source.repo, 500);
  const event_id = boundedTrustedText(source.event_id, 198);
  const observed_at = normalizeTemporalTimestamp(source.observed_at);
  if (!repo || !event_id || !observed_at || typeof source.text !== "string"
    || !source.text.trim() || source.text.length > 16_000 || sensitive(source.text)) return null;
  const speaker_spans = canonicalSpeakerSpans(source.speaker_spans, source.text);
  if (speaker_spans === null) return null;
  return speaker_spans === undefined
    ? { repo, event_id, text: source.text, observed_at }
    : { repo, event_id, text: source.text, observed_at, speaker_spans };
}

function canonicalSpeakerSpans(
  spans: TemporalLanguageSource["speaker_spans"],
  text: string,
): TemporalLanguageSource["speaker_spans"] | null {
  if (spans === undefined) return undefined;
  if (!Array.isArray(spans) || spans.length > 128) return null;
  const normalized: NonNullable<TemporalLanguageSource["speaker_spans"]>[number][] = [];
  let previousEnd = 0;
  for (const span of spans) {
    if (!isObject(span) || !onlyKeys(span, ["start", "end", "role", "subject"])
      || typeof span.start !== "number" || typeof span.end !== "number"
      || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
      || span.start < 0 || span.end <= span.start || span.end > text.length || span.start < previousEnd
      || (span.role !== "user" && span.role !== "assistant")) return null;
    const subject = canonicalLabel(span.subject);
    if (!subject || sensitive(subject)) return null;
    normalized.push({ start: span.start, end: span.end, role: span.role, subject });
    previousEnd = span.end;
  }
  return normalized;
}

function deferred(error: string): TemporalCaptureResult {
  return { route: "defer", stored: [], rejected: [], error, raw_output: null };
}

function normalizedText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedTrustedText(value: unknown, maximum: number): string | null {
  const text = normalizedText(value);
  return text && text.length <= maximum && !sensitive(text) ? text : null;
}

function sensitive(value: string): boolean {
  return redactSensitiveText(value) !== value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

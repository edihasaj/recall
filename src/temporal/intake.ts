import type { RecallDb } from "../db/client.js";
import { redactSensitiveText } from "../security/redaction.js";
import { appendTemporalFact, queryTemporalFacts, type TemporalFact, type TemporalQueryResult } from "./store.js";
import { canonicalLabel, canonicalPredicate, normalizeTemporalTimestamp, parseObject, stableTemporalKey, type CaptureFactProposal, type CaptureResponse, type QueryResponse } from "./intake-contract.js";
import { buildCapturePrompt, buildQueryPrompt, CAPTURE_SYSTEM, QUERY_SYSTEM, type CaptureCatalogEntry, type QueryCatalogEntry } from "./intake-prompts.js";

export type TemporalTextModel = (input: { kind: "capture" | "query"; system: string; user: string }) => Promise<string>;
export interface PredicatePolicy { name: string; description: string; value_kind?: "string" | "integer"; value_case?: "preserve" | "upper" | "lower" }
export interface TemporalLanguageSource { repo: string; event_id: string; text: string; observed_at: string }
export interface TemporalCaptureResult { route: "temporal" | "ordinary" | "ignore" | "defer"; memory_type?: "rule" | "command" | "gotcha" | "decision" | "review_pattern"; stored: TemporalFact[]; rejected: Array<{ index: number; reason: string }>; error: string | null; raw_output: string | null }
const MAX_KEYS = 80, MAX_ASSERTIONS = 200, MAX_CATALOG_CHARS = 16_000, MAX_EVENT_ID = 198;
const NEGATED_OR_UNCERTAIN = /\b(?:not|never|no\s+longer|hypothetical|pretend|example|e\.g\.|if|would|could|should|plan(?:s|ned|ning)?|will|might|one[- ]?task)\b/i;
const REPLACEMENT = /\b(?:correct(?:ion|ed)?|replace(?:d|ment)?|replacing|supersed(?:e|ed|es|ing)|moved|switch(?:ed)?|instead\s+of)\b/i;
interface KnownKey { key_id: string; subject: string; predicate: string; facts: TemporalFact[] }
interface PreparedFact { index: number; input: Omit<Parameters<typeof appendTemporalFact>[1], "repo" | "event_id" | "observed_at" | "evidence" | "source"> }
type Preparation = { value: PreparedFact["input"] } | { error: string };

export async function captureTemporalSource(db: RecallDb, input: TemporalLanguageSource, options: { model: TemporalTextModel; predicates?: readonly PredicatePolicy[] }): Promise<TemporalCaptureResult> {
  const base = (route: TemporalCaptureResult["route"], error: string | null = null, raw_output: string | null = null): TemporalCaptureResult => ({ route, stored: [], rejected: [], error, raw_output });
  const normalized = normalizeSource(input);
  if (!normalized) return base("defer", "invalid_source");
  if (isSensitive(normalized.repo) || isSensitive(normalized.event_id) || isSensitive(normalized.text)) return base("defer", "sensitive_source");
  const replay = sourceReplay(db, normalized);
  if (replay === "replay_conflict") return base("defer", replay);
  if (replay) return { ...base("temporal"), stored: replay };
  const catalogResult = captureCatalog(db, normalized.repo, normalized.observed_at);
  if (typeof catalogResult === "string") return base("defer", catalogResult);
  let raw: string;
  try { raw = await options.model({ kind: "capture", system: CAPTURE_SYSTEM, user: buildCapturePrompt(normalized, catalogResult.entries, options.predicates) }); }
  catch { return base("defer", "model_request_failed"); }
  if (typeof raw !== "string") return base("defer", "model_response_invalid");
  const safeRaw = redactSensitiveText(raw), parsed = parseObject(raw) as CaptureResponse | null;
  if (!parsed || !validRoute(parsed.route)) return base("defer", "model_response_invalid", safeRaw);
  if (parsed.route !== "temporal") return { ...base(parsed.route, null, safeRaw), memory_type: validMemoryType(parsed.memory_type) ? parsed.memory_type : undefined };
  if (!Array.isArray(parsed.facts) || parsed.facts.length === 0 || parsed.facts.length > 3) return base("defer", "invalid_fact_count", safeRaw);
  const rejected: Array<{ index: number; reason: string }> = [], prepared: PreparedFact[] = [];
  for (let index = 0; index < parsed.facts.length; index += 1) {
    const result = prepareFact(parsed.facts[index], normalized, catalogResult.keys, options.predicates);
    if ("error" in result) rejected.push({ index, reason: result.error }); else prepared.push({ index, input: result.value });
  }
  if (prepared.length === 0) return { route: "temporal", stored: [], rejected, error: null, raw_output: safeRaw };
  let stored: TemporalFact[] = [];
  try { db.$client.transaction(() => {
    stored = prepared.map(({ index, input: fact }) => appendTemporalFact(db, { ...fact, repo: normalized.repo, event_id: normalized.event_id + "#" + index, observed_at: normalized.observed_at, evidence: normalized.text, source: normalized.event_id }));
  })(); } catch { stored = []; rejected.push(...prepared.map(({ index }) => ({ index, reason: "store_rejected" }))); }
  return { route: "temporal", stored, rejected, error: null, raw_output: safeRaw };
}

export async function queryTemporalLanguage(db: RecallDb, input: { repo: string; text: string; now: string }, options: { model: TemporalTextModel; predicates?: readonly PredicatePolicy[] }): Promise<{ route: "temporal" | "fallback"; result: TemporalQueryResult | null; error: string | null; raw_output: string | null }> {
  const fallback = (error: string, raw_output: string | null = null) => ({ route: "fallback" as const, result: null, error, raw_output });
  const repo = normalizeIdentifier(input.repo, 500), now = normalizeTemporalTimestamp(input.now);
  if (!repo || !now || typeof input.text !== "string" || !input.text.trim() || input.text.length > 16_000) return fallback("invalid_query");
  if (isSensitive(repo) || isSensitive(input.text)) return fallback("sensitive_source");
  const catalog = queryCatalog(db, repo, now);
  if (typeof catalog === "string") return fallback(catalog);
  let raw: string;
  try { raw = await options.model({ kind: "query", system: QUERY_SYSTEM, user: buildQueryPrompt({ text: input.text, now }, catalog.entries) }); }
  catch { return fallback("model_request_failed"); }
  if (typeof raw !== "string") return fallback("model_response_invalid");
  const safeRaw = redactSensitiveText(raw), parsed = parseObject(raw) as QueryResponse | null;
  if (!parsed || (parsed.route !== "temporal" && parsed.route !== "fallback")) return fallback("model_response_invalid", safeRaw);
  if (parsed.route === "fallback") return fallback("model_fallback", safeRaw);
  const asOf = parsed.as_of === undefined ? now : normalizeTemporalTimestamp(parsed.as_of);
  const observedBefore = parsed.observed_before === undefined ? now : normalizeTemporalTimestamp(parsed.observed_before);
  if (!asOf || !observedBefore || observedBefore > now || typeof parsed.key_id !== "string") return fallback("unsupported_query", safeRaw);
  const visible = queryCatalog(db, repo, observedBefore);
  if (typeof visible === "string" || !visible.keys.has(parsed.key_id)) return fallback("unsupported_query", safeRaw);
  const key = visible.keys.get(parsed.key_id)!;
  try { return { route: "temporal", result: queryTemporalFacts(db, { repo, subject: key.subject, predicate: key.predicate, as_of: asOf, observed_before: observedBefore }), error: null, raw_output: safeRaw }; }
  catch { return fallback("query_failed", safeRaw); }
}

function captureCatalog(db: RecallDb, repo: string, cutoff: string): { entries: CaptureCatalogEntry[]; keys: Map<string, KnownKey> } | string {
  const facts = visibleFacts(db, repo, cutoff);
  if (typeof facts === "string") return facts;
  const keys = groupKeys(repo, facts);
  if (keys.size > MAX_KEYS) return "catalog_overflow";
  const entries = facts.map((fact) => ({ key_id: stableTemporalKey(repo, fact.subject, fact.predicate), subject: fact.subject, predicate: fact.predicate, event_id: fact.event_id, value: fact.value, valid_from: fact.valid_from, valid_to: fact.valid_to }));
  return JSON.stringify(entries).length > MAX_CATALOG_CHARS ? "catalog_overflow" : { entries, keys };
}
function queryCatalog(db: RecallDb, repo: string, cutoff: string): { entries: QueryCatalogEntry[]; keys: Map<string, KnownKey> } | string {
  const facts = visibleFacts(db, repo, cutoff);
  if (typeof facts === "string") return facts;
  const keys = groupKeys(repo, facts);
  if (keys.size > MAX_KEYS) return "catalog_overflow";
  const entries = [...keys.values()].map(({ key_id, subject, predicate }) => ({ key_id, subject, predicate }));
  return JSON.stringify(entries).length > MAX_CATALOG_CHARS ? "catalog_overflow" : { entries, keys };
}
function visibleFacts(db: RecallDb, repo: string, cutoff: string): TemporalFact[] | string {
  const facts = db.$client.prepare("select * from temporal_facts where repo = ? and observed_at <= ? order by observed_at asc, valid_from asc, id asc limit ?").all(repo, cutoff, MAX_ASSERTIONS + 1) as TemporalFact[];
  if (facts.length > MAX_ASSERTIONS) return "catalog_overflow";
  return facts.some((fact) => isSensitive([fact.repo, fact.event_id, fact.subject, fact.predicate, fact.value, fact.evidence, fact.source ?? ""].join("\n"))) ? "sensitive_catalog" : facts;
}
function groupKeys(repo: string, facts: TemporalFact[]): Map<string, KnownKey> {
  const keys = new Map<string, KnownKey>();
  for (const fact of facts) {
    const key_id = stableTemporalKey(repo, fact.subject, fact.predicate), existing = keys.get(key_id);
    if (existing) existing.facts.push(fact); else keys.set(key_id, { key_id, subject: fact.subject, predicate: fact.predicate, facts: [fact] });
  }
  return keys;
}

function prepareFact(proposal: CaptureFactProposal | undefined, input: Required<TemporalLanguageSource>, keys: Map<string, KnownKey>, policies?: readonly PredicatePolicy[]): Preparation {
  if (!proposal || typeof proposal !== "object" || isSensitive(JSON.stringify(proposal))) return { error: "invalid_or_sensitive_fact" };
  if (typeof proposal.quote !== "string" || !proposal.quote.trim() || !input.text.includes(proposal.quote)) return { error: "quote_not_in_source" };
  const clause = enclosingClause(input.text, proposal.quote);
  if (NEGATED_OR_UNCERTAIN.test(clause)) return { error: "unsupported_clause" };
  if (proposal.key_id != null && (typeof proposal.key_id !== "string" || !proposal.key_id)) return { error: "unknown_key" };
  let known = proposal.key_id == null ? undefined : keys.get(proposal.key_id);
  if (proposal.key_id != null && !known) return { error: "unknown_key" };
  const predecessor = proposal.supersedes_event_id == null ? undefined : findPredecessor(keys, proposal.supersedes_event_id);
  const replacementEvidence = proposal.replacement_quote == null ? proposal.quote : proposal.replacement_quote;
  if (proposal.supersedes_event_id != null && (!predecessor || typeof replacementEvidence !== "string" || !replacementEvidence || !input.text.includes(replacementEvidence))) return { error: "invalid_replacement" };
  if (!known && predecessor && proposal.key_id == null && proposal.subject === undefined && proposal.predicate === undefined) known = predecessor.key;
  let subject: string | null, predicate: string | null;
  if (known) {
    subject = known.subject; predicate = known.predicate;
    if ((proposal.subject !== undefined && canonicalLabel(proposal.subject) !== subject) || (proposal.predicate !== undefined && canonicalPredicate(proposal.predicate) !== predicate)) return { error: "known_key_mismatch" };
  } else {
    subject = canonicalLabel(proposal.subject); predicate = canonicalPredicate(proposal.predicate);
    if (!subject || !predicate || !sourceGrounded(proposal.quote, subject)) return { error: "ungrounded_new_key" };
  }
  const policy = policies?.find((item) => canonicalPredicate(item.name) === predicate);
  if (policies && !policy) return { error: "predicate_not_allowed" };
  if (!policy && !sourceGrounded(proposal.quote, predicate.replace(/_/g, " "))) return { error: "ungrounded_predicate" };
  if (!sourceGrounded(proposal.quote, subject)) return { error: "ungrounded_entity" };
  if (predecessor && (predecessor.key.subject !== subject || predecessor.key.predicate !== predicate)) return { error: "replacement_key_mismatch" };
  const rawValue = policy?.value_kind === "integer" && typeof proposal.value === "number" && Number.isSafeInteger(proposal.value) && proposal.value >= 0 ? String(proposal.value) : proposal.value;
  if (typeof rawValue !== "string") return { error: "invalid_value" };
  if (predecessor) {
    const replacementQuote = replacementEvidence;
    const replacementClause = enclosingClause(input.text, replacementQuote);
    const identifiesPredecessor = replacementClause.includes(predecessor.fact.event_id)
      || (!!predecessor.fact.source && replacementClause.includes(predecessor.fact.source))
      || sourceMatch(replacementClause, predecessor.fact.value) !== null
      || (predecessor.key.facts.length === 1 && /\bcorrect(?:ion|ed)?\b/i.test(replacementQuote));
    if (!REPLACEMENT.test(replacementQuote) || !sourceGrounded(replacementClause, subject)
      || !sourceMatch(replacementClause, rawValue) || !identifiesPredecessor
      || replacementClause !== clause) return { error: "replacement_not_explicit" };
  }
  const value = normalizeValue(rawValue, proposal.quote, policy);
  if ("error" in value) return value;
  if (!providerAssociation(proposal.quote, predicate, value.value)) return { error: "ambiguous_property" };
  if (proposal.time_basis !== "explicit" && proposal.time_basis !== "observed") return { error: "invalid_valid_from" };
  const validFrom = proposal.time_basis === "observed" ? input.observed_at : normalizeTemporalTimestamp(proposal.valid_from);
  const validTo = proposal.valid_to === null ? null : normalizeTemporalTimestamp(proposal.valid_to);
  if (!validFrom) return { error: "invalid_valid_from" };
  if (proposal.time_basis === "observed" && proposal.valid_from != null && normalizeTemporalTimestamp(proposal.valid_from) !== input.observed_at) return { error: "observed_time_must_be_open" };
  if (proposal.time_basis === "explicit" && !quoteSupportsDate(associatedDateQuote(proposal.quote, subject, value.value), validFrom, input.observed_at)) return { error: "missing_temporal_anchor" };
  if (proposal.valid_to !== null && !validTo) return { error: "invalid_valid_to" };
  if (validTo && !quoteSupportsDate(associatedDateQuote(proposal.quote, subject, value.value), validTo, input.observed_at, "end")) return { error: "missing_temporal_anchor" };
  if (validTo && validTo <= validFrom) return { error: "invalid_interval" };
  return { value: { subject, predicate, value: value.value, valid_from: validFrom, valid_to: validTo, supersedes_id: predecessor?.fact.id ?? null } };
}
function normalizeValue(value: unknown, quote: string, policy: PredicatePolicy | undefined): { value: string } | { error: string } {
  if (typeof value !== "string" || !value.trim() || value.length > 4000 || isSensitive(value)) return { error: "invalid_value" };
  if (policy?.value_kind === "integer") {
    if (!/^\d+$/.test(value) || !sourceMatch(quote, value)) return { error: "invalid_integer_value" };
    return { value: value.replace(/^0+(?=\d)/, "") };
  }
  const matched = sourceMatch(quote, value);
  if (!matched) return { error: "value_not_in_source" };
  if (policy?.value_case === "upper") return { value: value.toUpperCase() };
  if (policy?.value_case === "lower") return { value: value.toLowerCase() };
  return { value: matched };
}
function quoteSupportsDate(quote: string, normalized: string, observedAt: string, edge: "start" | "end" = "start"): boolean {
  const candidates = quote.match(/\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?/g) ?? [];
  if (candidates.length) {
    if (candidates.length > 1 && /\b(?:and|but|while|whereas)\b/i.test(quote) && !/\b(?:until|through|ending|ends|expires)\b/i.test(quote)) return false;
    const candidate = edge === "start" ? candidates[0] : candidates.at(-1);
    return normalizeTemporalTimestamp(candidate) === normalized;
  }
  const lower = quote.toLocaleLowerCase("en-US"), base = new Date(observedAt), relative = lower.match(/\b(today|tomorrow|yesterday)\b/)?.[1];
  if (relative) { base.setUTCDate(base.getUTCDate() + (relative === "tomorrow" ? 1 : relative === "yesterday" ? -1 : 0)); return normalizeTemporalTimestamp(base.toISOString().slice(0, 10)) === normalized; }
  const natural = lower.match(/\b(?:on\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/i);
  if (!natural) return false;
  const month = ["january","february","march","april","may","june","july","august","september","october","november","december"].indexOf(natural[1].toLowerCase()) + 1;
  const year = natural[3] ? Number(natural[3]) : base.getUTCFullYear();
  return normalizeTemporalTimestamp(String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-" + natural[2].padStart(2, "0")) === normalized;
}
function findPredecessor(keys: Map<string, KnownKey>, eventId: unknown): { key: KnownKey; fact: TemporalFact } | undefined {
  if (typeof eventId !== "string" || !eventId) return undefined;
  for (const key of keys.values()) { const fact = key.facts.find((item) => item.event_id === eventId); if (fact) return { key, fact }; }
  const bySource = [...keys.values()].flatMap((key) => key.facts.filter((fact) => fact.source === eventId).map((fact) => ({ key, fact })));
  return bySource.length === 1 ? bySource[0] : undefined;
}
function sourceReplay(db: RecallDb, input: Required<TemporalLanguageSource>): TemporalFact[] | "replay_conflict" | null {
  const stored = db.$client.prepare("select * from temporal_facts where repo = ? and source = ? order by event_id asc").all(input.repo, input.event_id) as TemporalFact[];
  if (stored.length === 0) return null;
  return stored.length <= 3 && stored.every((fact) =>
    [0, 1, 2].some((index) => fact.event_id === `${input.event_id}#${index}`)
    && !isSensitive([fact.event_id, fact.subject, fact.predicate, fact.value, fact.evidence, fact.source ?? ""].join("\n"))
    && fact.evidence === input.text && fact.observed_at === input.observed_at
  ) ? stored : "replay_conflict";
}
function enclosingClause(source: string, quote: string): string {
  const location = source.indexOf(quote);
  if (location < 0) return "";
  const separator = /[;!?\n]|[.](?=\s|$)/g;
  let start = 0, end = source.length;
  for (const match of source.matchAll(separator)) {
    if (match.index! < location) start = match.index! + match[0].length;
    else if (match.index! >= location + quote.length - 1) { end = match.index! + match[0].length; break; }
  }
  return source.slice(start, end).trim();
}
function associatedDateQuote(quote: string, subject: string, value: string): string {
  return quote.split(/(?:[;!?\n]|[.](?=\s|$))/).filter((part) => {
    if (!sourceGrounded(part, subject) || !sourceMatch(part, value)) return false;
    const firstDate = part.search(/\d{4}-\d{2}-\d{2}/);
    const conjunctions = [...part.matchAll(/\b(?:and|but|while|whereas)\b/gi)].filter((match) => match.index! < firstDate);
    if (!conjunctions.length) return true;
    const datedClause = part.slice(conjunctions.at(-1)!.index!);
    return sourceGrounded(datedClause, subject) && sourceMatch(datedClause, value) !== null;
  }).join("\n");
}
function providerAssociation(quote: string, predicate: string, value: string): boolean {
  if (!predicate.endsWith("_provider")) return true;
  const head = predicate.slice(0, -"_provider".length);
  const heads = [...quote.matchAll(/\b([a-z]+)\s+provider\b/gi)];
  if (!heads.length) return true;
  const valueIndex = quote.toLocaleLowerCase("en-US").indexOf(value.toLocaleLowerCase("en-US"));
  const preceding = heads.filter((match) => match.index! < valueIndex);
  return preceding.length > 0 && preceding.at(-1)![1].toLocaleLowerCase("en-US") === head;
}
function sourceMatch(source: string, value: string): string | null {
  const lowerSource = source.toLocaleLowerCase("en-US"), lowerValue = value.toLocaleLowerCase("en-US");
  let start = lowerSource.indexOf(lowerValue);
  while (start >= 0) { const end = start + value.length; if (!isWord(source[start - 1]) && !isWord(source[end])) return source.slice(start, end); start = lowerSource.indexOf(lowerValue, start + 1); }
  return null;
}
function sourceGrounded(source: string, label: string): boolean { return label.split(/[\s_]+/).every((word) => sourceMatch(source, word) !== null); }
function isWord(value: string | undefined): boolean { return value !== undefined && /[\p{L}\p{N}_]/u.test(value); }
function isSensitive(value: string): boolean { return redactSensitiveText(value) !== value; }
function normalizeIdentifier(value: unknown, max: number): string | null { return typeof value === "string" && value.trim() && value.trim().length <= max ? value.trim() : null; }
function normalizeSource(input: TemporalLanguageSource): Required<TemporalLanguageSource> | null {
  const repo = normalizeIdentifier(input.repo, 500), event_id = normalizeIdentifier(input.event_id, MAX_EVENT_ID), observed_at = normalizeTemporalTimestamp(input.observed_at);
  if (!repo || !event_id || !observed_at || typeof input.text !== "string" || !input.text.trim() || input.text.length > 16_000) return null;
  return { repo, event_id, observed_at, text: input.text };
}
function validRoute(value: unknown): value is TemporalCaptureResult["route"] { return value === "temporal" || value === "ordinary" || value === "ignore" || value === "defer"; }
function validMemoryType(value: unknown): value is NonNullable<TemporalCaptureResult["memory_type"]> { return value === "rule" || value === "command" || value === "gotcha" || value === "decision" || value === "review_pattern"; }

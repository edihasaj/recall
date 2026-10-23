/** Offline, exploratory LongMemEval side-car evaluation; never production intake. */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import { appendTemporalFact, queryTemporalFacts, type TemporalQueryInput, type TemporalQueryResult } from "../src/temporal/store.js";
import { callQwenLocal, type LocalModelAnswer } from "./temporal-model.js";

const TYPES = ["single-session-user", "single-session-assistant", "single-session-preference", "multi-session", "knowledge-update", "temporal-reasoning"] as const;
const CAP = 12_000;
const AUGMENTATION_RESERVE = 2_000;
const SEED = 20261019;
const SYSTEM = "Return only the requested JSON. Be conservative; do not use knowledge outside supplied evidence.";
type Provider = "qwen-local";
type Usage = LocalModelAnswer["usage"];
type CallKind = "extract" | "parse" | "answer" | "judge";
type Arm = "BASELINE_RAW" | "SIDECAR_WITH_FALLBACK";
type Turn = { role: string; content: string; has_answer?: boolean };
type SourceRow = { id: string; date: string; text: string };
type Fact = { subject: string; predicate: string; value: string; valid_from: string; valid_to: string | null };
type Parse = { route: "temporal" | "fallback"; subject?: string; predicate?: string; as_of?: string; observed_before?: string };
type Ranking = { question_id: string; question_type: string; retrieved_session_ids: string[] };
type Answer = { answer: string; source_session_ids: string[] };
type Call = { kind: CallKind; prompt_sha256: string; raw_output: string | null; model_call: { provider: string; model: string; duration_ms: number; usage: Usage } | null; error: string | null };
type Extraction = Call & { session_id: string; source_date: string; source_text: string; facts: Fact[] | null; deferred: boolean; malformed: boolean; cache_reused: boolean; real_attempt: boolean; append_failures: number };
type EvidenceBundle = { text: string; snippets: SourceRow[] };
type Lookup = { error: string | null; facts: number; conflict: boolean; truncated: boolean };
type ArmScore = { correct: boolean; citations_valid: boolean; cites_answer_session_id: boolean | null; judge: Call | null; malformed_answer: boolean; malformed_judge: boolean };
type ArmReport = { arm: Arm; evidence: string; answer: Answer | null; answer_call: Call; score: ArmScore | null; audit: { candidate: string | null; reference: string; verdict: boolean } };
export type PublicEntry = { question_id: string; question_type: string; question: string; question_date: string; answer: string; answer_session_ids: string[]; haystack_session_ids: string[]; haystack_dates: string[]; haystack_sessions: Turn[][] };
export type PublicAnswerer = (input: { kind: CallKind; system: string; user: string }) => Promise<LocalModelAnswer>;
export type SelectedQuestion = { entry: PublicEntry; retrieved_session_ids: string[]; retrieval_mode: "cached_ranked" | "raw_session_fts5_bm25_or"; is_abstention: boolean };
export type QuestionReport = {
  question_id: string; question_type: string; is_abstention: boolean; retrieval_mode: SelectedQuestion["retrieval_mode"]; retrieved_session_ids: string[]; excluded_future_source_session_ids: string[]; evidence_chars: number; elapsed_ms: number;
  extraction: { attempts: number; real_attempts: number; cache_reuses: number; failures: number; deferred: number; malformed: number; append_failures: number; rows: Extraction[] };
  parse: (Call & { route: Parse | null; malformed: boolean }) | null; lookup: Lookup | null; sidecar_reason: string | null; arms: ArmReport[]; error: string | null;
};
type Count = { planned: number; recorded: number; failures: number; correct: number; score: number | null };
type UsageTotal = { total: number | null; observed_total: number; unknown_count: number };
export type PublicSummary = {
  elapsed_ms: number; planned_questions: number; recorded_questions: number; baseline_denominator: number; sidecar_denominator: number; baseline_correct: number | null; sidecar_correct: number | null; temporal_usage: number | null; fallback_usage: number | null; parse_failures: number | null; extraction_failures: number | null;
  question_types: Record<string, Count>; abstention: Count; arms: Record<Arm, Count>; arms_by_question_type: Record<string, Record<Arm, Count>>; arms_for_abstention: Record<Arm, Count>;
  failures: { request: Record<CallKind, number>; malformed: Record<CallKind, number>; lookup: number; append: number; world: number };
  usage: { calls: number; successful_calls: number; prompt_tokens: UsageTotal; completion_tokens: UsageTotal; total_tokens: UsageTotal };
};
export interface PublicReport {
  status: "complete" | "partial";
  invocation: { provider: Provider | null; model_reasoning: "none" | null; model_concurrency: number; question_concurrency: number; evidence_cap_chars: number; max_output_tokens: number; per_type: number; abstention: number };
  reproducibility: { dataset_sha256: string; ranking_sha256: string; harness_sha256: string; prompt_templates_sha256: string };
  limitations: string[]; summary: PublicSummary; questions: QuestionReport[];
}

export function seededShuffle<T>(values: readonly T[], seed = SEED): T[] {
  const out = [...values]; let state = seed >>> 0;
  const next = () => { state = (state + 0x6D2B79F5) >>> 0; let value = state; value = Math.imul(value ^ (value >>> 15), value | 1); value ^= value + Math.imul(value ^ (value >>> 7), value | 61); return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296; };
  for (let index = out.length - 1; index > 0; index--) { const swap = Math.floor(next() * (index + 1)); [out[index], out[swap]] = [out[swap]!, out[index]!]; }
  return out;
}

function calendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (![year, month, day].every(Number.isFinite) || month < 1 || month > 12 || day < 1) return false;
  const days = month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= days;
}

function queryTimestamp(value: unknown): string | null {
  if (calendarDate(value)) return `${value}T00:00:00.000Z`;
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !calendarDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString().length === 24 ? time.toISOString() : null;
}

export function isCompleteAbstention(value: string): boolean {
  return /^(?:unknown|not enough information|insufficient information|cannot determine|i do not know|i don't know)[.!?]?$/.test(value.trim().toLowerCase());
}

export function normalizeDatasetDate(value: string): string | null {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})(?:\s+\([^)]*\))?\s+(\d{2}):(\d{2})$/.exec(value);
  if (!match || !calendarDate(`${match[1]}-${match[2]}-${match[3]}`)) return null;
  const hour = Number(match[4]), minute = Number(match[5]);
  return Number.isFinite(hour) && Number.isFinite(minute) && hour <= 23 && minute <= 59 ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00.000Z` : null;
}

function rawSession(turns: readonly Turn[]): string { return turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n"); }
function words(question: string): string[] { return [...new Set(question.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])].slice(0, 32); }

/** FTS is deliberately independent of answerability and all gold-session metadata. */
export function retrieveAbstention(entry: Pick<PublicEntry, "question" | "haystack_session_ids" | "haystack_sessions">, limit = 10): string[] {
  const db = new Database(":memory:");
  try {
    db.exec("create virtual table sessions using fts5(session_id unindexed, content)");
    const insert = db.prepare("insert into sessions values (?, ?)");
    entry.haystack_sessions.forEach((session, index) => insert.run(entry.haystack_session_ids[index]!, rawSession(session)));
    const query = words(entry.question).join(" OR ");
    if (!query) return entry.haystack_session_ids.slice(0, limit);
    return (db.prepare("select session_id from sessions where sessions match ? order by bm25(sessions) limit ?").all(query, limit) as Array<{ session_id: string }>).map((row) => row.session_id);
  } catch { return entry.haystack_session_ids.slice(0, limit); } finally { db.close(); }
}

export function selectPublicQuestions(dataset: readonly PublicEntry[], rankings: readonly Ranking[], perType = 5, abstention = 6): SelectedQuestion[] {
  if (!Number.isInteger(perType) || perType < 1 || !Number.isInteger(abstention) || abstention < 0) throw new Error("perType and abstention must be non-negative integers");
  const entries = new Map(dataset.map((entry) => [entry.question_id, entry])); const selected: SelectedQuestion[] = [];
  for (const type of TYPES) {
    const bucket = rankings.filter((row) => row.question_type === type && !row.question_id.endsWith("_abs") && entries.has(row.question_id));
    if (bucket.length < perType) throw new Error(`cached rankings lack ${perType} ${type} questions`);
    for (const row of seededShuffle(bucket).slice(0, perType)) selected.push({ entry: entries.get(row.question_id)!, retrieved_session_ids: row.retrieved_session_ids.slice(0, 10), retrieval_mode: "cached_ranked", is_abstention: false });
  }
  const abstentions = seededShuffle(dataset.filter((entry) => entry.question_id.endsWith("_abs"))).slice(0, abstention);
  if (abstentions.length < abstention) throw new Error("dataset lacks requested abstention questions");
  return [...selected, ...abstentions.map((entry) => ({ entry, retrieved_session_ids: retrieveAbstention(entry), retrieval_mode: "raw_session_fts5_bm25_or" as const, is_abstention: true }))];
}

export function buildExtractionPrompt(source: { session_id: string; source_date: string; text: string }): string {
  return ["Extract up to THREE single-value temporal facts from this original conversation source only.", "Return exactly JSON {facts:[{subject,predicate,value,valid_from,valid_to}],deferred:boolean}.", "subject and predicate must be lower-case snake_case. Dates must be explicit YYYY-MM-DD values in the source; do not infer dates, plans, or replacement links. If no safely dated fact is available, return facts:[] and deferred:true.", `source_date_utc: ${source.source_date}`, "source_text:", source.text].join("\n");
}
export function buildParsePrompt(question: string, questionDate: string): string {
  return ["Parse only this question into exactly JSON {route:\"temporal\"|\"fallback\",subject?,predicate?,as_of?,observed_before?}.", "Use fallback for multi-hop, count, list, preferences, recommendations, or dates without known day precision. subject/predicate use lower-case snake_case. Use ISO timestamps with timezone when precision is supplied; preserve the full question_date_utc timestamp as observed_before unless the question specifies another knowledge cutoff. Do not infer fields.", `question_date_utc: ${questionDate}`, `question: ${question}`].join("\n");
}
export function buildAnswerPrompt(question: string, questionDate: string, evidence: string): string {
  return `Answer only from evidence. Return exactly JSON {answer:string,source_session_ids:string[]}. Cite only supplied source session IDs. If unsupported, answer "unknown".\nquestion_date_utc: ${questionDate}\nquestion: ${question}\nevidence:\n${evidence || "(no evidence)"}`;
}
function buildJudgePrompt(question: string, candidate: string, reference: string): string { return `Judge whether candidate answers the question equivalently. Return exactly JSON {correct:boolean}.\nquestion: ${question}\ncandidate: ${candidate}\nreference: ${reference}`; }
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function json(text: string): unknown | null { try { return JSON.parse(text.replace(/^\`\`\`(?:json)?\s*|\s*\`\`\`$/g, "")); } catch { return null; } }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function facts(value: unknown): { facts: Fact[]; deferred: boolean } | null {
  if (!record(value) || !Array.isArray(value.facts) || typeof value.deferred !== "boolean" || value.facts.length > 3) return null;
  const parsed: Fact[] = [];
  for (const fact of value.facts) {
    if (!record(fact) || typeof fact.subject !== "string" || !/^[a-z][a-z0-9_]*$/.test(fact.subject) || typeof fact.predicate !== "string" || !/^[a-z][a-z0-9_]*$/.test(fact.predicate) || typeof fact.value !== "string" || !fact.value.trim() || !calendarDate(fact.valid_from) || (fact.valid_to !== null && fact.valid_to !== undefined && !calendarDate(fact.valid_to))) return null;
    parsed.push({ subject: fact.subject, predicate: fact.predicate, value: fact.value, valid_from: fact.valid_from, valid_to: typeof fact.valid_to === "string" ? fact.valid_to : null });
  }
  return { facts: parsed, deferred: value.deferred };
}
function parsedRoute(value: unknown): Parse | null {
  if (!record(value) || (value.route !== "temporal" && value.route !== "fallback")) return null;
  if (value.route === "fallback") return { route: "fallback" };
  const asOf = queryTimestamp(value.as_of), observedBefore = queryTimestamp(value.observed_before);
  if (typeof value.subject !== "string" || value.subject.length > 500 || !/^[a-z][a-z0-9_]*$/.test(value.subject) || typeof value.predicate !== "string" || value.predicate.length > 500 || !/^[a-z][a-z0-9_]*$/.test(value.predicate) || !asOf || !observedBefore) return null;
  return { route: "temporal", subject: value.subject, predicate: value.predicate, as_of: asOf, observed_before: observedBefore };
}
function answer(value: unknown, allowed: readonly string[]): Answer | null {
  if (!record(value) || typeof value.answer !== "string" || !Array.isArray(value.source_session_ids) || !value.source_session_ids.every((id) => typeof id === "string") || !(value.source_session_ids as string[]).every((id) => allowed.includes(id))) return null;
  return { answer: value.answer, source_session_ids: value.source_session_ids as string[] };
}
function verdict(value: unknown): boolean | null { return record(value) && typeof value.correct === "boolean" ? value.correct : null; }
function safe(error: unknown): string { const message = error instanceof Error ? error.message : "request_failed"; return /HTTP \d{3}/.test(message) ? message.match(/HTTP \d{3}/)![0] : /timeout/.test(message) ? "timeout" : "request_failed"; }
function sourceLabel(row: SourceRow): string { return `[source_session_id: ${row.id}; source_date_utc: ${row.date}]`; }

/** Allocates source text evenly after preserving every ranked source label in rank order. */
export function baselineEvidence(rows: readonly SourceRow[], cap = CAP): EvidenceBundle {
  if (!rows.length) return { text: "", snippets: [] };
  const labels = rows.map(sourceLabel);
  const overhead = labels.reduce((total, label) => total + label.length + 1, 0) + (rows.length - 1) * 2;
  if (overhead > cap) throw new Error("source labels exceed evidence cap");
  const room = cap - overhead;
  const allocations = rows.map(() => Math.floor(room / rows.length));
  let remaining = room - allocations.reduce((total, allocation) => total + allocation, 0);
  for (let index = 0; remaining > 0; index = (index + 1) % rows.length) { allocations[index]!++; remaining--; }
  const snippets = rows.map((row, index) => ({ ...row, text: row.text.slice(0, allocations[index]) }));
  return { text: snippets.map((row, index) => `${labels[index]}\n${row.text}`).join("\n\n"), snippets };
}

export function createModelSemaphore(max = 6) {
  if (!Number.isInteger(max) || max < 1) throw new Error("max must be a positive integer");
  let active = 0; const waiters: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiters.push(resolve)); else active++;
    try { return await work(); } finally { const waiter = waiters.shift(); if (waiter) waiter(); else active--; }
  };
}

async function request(kind: CallKind, user: string, provider: Provider, answerer: PublicAnswerer | undefined, limit: ReturnType<typeof createModelSemaphore>): Promise<Call> {
  const prompt_sha256 = hash(`${SYSTEM}\n${user}`);
  try {
    const result = await limit(() => answerer ? answerer({ kind, system: SYSTEM, user }) : callQwenLocal({ system: SYSTEM, user, reasoning_effort: "none" }));
    return { kind, prompt_sha256, raw_output: result.text, model_call: { provider: result.provider, model: result.model, duration_ms: result.duration_ms, usage: result.usage }, error: null };
  } catch (error) { return { kind, prompt_sha256, raw_output: null, model_call: null, error: safe(error) }; }
}

function preflight(selected: readonly SelectedQuestion[]): void {
  for (const item of selected) {
    if (!normalizeDatasetDate(item.entry.question_date)) throw new Error(`invalid dataset question_date for ${item.entry.question_id}`);
    const entry = item.entry;
    if (entry.haystack_session_ids.length !== entry.haystack_dates.length || entry.haystack_dates.length !== entry.haystack_sessions.length) throw new Error(`invalid haystack shape for ${entry.question_id}`);
    const index = new Map(entry.haystack_session_ids.map((id, position) => [id, position]));
    for (const id of item.retrieved_session_ids) {
      const position = index.get(id);
      if (position === undefined) throw new Error(`retrieval references missing source ${id} for ${entry.question_id}`);
      if (!normalizeDatasetDate(entry.haystack_dates[position]!)) throw new Error(`invalid dataset source date for ${entry.question_id}/${id}`);
    }
  }
}
function sourceRows(item: SelectedQuestion): { rows: SourceRow[]; future: string[]; questionDate: string } {
  const questionDate = normalizeDatasetDate(item.entry.question_date)!;
  const index = new Map(item.entry.haystack_session_ids.map((id, position) => [id, position]));
  const rows: SourceRow[] = [], future: string[] = [];
  for (const id of item.retrieved_session_ids) {
    const position = index.get(id)!;
    const date = normalizeDatasetDate(item.entry.haystack_dates[position]!)!;
    if (date > questionDate) future.push(id); else rows.push({ id, date, text: rawSession(item.entry.haystack_sessions[position]!) });
  }
  return { rows, future, questionDate };
}
function appendFacts(db: RecallDb, entry: PublicEntry, row: SourceRow, extraction: Extraction): void {
  for (const [factIndex, fact] of (extraction.facts ?? []).entries()) {
    try { appendTemporalFact(db, { repo: `public/${entry.question_id}`, event_id: `${row.id}:${factIndex}`, ...fact, observed_at: row.date, evidence: row.text, source: row.id }); } catch { extraction.append_failures++; }
  }
}
function temporalEvidence(assertions: string, rows: readonly SourceRow[]): string {
  const prefix = `Temporal source assertions (experimental; not verified truth):\n${assertions}\n\n`;
  const raw = baselineEvidence(rows, CAP - AUGMENTATION_RESERVE).text;
  if (prefix.length > AUGMENTATION_RESERVE || prefix.length + raw.length > CAP) throw new Error("temporal augmentation exceeds reserved evidence budget");
  return `${prefix}${raw}`;
}
function skipped(item: SelectedQuestion): QuestionReport {
  const sources = sourceRows(item), evidence = baselineEvidence(sources.rows, CAP - AUGMENTATION_RESERVE);
  const arms = (["BASELINE_RAW", "SIDECAR_WITH_FALLBACK"] as const).map((arm): ArmReport => ({ arm, evidence: evidence.text, answer: null, answer_call: { kind: "answer", prompt_sha256: hash("not_called"), raw_output: null, model_call: null, error: null }, score: null, audit: { candidate: null, reference: item.entry.answer, verdict: false } }));
  return makeQuestion(item, sources.future, evidence.text.length, 0, [], null, null, null, arms, null);
}

type LookupFn = (db: RecallDb, input: TemporalQueryInput) => TemporalQueryResult;
async function runWorld(item: SelectedQuestion, provider: Provider, answerer: PublicAnswerer | undefined, limit: ReturnType<typeof createModelSemaphore>, cache: Map<string, Promise<Call>>, path: string, lookup: LookupFn): Promise<QuestionReport> {
  const started = Date.now(), sources = sourceRows(item), baseline = baselineEvidence(sources.rows, CAP - AUGMENTATION_RESERVE), extraction: Extraction[] = [];
  let db: RecallDb | undefined;
  try {
    db = initStandaloneDb(path);
    await Promise.all(baseline.snippets.slice(0, 10).map(async (row) => {
      const prompt = buildExtractionPrompt({ session_id: row.id, source_date: row.date, text: row.text });
      const key = hash(`${row.text}\0${row.date}\0${hash(prompt)}`);
      const cached = cache.get(key), call = cached ?? request("extract", prompt, provider, answerer, limit);
      if (!cached) cache.set(key, call);
      const result = await call, parsed = result.raw_output ? facts(json(result.raw_output)) : null;
      const extracted: Extraction = { ...result, session_id: row.id, source_date: row.date, source_text: row.text, facts: parsed?.facts ?? null, deferred: parsed?.deferred ?? false, malformed: result.raw_output !== null && parsed === null, cache_reused: Boolean(cached), real_attempt: !cached, append_failures: 0 };
      appendFacts(db!, item.entry, row, extracted); extraction.push(extracted);
    }));
    const parseCall = await request("parse", buildParsePrompt(item.entry.question, sources.questionDate), provider, answerer, limit);
    const route = parseCall.raw_output ? parsedRoute(json(parseCall.raw_output)) : null;
    const parse = { ...parseCall, route, malformed: parseCall.raw_output !== null && route === null };
    const extractionBad = extraction.some((row) => row.error || row.deferred || !row.facts || row.append_failures > 0);
    let sidecar = baseline.text;
    let reason = route?.route === "fallback" ? "parser_fallback" : !route ? "malformed_parse" : extractionBad ? "extraction_unusable" : "no_temporal_match";
    let lookupAudit: Lookup | null = null;
    if (route?.route === "temporal" && !extractionBad) {
      try {
        const result = lookup(db, { repo: `public/${item.entry.question_id}`, subject: route.subject!, predicate: route.predicate!, as_of: route.as_of!, observed_before: route.observed_before!, mode: "snapshot", limit: 20 });
        lookupAudit = { error: null, facts: result.facts.length, conflict: result.conflict, truncated: result.truncated };
        if (result.facts.length && !result.conflict && !result.truncated) {
          const assertions = result.facts.map((fact) => `- ${fact.subject}.${fact.predicate} = ${fact.value} (source_session_id: ${fact.source}; valid_from: ${fact.valid_from}; observed_at: ${fact.observed_at})`).join("\n");
          sidecar = temporalEvidence(assertions, baseline.snippets); reason = "temporal";
        } else reason = result.conflict ? "temporal_conflict" : result.truncated ? "temporal_truncated" : "no_temporal_match";
      } catch (error) { lookupAudit = { error: safe(error), facts: 0, conflict: false, truncated: false }; reason = "lookup_failed"; }
    }
    const arms = await Promise.all(([["BASELINE_RAW", baseline.text], ["SIDECAR_WITH_FALLBACK", sidecar]] as const).map(async ([arm, evidence]): Promise<ArmReport> => {
      const answerCall = await request("answer", buildAnswerPrompt(item.entry.question, sources.questionDate, evidence), provider, answerer, limit);
      const candidate = answerCall.raw_output ? answer(json(answerCall.raw_output), baseline.snippets.map((row) => row.id)) : null;
      let correct = false, judge: Call | null = null, malformedJudge = false;
      if (candidate) {
        if (item.is_abstention) correct = isCompleteAbstention(candidate.answer);
        else {
          judge = await request("judge", buildJudgePrompt(item.entry.question, candidate.answer, item.entry.answer), provider, answerer, limit);
          const scored = judge.raw_output ? verdict(json(judge.raw_output)) : null;
          malformedJudge = judge.raw_output !== null && scored === null; correct = scored === true;
        }
      }
      return { arm, evidence, answer: candidate, answer_call: answerCall, score: { correct, citations_valid: candidate !== null, cites_answer_session_id: item.is_abstention ? null : candidate?.source_session_ids.some((id) => item.entry.answer_session_ids.includes(id)) ?? false, judge, malformed_answer: answerCall.raw_output !== null && candidate === null, malformed_judge: malformedJudge }, audit: { candidate: candidate?.answer ?? null, reference: item.entry.answer, verdict: correct } };
    }));
    return makeQuestion(item, sources.future, baseline.text.length, Date.now() - started, extraction, parse, lookupAudit, reason, arms, null);
  } catch (error) {
    return makeQuestion(item, sources.future, baseline.text.length, Date.now() - started, extraction, null, null, "world_failed", [], safe(error));
  } finally { db?.$client.close(); }
}
function makeQuestion(item: SelectedQuestion, future: string[], evidenceChars: number, elapsed_ms: number, rows: Extraction[], parse: QuestionReport["parse"], lookup: Lookup | null, sidecar_reason: string | null, arms: ArmReport[], error: string | null): QuestionReport {
  return { question_id: item.entry.question_id, question_type: item.entry.question_type, is_abstention: item.is_abstention, retrieval_mode: item.retrieval_mode, retrieved_session_ids: item.retrieved_session_ids, excluded_future_source_session_ids: future, evidence_chars: evidenceChars, elapsed_ms, extraction: { attempts: rows.length, real_attempts: rows.filter((row) => row.real_attempt).length, cache_reuses: rows.filter((row) => row.cache_reused).length, failures: rows.filter((row) => row.error || !row.facts).length, deferred: rows.filter((row) => row.deferred).length, malformed: rows.filter((row) => row.malformed).length, append_failures: rows.reduce((total, row) => total + row.append_failures, 0), rows }, parse, lookup, sidecar_reason, arms, error };
}

function count(planned: number, questions: readonly QuestionReport[], arm?: Arm): Count {
  if (arm) {
    const completed = questions.filter((question) => question.error !== null || question.arms.some((candidate) => candidate.arm === arm && candidate.score !== null));
    const correct = completed.filter((question) => question.arms.some((candidate) => candidate.arm === arm && candidate.score?.correct)).length;
    return { planned, recorded: completed.length, failures: completed.length - correct, correct, score: completed.length ? correct / completed.length : null };
  }
  return { planned, recorded: questions.length, failures: questions.filter((question) => question.error !== null).length, correct: 0, score: null };
}
function usageTotal(calls: readonly Call[], field: keyof Usage): UsageTotal {
  const values = calls.map((call) => call.model_call?.usage[field] ?? null);
  const observed = values.filter((value): value is number => typeof value === "number");
  return { total: observed.length === values.length ? observed.reduce((total, value) => total + value, 0) : null, observed_total: observed.reduce((total, value) => total + value, 0), unknown_count: values.length - observed.length };
}
function summary(report: PublicReport, model: boolean, elapsed_ms: number): PublicSummary {
  const questions = report.questions;
  const armCounts = (subset: readonly QuestionReport[], planned: number): Record<Arm, Count> => (["BASELINE_RAW", "SIDECAR_WITH_FALLBACK"] as const).reduce((result, arm) => { result[arm] = model ? count(planned, subset, arm) : { planned, recorded: 0, failures: 0, correct: 0, score: null }; return result; }, {} as Record<Arm, Count>);
  const arms = armCounts(questions, report.invocation.per_type * TYPES.length + report.invocation.abstention);
  const calls: Call[] = [];
  for (const question of questions) {
    for (const extraction of question.extraction.rows) if (!extraction.cache_reused) calls.push(extraction);
    if (question.parse) calls.push(question.parse);
    if (model) for (const arm of question.arms) { calls.push(arm.answer_call); if (arm.score?.judge) calls.push(arm.score.judge); }
  }
  const malformed: Record<CallKind, number> = { extract: 0, parse: 0, answer: 0, judge: 0 };
  const request: Record<CallKind, number> = { extract: 0, parse: 0, answer: 0, judge: 0 };
  for (const call of calls) if (call.error) request[call.kind]++;
  for (const question of questions) {
    malformed.extract += question.extraction.malformed;
    if (question.parse?.malformed) malformed.parse++;
    for (const arm of question.arms) { if (arm.score?.malformed_answer) malformed.answer++; if (arm.score?.malformed_judge) malformed.judge++; }
  }
  const planned = report.invocation.per_type * TYPES.length + report.invocation.abstention;
  return {
    elapsed_ms, planned_questions: planned, recorded_questions: questions.length, baseline_denominator: model ? arms.BASELINE_RAW.recorded : 0, sidecar_denominator: model ? arms.SIDECAR_WITH_FALLBACK.recorded : 0, baseline_correct: model ? arms.BASELINE_RAW.score : null, sidecar_correct: model ? arms.SIDECAR_WITH_FALLBACK.score : null,
    temporal_usage: model ? questions.filter((question) => question.sidecar_reason === "temporal").length : null, fallback_usage: model ? questions.filter((question) => question.sidecar_reason !== "temporal").length : null, parse_failures: model ? questions.filter((question) => question.parse?.route === null).length : null, extraction_failures: model ? questions.reduce((total, question) => total + question.extraction.failures, 0) : null,
    question_types: Object.fromEntries(TYPES.map((type) => [type, count(report.invocation.per_type, questions.filter((question) => question.question_type === type && !question.is_abstention))])), abstention: count(report.invocation.abstention, questions.filter((question) => question.is_abstention)), arms,
    arms_by_question_type: Object.fromEntries(TYPES.map((type) => [type, armCounts(questions.filter((question) => question.question_type === type && !question.is_abstention), report.invocation.per_type)])), arms_for_abstention: armCounts(questions.filter((question) => question.is_abstention), report.invocation.abstention),
    failures: { request, malformed, lookup: questions.filter((question) => question.lookup?.error != null).length, append: questions.reduce((total, question) => total + question.extraction.append_failures, 0), world: questions.filter((question) => question.error !== null).length },
    usage: { calls: calls.length, successful_calls: calls.filter((call) => call.model_call !== null).length, prompt_tokens: usageTotal(calls, "prompt_tokens"), completion_tokens: usageTotal(calls, "completion_tokens"), total_tokens: usageTotal(calls, "total_tokens") },
  };
}
async function pool<T>(items: readonly T[], concurrency: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { for (;;) { const index = next++; if (index >= items.length) return; await work(items[index]!, index); } }));
}

export async function runPublicTemporalEvaluation(options: { provider?: Provider; out?: string; answerer?: PublicAnswerer; perType?: number; abstention?: number; dataset?: PublicEntry[]; rankings?: Ranking[]; onProgress?: (report: PublicReport) => void; lookup?: LookupFn } = {}): Promise<PublicReport> {
  if (options.provider && options.provider !== "qwen-local") throw new Error(`Unsupported provider: ${options.provider}`);
  const datasetPath = fileURLToPath(new URL("./data/longmemeval_s_cleaned.json", import.meta.url));
  const rankingPath = fileURLToPath(new URL("./data/recall-lme-e5-n60.json", import.meta.url));
  if (!options.dataset && !existsSync(datasetPath)) throw new Error(`Dataset not found: ${datasetPath}`);
  if (!options.rankings && !existsSync(rankingPath)) throw new Error(`Ranking cache not found: ${rankingPath}`);
  const dataset = options.dataset ?? JSON.parse(readFileSync(datasetPath, "utf8")) as PublicEntry[];
  const rankings = options.rankings ?? (JSON.parse(readFileSync(rankingPath, "utf8")) as { results: Ranking[] }).results;
  const perType = options.perType ?? 5, abstention = options.abstention ?? 6;
  const selected = selectPublicQuestions(dataset, rankings, perType, abstention);
  preflight(selected);
  const started = Date.now();
  const report: PublicReport = {
    status: "partial",
    invocation: { provider: options.provider ?? null, model_reasoning: options.provider ? "none" : null, model_concurrency: options.provider ? 6 : 0, question_concurrency: options.provider ? 2 : 0, evidence_cap_chars: CAP, max_output_tokens: 512, per_type: perType, abstention },
    reproducibility: { dataset_sha256: hash(options.dataset ? JSON.stringify(dataset) : readFileSync(datasetPath)), ranking_sha256: hash(options.rankings ? JSON.stringify(rankings) : readFileSync(rankingPath)), harness_sha256: hash(readFileSync(fileURLToPath(import.meta.url))), prompt_templates_sha256: hash(`${SYSTEM}\n${buildExtractionPrompt({ session_id: "x", source_date: "x", text: "x"})}\n${buildParsePrompt("x", "x")}\n${buildAnswerPrompt("x", "x", "x")}\n${buildJudgePrompt("x", "x", "x")}`) },
    limitations: ["Exploratory sampled public cases, not a full LongMemEval rerun or official score.", "The cached rankings may have development exposure.", "Dataset slash dates are treated as UTC because the dataset lacks timezone metadata.", "Both arms use identical source snippets within 10000 characters; 2000 of the shared 12000-character cap are reserved for optional assertions.", "Temporal assertions are source assertions, not verified truth; freeform judging may err.", "Citation subset checks do not establish complete grounding."],
    summary: {} as PublicSummary, questions: [],
  };
  const limiter = createModelSemaphore(6), temp = options.provider ? mkdtempSync(join(tmpdir(), "recall-temporal-public-")) : null, extractionCache = new Map<string, Promise<Call>>();
  try {
    await pool(selected, options.provider ? 2 : 1, async (item, index) => {
      const result = options.provider ? await runWorld(item, options.provider, options.answerer, limiter, extractionCache, join(temp!, `${index}.db`), options.lookup ?? queryTemporalFacts) : skipped(item);
      report.questions.push(result); report.summary = summary(report, Boolean(options.provider), Date.now() - started);
      if (options.out) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
      options.onProgress?.(report);
    });
    report.status = "complete"; return report;
  } finally {
    report.summary = summary(report, Boolean(options.provider), Date.now() - started);
    if (options.out) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}
function cli(): Promise<void> {
  const args = process.argv.slice(2); let provider: Provider | undefined, out: string | undefined, perType: number | undefined, abstention: number | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--provider") provider = args[++index] as Provider;
    else if (args[index] === "--out") out = args[++index];
    else if (args[index] === "--per-type") perType = Number(args[++index]);
    else if (args[index] === "--abstention") abstention = Number(args[++index]);
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  return runPublicTemporalEvaluation({ provider, out, perType, abstention }).then((report) => { if (!out) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void cli();

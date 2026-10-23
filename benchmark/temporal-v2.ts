/** Frozen v1/v2 intake comparison. It never changes the production runtime. */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import { redactSensitiveText } from "../src/security/redaction.js";
import { captureTemporalSource, queryTemporalLanguage } from "../src/temporal/intake.js";
import { stableTemporalKey, normalizeTemporalTimestamp } from "../src/temporal/intake-contract.js";
import { appendTemporalFact, queryTemporalFacts, type TemporalFact, type TemporalQueryResult } from "../src/temporal/store.js";
import { buildCategoryPrompt, opaqueSourceId } from "./temporal-categories.js";
import { callQwenLocal, type LocalModelAnswer } from "./temporal-model.js";
import { withEmbeddingsDisabled } from "./temporal.js";
import { V2_PREDICATES, V2_VERSION, V2_WORLDS, type MemoryType, type Route, type V2Fact, type V2Question, type V2Source, type V2World } from "./temporal-v2-fixtures.js";

type Provider = "qwen-local";
type Arm = "v1" | "v2";
type Usage = LocalModelAnswer["usage"];
type Call = { provider: string; model: string; duration_ms: number; usage: Usage };
export type V2Answerer = (input: { arm: Arm; kind: "capture" | "query"; system: string; user: string }) => Promise<LocalModelAnswer>;
export interface Stage { route: string | null; route_exact: boolean | null; type_exact: boolean | null; facts_exact: boolean | null; single_state_exact: boolean | null; stored: number; raw_output: string | null; error: string | null; call: Call | null; attempted: boolean; }
export interface V2SourceResult { id: string; expected_route: Route; expected_type: MemoryType | null; expected_fact_count: number; observed_start: boolean; v1: Stage; v2: Stage; }
export interface V2QuestionResult { id: string; comparable: boolean; expected_nonempty: boolean; ideal_exact: boolean; v1_structured_exact: boolean | null; v2_structured_exact: boolean | null; v2_natural_exact: boolean | null; v2_key_exact: boolean | null; v2_as_of_exact: boolean | null; v2_observed_before_exact: boolean | null; v2_route: "temporal" | "fallback" | null; v2_error: string | null; raw_output: string | null; call: Call | null; attempted: boolean; }
export interface V2WorldResult { id: string; split: V2World["split"]; family: string; sources: V2SourceResult[]; questions: V2QuestionResult[]; }
export interface V2Report { status: "partial" | "complete"; dataset_version: string; invocation: { provider: Provider | null; split: "development" | "holdout" | "all"; model: string; reasoning_effort: "none"; world_concurrency: number; max_model_concurrency: number }; reproducibility: Record<string, string>; counts: { worlds: number; sources: number; questions: number; planned_holdout_worlds: number }; known_tokens: Record<keyof Usage, { value: number | null; unknown_attempts: number }>; elapsed_ms: number; limitations: string[]; worlds: V2WorldResult[]; summary: Record<string, unknown>; }

const POLICY = V2_PREDICATES.map((name) => ({ name, description: `Declared ${name} policy.`, value_kind: name === "ttl_days" || name === "size" ? "integer" as const : "string" as const, value_case: "preserve" as const }));
const V1_SYSTEM = "You are a conservative Recall source router. Return only valid JSON and never infer a date absent from the source.";
const V1_RECONSTRUCTION = "The v1 arm reuses the frozen category prompt and one-fact parser/write rules; it is not a production baseline.";

export function validateV2Fixtures(worlds: readonly V2World[] = V2_WORLDS): void {
  const sources = worlds.flatMap((world) => world.sources); const questions = worlds.flatMap((world) => world.questions);
  if (worlds.length < 20 || sources.length < 60 || questions.length < 50) throw new Error("v2_fixture_minimum_coverage_failed");
  const ordinary = sources.filter((source) => source.expected_route === "ordinary");
  if (ordinary.length < 15 || new Set(ordinary.map((source) => source.expected_type)).size < 5) throw new Error("v2_fixture_ordinary_coverage_failed");
  if (!questions.every((question) => question.now && question.text.includes(question.as_of) && question.text.includes(question.observed_before))) throw new Error("v2_fixture_question_clock_missing");
  if (questions.filter((question) => question.as_of === question.now && question.observed_before === question.now && question.expected_values.length > 0).length < 6) throw new Error("v2_fixture_current_coverage_failed");
  for (const world of worlds) for (const source of world.sources) {
    if (source.id.length > 180 || source.observed_at.length > 200 || source.text.length > 8_000) throw new Error("v2_fixture_source_length_invalid");
    for (const [index, fact] of source.expected_facts.entries()) {
      if (`${source.id}#${index}`.length > 200 || !fact.subject || !fact.predicate || !fact.value || (fact.valid_to !== null && fact.valid_from !== null && fact.valid_to <= fact.valid_from)) throw new Error("v2_fixture_fact_invalid");
      if (fact.supersedes_source_id && !world.sources.some((prior) => prior.id === fact.supersedes_source_id && prior.observed_at <= source.observed_at)) throw new Error("v2_fixture_predecessor_invalid");
    }
  }
}

export async function runTemporalV2Evaluation(options: { provider?: Provider; split?: "development" | "holdout" | "all"; out?: string; answerer?: V2Answerer; onProgress?: (report: V2Report) => void } = {}): Promise<V2Report> {
  if (options.provider && options.provider !== "qwen-local") throw new Error("unsupported_provider");
  validateV2Fixtures();
  const split = options.split ?? "all"; const worlds = V2_WORLDS.filter((world) => split === "all" || world.split === split); const enabled = options.provider === "qwen-local"; const started = performance.now();
  return withEmbeddingsDisabled(async () => {
    const temp = mkdtempSync(join(tmpdir(), "recall-temporal-v2-"));
    const report: V2Report = { status: "partial", dataset_version: V2_VERSION, invocation: { provider: enabled ? "qwen-local" : null, split, model: "qwen3.8-flash-next", reasoning_effort: "none", world_concurrency: enabled ? 2 : 0, max_model_concurrency: enabled ? 3 : 0 }, reproducibility: hashes(), counts: { worlds: worlds.length, sources: worlds.flatMap((world) => world.sources).length, questions: worlds.flatMap((world) => world.questions).length, planned_holdout_worlds: worlds.filter((world) => world.split === "holdout").length }, known_tokens: usage([], enabled), elapsed_ms: 0, limitations: ["Offline synthetic evaluation only; it neither enables automatic intake nor writes a production database.", V1_RECONSTRUCTION, "Structured lookup is scored on each arm's own extracted store. Natural v2 parsing is scored separately, including its key and both parsed times."], worlds: [], summary: {} };
    const persist = () => { report.elapsed_ms = Math.round(performance.now() - started); report.known_tokens = usage(attempts(report), enabled); report.summary = summary(report, worlds); if (options.out) atomicWrite(options.out, report); options.onProgress?.(report); };
    try {
      const results = new Array<V2WorldResult | undefined>(worlds.length); const permits = semaphore(3);
      await pool(worlds, enabled ? 2 : 1, async (world, index) => { results[index] = await runWorld(world, enabled, options.answerer, permits, temp); report.worlds = results.filter((result): result is V2WorldResult => Boolean(result)); persist(); });
      report.worlds = results as V2WorldResult[]; report.status = "complete"; return report;
    } finally { persist(); rmSync(temp, { recursive: true, force: true }); }
  });
}

async function runWorld(world: V2World, enabled: boolean, answerer: V2Answerer | undefined, permits: ReturnType<typeof semaphore>, temp: string): Promise<V2WorldResult> {
  let ideal: RecallDb | undefined; let v1: RecallDb | undefined; let v2: RecallDb | undefined;
  try {
    ideal = initStandaloneDb(join(temp, `${world.id}-ideal.db`)); v1 = initStandaloneDb(join(temp, `${world.id}-v1.db`)); v2 = initStandaloneDb(join(temp, `${world.id}-v2.db`)); seed(ideal, world, world.repo, false);
    const sources: V2SourceResult[] = [];
    for (let index = 0; index < world.sources.length; index += 1) {
      const source = world.sources[index]!;
      if (!enabled) { sources.push(sourceRow(source, empty(), empty())); continue; }
      const old = await captureV1(v1, world, source, world.sources.slice(0, index), answerer, permits);
      const fresh = await captureV2(v2, world, source, answerer, permits);
      sources.push(sourceRow(source, scoreV1(old, source, world), scoreV2(fresh, source, v2, world)));
    }
    const questions = await Promise.all(world.questions.map((question) => scoreQuestion(ideal!, v1!, v2!, world, question, enabled, answerer, permits)));
    return { id: world.id, split: world.split, family: world.family, sources, questions };
  } finally { ideal?.$client.close(); v1?.$client.close(); v2?.$client.close(); }
}

function sourceRow(source: V2Source, v1: Stage, v2: Stage): V2SourceResult { return { id: source.id, expected_route: source.expected_route, expected_type: source.expected_type ?? null, expected_fact_count: source.expected_facts.length, observed_start: source.expected_route === "temporal" && source.expected_facts.length === 1 && source.expected_facts[0]?.valid_from === null, v1, v2 }; }
async function scoreQuestion(ideal: RecallDb, v1: RecallDb, v2: RecallDb, world: V2World, question: V2Question, enabled: boolean, answerer: V2Answerer | undefined, permits: ReturnType<typeof semaphore>): Promise<V2QuestionResult> {
  const ideal_exact = matches(query(ideal, world.repo, question), question, world);
  const comparable = !world.sources.some((source) => source.expected_facts.some((fact) => fact.subject === question.subject && fact.predicate === question.predicate) && (source.expected_facts.length > 1 || source.expected_facts.some((fact) => fact.valid_from === null)));
  if (!enabled) return { id: question.id, comparable, expected_nonempty: question.expected_values.length > 0, ideal_exact, v1_structured_exact: null, v2_structured_exact: null, v2_natural_exact: null, v2_key_exact: null, v2_as_of_exact: null, v2_observed_before_exact: null, v2_route: null, v2_error: null, raw_output: null, call: null, attempted: false };
  const v1_structured_exact = matches(query(v1, world.repo, question), question, world);
  const v2_structured_exact = matches(query(v2, modelRepo(world), question), question, world);
  let call: Call | null = null; let attempted = false; let raw: string | null = null;
  try {
    const result = await queryTemporalLanguage(v2, { repo: modelRepo(world), text: question.text, now: question.now }, { predicates: POLICY, model: async (input) => { attempted = true; const answer = await model("v2", "query", input.system, input.user, answerer, permits); call = toCall(answer); raw = answer.text; return answer.text; } });
    const parsed = parseQuery(raw); const key = stableTemporalKey(modelRepo(world), question.subject, question.predicate);
    const v2_key_exact = parsed?.key_id === key; const v2_as_of_exact = result.result?.as_of === question.as_of; const v2_observed_before_exact = result.result?.observed_before === question.observed_before;
    const resultExact = result.route === "temporal" && result.result ? matches(result.result, question, world) : false;
    const supported = question.expected_values.length > 0;
    return { id: question.id, comparable, expected_nonempty: supported, ideal_exact, v1_structured_exact, v2_structured_exact, v2_natural_exact: supported ? Boolean(resultExact && v2_key_exact && v2_as_of_exact && v2_observed_before_exact) : false, v2_key_exact, v2_as_of_exact, v2_observed_before_exact, v2_route: result.route, v2_error: result.error ?? null, raw_output: redact(raw), call, attempted };
  } catch (cause) { return { id: question.id, comparable, expected_nonempty: question.expected_values.length > 0, ideal_exact, v1_structured_exact, v2_structured_exact, v2_natural_exact: false, v2_key_exact: false, v2_as_of_exact: false, v2_observed_before_exact: false, v2_route: null, v2_error: safe(cause), raw_output: redact(raw), call, attempted }; }
}

async function captureV1(db: RecallDb, world: V2World, source: V2Source, previous: readonly V2Source[], answerer: V2Answerer | undefined, permits: ReturnType<typeof semaphore>) {
  let attempted = false; let received: LocalModelAnswer | null = null;
  try {
    attempted = true; const answer = await model("v1", "capture", V1_SYSTEM, buildCategoryPrompt(world.repo, source, previous), answerer, permits); received = answer; const parsed = parseV1(answer.text);
    if (!parsed) return { parsed: null, stored: 0, raw: answer.text, call: toCall(answer), error: "malformed_model_schema", attempted };
    if (parsed.route !== "temporal") return { parsed, stored: 0, raw: answer.text, call: toCall(answer), error: null, attempted };
    const predecessor = parsed.fact!.supersedes_event_id ? sourceIdForOpaque(world, parsed.fact!.supersedes_event_id, previous) : null;
    if (parsed.fact!.supersedes_event_id && !predecessor) return { parsed, stored: 0, raw: answer.text, call: toCall(answer), error: "unresolved_predecessor", attempted };
    const supersedes_id = predecessor ? lookupId(db, world.repo, predecessor) : null;
    if (predecessor && !supersedes_id) return { parsed, stored: 0, raw: answer.text, call: toCall(answer), error: "unresolved_predecessor", attempted };
    appendTemporalFact(db, { repo: world.repo, event_id: source.id, ...parsed.fact!, observed_at: source.observed_at, evidence: source.text, source: source.id, supersedes_id });
    return { parsed, stored: 1, raw: answer.text, call: toCall(answer), error: null, attempted };
  } catch (cause) { return { parsed: null, stored: 0, raw: received?.text ?? null, call: received ? toCall(received) : null, error: received ? "store_rejected" : safe(cause), attempted }; }
}
async function captureV2(db: RecallDb, world: V2World, source: V2Source, answerer: V2Answerer | undefined, permits: ReturnType<typeof semaphore>) {
  let call: Call | null = null; let attempted = false;
  try {
    const result = await captureTemporalSource(db, modelSource(world, source), { predicates: POLICY, model: async (input) => { attempted = true; const answer = await model("v2", "capture", input.system, input.user, answerer, permits); call = toCall(answer); return answer.text; } });
    return { result, call, attempted };
  } catch (cause) { return { result: null, call, attempted, error: safe(cause) }; }
}
function scoreV1(value: Awaited<ReturnType<typeof captureV1>>, source: V2Source, world: V2World): Stage {
  const parsed = value.parsed; const single = singleState(source);
  return { route: parsed?.route ?? null, route_exact: parsed ? parsed.route === source.expected_route : false, type_exact: source.expected_route === "ordinary" ? parsed?.memory_type === source.expected_type : null, facts_exact: single ? factSame(parsed?.fact, source.expected_facts[0]!, world) : null, single_state_exact: single ? factSame(parsed?.fact, source.expected_facts[0]!, world) : null, stored: value.stored, raw_output: redact(value.raw), error: value.error, call: value.call, attempted: value.attempted };
}
function scoreV2(value: Awaited<ReturnType<typeof captureV2>>, source: V2Source, db: RecallDb, world: V2World): Stage {
  if (!value.result) return { ...empty(), error: value.error, call: value.call, attempted: value.attempted };
  const actual = value.result.stored; const single = singleState(source);
  return { route: value.result.route, route_exact: value.result.route === source.expected_route, type_exact: source.expected_route === "ordinary" ? value.result.memory_type === source.expected_type : null, facts_exact: source.expected_route === "temporal" ? factsSame(actual, source.expected_facts, db, world, source.observed_at) : actual.length === 0, single_state_exact: single ? factsSame(actual, source.expected_facts, db, world, source.observed_at) : null, stored: actual.length, raw_output: redact(value.result.raw_output), error: value.result.error ?? (value.result.rejected.length ? "proposal_rejected" : null), call: value.call, attempted: value.attempted };
}

function seed(db: RecallDb, world: V2World, repo: string, opaque: boolean) { const ids = new Map<string, string>(); for (const source of world.sources) for (const [index, fact] of source.expected_facts.entries()) { const prior = fact.supersedes_source_id && ids.get(fact.supersedes_source_id); if (fact.supersedes_source_id && !prior) throw new Error("fixture_supersession_missing"); const saved = appendTemporalFact(db, { repo, event_id: opaque ? `${opaqueSourceId(source.id)}#${index}` : `${source.id}#${index}`, subject: fact.subject, predicate: fact.predicate, value: fact.value, valid_from: fact.valid_from ?? source.observed_at, valid_to: fact.valid_to, observed_at: source.observed_at, evidence: source.text, source: opaque ? opaqueSourceId(source.id) : source.id, supersedes_id: prior ?? null }); if (index === 0) ids.set(source.id, saved.id); } }
function query(db: RecallDb, repo: string, question: V2Question) { return queryTemporalFacts(db, { repo, subject: question.subject, predicate: question.predicate, as_of: question.as_of, observed_before: question.observed_before, limit: 100 }); }
function matches(result: TemporalQueryResult, question: V2Question, world: V2World) { return same(result.facts.map((fact) => fact.value), question.expected_values) && same(result.facts.map((fact) => canonicalSource(fact.source ?? fact.event_id, world)), question.expected_source_ids) && result.conflict === question.expected_conflict; }
function lookupId(db: RecallDb, repo: string, sourceId: string) { return (db.$client.prepare("select id from temporal_facts where repo = ? and event_id = ?").get(repo, sourceId) as { id?: string } | undefined)?.id ?? null; }
function factsSame(actual: readonly TemporalFact[], expected: readonly V2Fact[], db: RecallDb, world: V2World, observedAt: string) { return same(actual.map((fact) => JSON.stringify(normalFact(fact, db, world))), expected.map((fact) => JSON.stringify(normalExpected(fact, observedAt)))); }
function factSame(actual: V1Output["fact"] | undefined, expected: V2Fact, world: V2World) { return !!actual && JSON.stringify(normalV1(actual, world)) === JSON.stringify(normalExpected(expected)); }
function normalFact(fact: TemporalFact, db: RecallDb, world: V2World) { const predecessor = fact.supersedes_id ? (db.$client.prepare("select source from temporal_facts where id = ?").get(fact.supersedes_id) as { source?: string } | undefined)?.source ?? null : null; return { subject: fact.subject, predicate: fact.predicate, value: fact.value, valid_from: fact.valid_from, valid_to: fact.valid_to, supersedes_source_id: predecessor ? canonicalSource(predecessor, world) : null }; }
function normalExpected(fact: V2Fact, observedAt?: string) { return { subject: fact.subject, predicate: fact.predicate, value: fact.value, valid_from: fact.valid_from ?? observedAt ?? null, valid_to: fact.valid_to, supersedes_source_id: fact.supersedes_source_id ?? null }; }
function normalV1(fact: NonNullable<V1Output["fact"]>, world: V2World) { return { subject: fact.subject, predicate: fact.predicate, value: fact.value, valid_from: fact.valid_from, valid_to: fact.valid_to, supersedes_source_id: fact.supersedes_event_id ? sourceIdForOpaque(world, fact.supersedes_event_id) : null }; }
function sourceIdForOpaque(world: V2World, value: string, candidates: readonly V2Source[] = world.sources) { return candidates.find((source) => opaqueSourceId(source.id) === value || source.id === value)?.id ?? null; }
function canonicalSource(value: string, world: V2World) { const source = sourceIdForOpaque(world, value); return source ?? value.replace(/#\d+$/, ""); }
function modelRepo(world: V2World) { return `repository_${hash(world.repo).slice(0, 16)}`; }
function modelSource(world: V2World, source: V2Source) { return { repo: modelRepo(world), event_id: opaqueSourceId(source.id), observed_at: source.observed_at, text: world.sources.reduce((text, item) => text.replaceAll(item.id, opaqueSourceId(item.id)), source.text) }; }
function singleState(source: V2Source) { const fact = source.expected_facts[0]; return source.expected_route === "temporal" && source.expected_facts.length === 1 && fact?.valid_from !== null; }

type V1Output = { route: Route; memory_type?: MemoryType; fact?: { subject: string; predicate: string; value: string; valid_from: string; valid_to: string | null; supersedes_event_id: string | null } };
function parseV1(raw: string): V1Output | null { const value = json(raw); if (!record(value) || !route(value.route)) return null; if (value.route === "ordinary") return type(value.memory_type) && value.fact === undefined ? { route: value.route, memory_type: value.memory_type } : null; if (value.route !== "temporal") return value.memory_type === undefined && value.fact === undefined ? { route: value.route } : null; const fact = value.fact; if (!record(fact) || !label(fact.subject) || !V2_PREDICATES.includes(fact.predicate as typeof V2_PREDICATES[number]) || !label(fact.value) || !timestamp(fact.valid_from) || !(fact.valid_to === null || timestamp(fact.valid_to)) || !(fact.supersedes_event_id === null || label(fact.supersedes_event_id))) return null; if (fact.predicate === "ttl_days" && !/^(?:0|[1-9]\d*)$/.test(fact.value)) return null; return { route: "temporal", fact: { subject: fact.subject.trim().toLowerCase().replace(/\s+/g, " "), predicate: fact.predicate as string, value: fact.value, valid_from: new Date(fact.valid_from).toISOString(), valid_to: fact.valid_to === null ? null : new Date(fact.valid_to).toISOString(), supersedes_event_id: fact.supersedes_event_id as string | null } }; }
function parseQuery(raw: string | null) { const value = raw && json(raw); return record(value) && value.route === "temporal" && typeof value.key_id === "string" ? { key_id: value.key_id } : null; }
function json(raw: string) { try { return JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return null; } }
function timestamp(value: unknown): value is string { return normalizeTemporalTimestamp(value) !== null; }
function route(value: unknown): value is Route { return value === "temporal" || value === "ordinary" || value === "ignore" || value === "defer"; }
function type(value: unknown): value is MemoryType { return value === "rule" || value === "command" || value === "gotcha" || value === "decision" || value === "review_pattern"; }
function label(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

async function model(arm: Arm, kind: "capture" | "query", system: string, user: string, answerer: V2Answerer | undefined, permits: ReturnType<typeof semaphore>) { return permits(() => answerer ? answerer({ arm, kind, system, user }) : callQwenLocal({ system, user, model: "qwen3.8-flash-next", reasoning_effort: "none" })); }
function toCall(answer: LocalModelAnswer): Call { return { provider: answer.provider, model: answer.model, duration_ms: answer.duration_ms, usage: answer.usage }; }
function empty(): Stage { return { route: null, route_exact: null, type_exact: null, facts_exact: null, single_state_exact: null, stored: 0, raw_output: null, error: null, call: null, attempted: false }; }
function redact(value: string | null | undefined) { return value === null || value === undefined ? null : redactSensitiveText(value); }
function safe(cause: unknown) { const message = cause instanceof Error ? cause.message : ""; if (/timeout/i.test(message)) return "model_timeout"; if (/HTTP\s+\d{3}/i.test(message)) return "model_http_error"; return "model_request_failed"; }
function same(left: readonly string[], right: readonly string[]) { const sorted = [...right].sort(); return left.length === sorted.length && [...left].sort().every((value, index) => value === sorted[index]); }
function pool<T>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<void>) { let next = 0; return Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { for (;;) { const index = next++; if (index >= items.length) return; await work(items[index]!, index); } })); }
function semaphore(limit: number) { let active = 0; const queued: Array<() => void> = []; const acquire = async () => { if (active < limit) { active += 1; return; } await new Promise<void>((resolve) => queued.push(resolve)); }; const release = () => { const next = queued.shift(); if (next) next(); else active -= 1; }; return async <T>(work: () => Promise<T>) => { await acquire(); try { return await work(); } finally { release(); } }; }
function attempts(report: V2Report) { return [...report.worlds.flatMap((world) => world.sources).flatMap((source) => [source.v1, source.v2]), ...report.worlds.flatMap((world) => world.questions).map((question) => ({ call: question.call, attempted: question.attempted }))]; }
function usage(rows: readonly { call: Call | null; attempted: boolean }[], enabled: boolean): V2Report["known_tokens"] { return Object.fromEntries((["prompt_tokens", "completion_tokens", "total_tokens", "cost_usd"] as const).map((field) => { const attempted = rows.filter((row) => row.attempted); const values = attempted.map((row) => row.call?.usage[field] ?? null); const known = values.filter((value): value is number => value !== null); return [field, { value: enabled && known.length ? known.reduce((total, value) => total + value, 0) : null, unknown_attempts: enabled ? values.length - known.length : 0 }]; })) as V2Report["known_tokens"]; }
function ratio(values: readonly (boolean | null)[]) { const known = values.filter((value): value is boolean => value !== null); return known.length ? known.filter(Boolean).length / known.length : null; }
function summary(report: V2Report, planned: readonly V2World[]) {
  const sources = report.worlds.flatMap((world) => world.sources); const questions = report.worlds.flatMap((world) => world.questions); const model = Boolean(report.invocation.provider);
  const sourceMetric = (rows: V2SourceResult[], total: number) => ({ planned: total, recorded: rows.length, v1_route: model ? ratio(rows.map((row) => row.v1.route_exact)) : null, v2_route: model ? ratio(rows.map((row) => row.v2.route_exact)) : null, v1_single_state: model ? ratio(rows.map((row) => row.v1.single_state_exact)) : null, v2_single_state: model ? ratio(rows.map((row) => row.v2.single_state_exact)) : null, v2_observed_start: model ? ratio(rows.filter((row) => row.observed_start).map((row) => row.v2.facts_exact)) : null, v2_multi_property: model ? ratio(rows.filter((row) => row.expected_route === "temporal" && row.expected_fact_count > 1).map((row) => row.v2.facts_exact)) : null, v1_ordinary_type: model ? ratio(rows.filter((row) => row.expected_route === "ordinary").map((row) => row.v1.type_exact)) : null, v2_ordinary_type: model ? ratio(rows.filter((row) => row.expected_route === "ordinary").map((row) => row.v2.type_exact)) : null, errors: rows.filter((row) => row.v1.error || row.v2.error).length });
  const queryMetric = (rows: V2QuestionResult[], total: number) => ({ planned: total, recorded: rows.length, v1_structured: model ? ratio(rows.map((row) => row.v1_structured_exact)) : null, v2_structured: model ? ratio(rows.map((row) => row.v2_structured_exact)) : null, v1_structured_supported: model ? ratio(rows.filter((row) => row.expected_nonempty).map((row) => row.v1_structured_exact)) : null, v2_structured_supported: model ? ratio(rows.filter((row) => row.expected_nonempty).map((row) => row.v2_structured_exact)) : null, v2_natural_supported: model ? ratio(rows.filter((row) => row.expected_nonempty).map((row) => row.v2_natural_exact)) : null, unsupported_controls: model ? ratio(rows.filter((row) => !row.expected_nonempty).map((row) => row.v2_route === "fallback")) : null });
  const by = <T>(key: (world: Pick<V2World, "split" | "family">) => string, metric: (actual: V2WorldResult[], target: V2World[]) => T) => Object.fromEntries([...new Set(planned.map(key))].sort().map((name) => [name, metric(report.worlds.filter((world) => key(world) === name), planned.filter((world) => key(world) === name))]));
  return { planned_source_attempts: report.counts.sources, recorded_source_attempts: sources.length, actual_source_callbacks: sources.flatMap((row) => [row.v1, row.v2]).filter((row) => row.attempted).length, planned_query_attempts: report.counts.questions, recorded_query_attempts: questions.length, actual_query_callbacks: questions.filter((row) => row.attempted).length, ideal_query_exact: ratio(questions.map((row) => row.ideal_exact)), structured_lookup: queryMetric(questions, report.counts.questions), source_capture: sourceMetric(sources, report.counts.sources), comparable_structured_lookup: queryMetric(questions.filter((row) => row.comparable), planned.flatMap((world) => world.questions.filter((question) => !world.sources.some((source) => source.expected_facts.some((fact) => fact.subject === question.subject && fact.predicate === question.predicate) && (source.expected_facts.length > 1 || source.expected_facts.some((fact) => fact.valid_from === null))))).length), wrong_answers: [...sources.flatMap((row) => [row.v1, row.v2]).filter((row) => row.attempted && !row.error && (row.route_exact === false || row.facts_exact === false)), ...questions.filter((row) => row.attempted && !row.v2_error && row.expected_nonempty && row.v2_natural_exact === false)].length, request_or_schema_failures: [...sources.flatMap((row) => [row.v1, row.v2]), ...questions.map((row) => ({ error: row.v2_error, attempted: row.attempted }))].filter((row) => row.attempted && row.error && /^(?:model_request_failed|model_response_invalid|malformed_model_schema|invalid_fact_count|model_http_error|model_timeout)$/.test(row.error)).length, by_split: by((world) => world.split, (actual, target) => ({ sources: sourceMetric(actual.flatMap((world) => world.sources), target.flatMap((world) => world.sources).length), queries: queryMetric(actual.flatMap((world) => world.questions), target.flatMap((world) => world.questions).length) })), by_family: by((world) => world.family, (actual, target) => ({ sources: sourceMetric(actual.flatMap((world) => world.sources), target.flatMap((world) => world.sources).length), queries: queryMetric(actual.flatMap((world) => world.questions), target.flatMap((world) => world.questions).length) })), by_ordinary_type: Object.fromEntries([...new Set(planned.flatMap((world) => world.sources).filter((source) => source.expected_route === "ordinary").map((source) => source.expected_type!))].sort().map((type) => [type, sourceMetric(sources.filter((source) => source.expected_type === type), planned.flatMap((world) => world.sources).filter((source) => source.expected_type === type).length)])), paired_world_bootstrap: bootstrap(report.worlds) };
}
function bootstrap(worlds: readonly V2WorldResult[]) { const differences = worlds.map((world) => { const v1 = ratio(world.sources.map((source) => source.v1.single_state_exact)), v2 = ratio(world.sources.map((source) => source.v2.single_state_exact)); return v1 === null || v2 === null ? null : v2 - v1; }).filter((value): value is number => value !== null); if (!differences.length) return { exploratory: true, samples: 0, interval_95: null }; let state = 0x6d2b79f5; const sample = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; }; const values = Array.from({ length: 400 }, () => Array.from({ length: differences.length }, () => differences[Math.floor(sample() * differences.length)]!).reduce((sum, value) => sum + value, 0) / differences.length).sort((a, b) => a - b); return { exploratory: true, samples: values.length, interval_95: [values[Math.floor(values.length * .025)]!, values[Math.floor(values.length * .975)]!] }; }
function hashes(): Record<string, string> { const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url))); return { fixture_sha256: hash(read("./temporal-v2-fixtures.ts")), runner_sha256: hash(read("./temporal-v2.ts")), runtime_sha256: hash(read("../src/temporal/intake.ts")), contract_sha256: hash(read("../src/temporal/intake-contract.ts")), prompt_sha256: hash(read("../src/temporal/intake-prompts.ts")), frozen_v1_prompt_source_sha256: hash(read("./temporal-categories.ts")) }; }
function hash(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function atomicWrite(path: string, report: V2Report) { const temp = `${path}.tmp`; writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`); renameSync(temp, path); }
function cli() { const options: { provider?: Provider; split?: "development" | "holdout" | "all"; out?: string } = {}; for (let index = 2; index < process.argv.length; index += 1) { const arg = process.argv[index]; if (arg === "--provider") options.provider = process.argv[++index] as Provider; else if (arg === "--split") options.split = process.argv[++index] as typeof options.split; else if (arg === "--out") options.out = process.argv[++index]; else throw new Error("unknown_argument"); } return runTemporalV2Evaluation(options).then((report) => { if (!options.out) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); }); }
if (process.argv[1] === fileURLToPath(import.meta.url)) void cli();

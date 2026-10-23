/** Offline category-router evaluation; it is not a deployed Recall intake path. */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import { appendTemporalFact, queryTemporalFacts } from "../src/temporal/store.js";
import { withEmbeddingsDisabled } from "./temporal.js";
import { callQwenLocal, type LocalModelAnswer } from "./temporal-model.js";
import { CATEGORY_VERSION, CATEGORY_WORLDS, type CategoryQuestion, type CategorySource, type CategoryWorld } from "./temporal-category-fixtures.js";

type Provider = "qwen-local";
type Route = CategorySource["expected_route"];
type Type = NonNullable<CategorySource["expected_type"]>;
type Usage = LocalModelAnswer["usage"];
export type CategoryAnswerer = (input: { system: string; user: string }) => Promise<LocalModelAnswer>;
export interface CategoryTemporalFieldExact { subject: boolean; predicate: boolean; value: boolean; valid_from: boolean; valid_to: boolean; supersedes_event_id: boolean; }
export interface CategorySourceResult { id: string; family: string; expected_route: Route; expected_type: Type | null; actual_route: Route | null; route_exact: boolean | null; type_exact: boolean | null; fact_exact: boolean | null; temporal_field_exact: CategoryTemporalFieldExact | null; ingestion: "stored" | "not_applicable" | "failed" | "skipped"; raw_output: string | null; model_call: { provider: string; model: string; duration_ms: number; usage: Usage } | null; error: string | null; }
export interface CategoryQueryResult { id: string; expected_nonempty: boolean; ideal_exact: boolean; extracted_exact: boolean | null; values: string[] | null; event_ids: string[] | null; conflict: boolean | null; error: string | null; }
export interface CategoryWorldResult { id: string; repo: string; sources: CategorySourceResult[]; questions: CategoryQueryResult[]; }
export interface CategoryReport {
  status: "partial" | "complete"; dataset_version: string;
  invocation: { provider: Provider | null; reasoning_effort: "none" | null; world_concurrency: number };
  reproducibility: { prompt_sha256: string; fixture_sha256: string; source_sha256: string };
  counts: { worlds: number; sources: number; questions: number }; elapsed_ms: number; failure_count: number;
  limitations: string[]; known_tokens: Record<keyof Usage, { value: number | null; unknown_attempts: number }>;
  worlds: CategoryWorldResult[]; summary: Record<string, unknown>;
}

const SYSTEM = "You are a conservative Recall source router. Return only valid JSON and never infer a date absent from the source.";
const SUPPORTED_PREDICATES = new Set(["storage_provider", "gateway", "currency", "ttl_days", "ranking_mode", "size", "mode", "cutoff_mode", "schedule_mode", "format", "transport"]);
const ROUTER_PROMPT = [
  "Classify exactly one source as temporal, ordinary, ignore, or defer.",
  "Policy: durable imperative coding conventions are ordinary and require memory_type rule|command|gotcha|decision|review_pattern. A single-value factual operational assertion with an explicit effective time is temporal. Fake, denied, hypothetical, dummy, or one-task text is ignore. Ambiguous dates, unconfirmed plans/cancellations, alias uncertainty, wrong properties, and multi-fact or multiple-value text are defer.",
  "Ordinary types: rule for standing conventions; command for a command to run; gotcha for an operational caveat; decision for a recorded design choice; review_pattern for a repeated review check. Vague reports such as 'faster' without a defined measurable property/value are defer.",
  "This is a fixed-ontology probe. For temporal facts use exactly one of: storage_provider (storage vendor), gateway (gateway), currency (currency), ttl_days (canonical integer day string), ranking_mode (search ranking), size (pool size), mode (job mode), cutoff_mode (billing cutoff), schedule_mode (payroll schedule), format (format), transport (transport). Do not invent another predicate. Preserve the source entity wording as lowercase with whitespace normalized. Emit canonical UTC ISO timestamps. A replacement may name one prior opaque source id.",
  "Return exactly {route, memory_type?, fact?:{subject,predicate,value,valid_from,valid_to,supersedes_event_id}}. Do not include explanations.",
].join("\n");

export function opaqueSourceId(id: string): string { return `source_${hash(id).slice(0, 16)}`; }
function opaqueRepository(repo: string): string { return `repository_${hash(repo).slice(0, 16)}`; }
function replacePriorSourceIds(text: string, prior: ReadonlyArray<Pick<CategorySource, "id">>): string {
  return prior.reduce((rewritten, item) => rewritten.replaceAll(item.id, opaqueSourceId(item.id)), text);
}
export function buildCategoryPrompt(repo: string, source: Pick<CategorySource, "id" | "observed_at" | "text">, prior: ReadonlyArray<Pick<CategorySource, "id" | "observed_at" | "text">>): string {
  const raw = prior.length ? prior.map((item) => `- source_id: ${opaqueSourceId(item.id)}\n  observed_at: ${item.observed_at}\n  text: ${replacePriorSourceIds(item.text, prior)}`).join("\n") : "(none)";
  return `${ROUTER_PROMPT}\n\nRepository: ${opaqueRepository(repo)}\nPrior raw sources:\n${raw}\n\nCurrent raw source:\nsource_id: ${opaqueSourceId(source.id)}\nobserved_at: ${source.observed_at}\ntext: ${replacePriorSourceIds(source.text, prior)}`;
}

export async function runCategoryEvaluation(options: { provider?: Provider; out?: string; answerer?: CategoryAnswerer; onProgress?: (report: CategoryReport) => void } = {}): Promise<CategoryReport> {
  if (options.provider && options.provider !== "qwen-local") throw new Error(`Unsupported provider: ${options.provider}`);
  const started = performance.now();
  return withEmbeddingsDisabled(async () => {
    const temp = mkdtempSync(join(tmpdir(), "recall-category-eval-"));
    const report: CategoryReport = {
      status: "partial", dataset_version: CATEGORY_VERSION,
      invocation: { provider: options.provider ?? null, reasoning_effort: options.provider ? "none" : null, world_concurrency: options.provider ? 3 : 0 },
      reproducibility: hashes(), counts: { worlds: CATEGORY_WORLDS.length, sources: CATEGORY_WORLDS.reduce((n, world) => n + world.sources.length, 0), questions: CATEGORY_WORLDS.reduce((n, world) => n + world.questions.length, 0) }, elapsed_ms: 0, failure_count: 0,
      limitations: ["This is a bounded offline source-router/extractor evaluation, not a deployed router or proof of all production memory semantics.", "Questions use gold structured fields against temporal stores; it intentionally performs no natural-language query parsing.", "Gold routes, types, facts, and questions are evaluator-only and never enter model prompts."],
      known_tokens: usage([], false), worlds: [], summary: {},
    };
    const persist = () => { report.elapsed_ms = Math.round(performance.now() - started); report.known_tokens = usage(report.worlds.flatMap((world) => world.sources), Boolean(options.provider)); report.failure_count = failures(report); report.summary = summarize(report); if (options.out) atomicWrite(options.out, report); options.onProgress?.(report); };
    try {
      const results = new Array<CategoryWorldResult | undefined>(CATEGORY_WORLDS.length);
      await pool(CATEGORY_WORLDS, 3, async (world, index) => { results[index] = await runWorld(world, options.provider, options.answerer, temp); report.worlds = results.filter((item): item is CategoryWorldResult => Boolean(item)); persist(); });
      report.worlds = results as CategoryWorldResult[];
      report.status = "complete";
      return report;
    } finally { persist(); rmSync(temp, { recursive: true, force: true }); }
  });
}

async function runWorld(world: CategoryWorld, provider: Provider | undefined, answerer: CategoryAnswerer | undefined, temp: string): Promise<CategoryWorldResult> {
  let ideal: RecallDb | undefined; let extracted: RecallDb | undefined;
  try {
    ideal = initStandaloneDb(join(temp, `${world.id}-ideal.db`)); extracted = initStandaloneDb(join(temp, `${world.id}-extracted.db`));
    seedIdeal(ideal, world);
    const stored = new Map<string, string>(); const sources: CategorySourceResult[] = [];
    const sourceIds = new Map(world.sources.map((source) => [opaqueSourceId(source.id), source.id]));
    for (let index = 0; index < world.sources.length; index += 1) {
      const source = world.sources[index]!;
      if (!provider) { sources.push(emptySource(source)); continue; }
      const response = await request(buildCategoryPrompt(world.repo, source, world.sources.slice(0, index)), answerer);
      const parsed = response.value ? parseOutput(response.value) : null;
      const output = parsed ? resolveOpaqueSupersedes(parsed, sourceIds) : null;
      const routeExact = output ? output.route === source.expected_route : false;
      const typeExact = source.expected_route === "ordinary" ? output?.memory_type === source.expected_type : source.expected_type ? false : true;
      const factExact = source.expected_route === "temporal" ? Boolean(output?.fact && exactFact(output.fact, source.expected_fact!)) : output?.fact === undefined;
      const temporalFieldExact = source.expected_route === "temporal" ? exactFactFields(output?.fact, source.expected_fact!) : null;
      let ingestion: CategorySourceResult["ingestion"] = output?.route === "temporal" ? "failed" : output ? "not_applicable" : "failed";
      let error = response.error ?? (!output ? "malformed model schema" : null);
      if (output?.route === "temporal" && output.fact) {
        const supersedes_id = output.fact.supersedes_event_id ? stored.get(output.fact.supersedes_event_id) : null;
        if (output.fact.supersedes_event_id && !supersedes_id) error = joinError(error, "unresolved supersedes_event_id");
        else try { const saved = appendTemporalFact(extracted, { repo: world.repo, event_id: source.id, ...output.fact, observed_at: source.observed_at, evidence: source.text, supersedes_id }); stored.set(source.id, saved.id); ingestion = "stored"; } catch (cause) { error = joinError(error, safeError(cause)); }
      }
      sources.push({ id: source.id, family: source.family, expected_route: source.expected_route, expected_type: source.expected_type ?? null, actual_route: output?.route ?? null, route_exact: routeExact, type_exact: typeExact, fact_exact: factExact, temporal_field_exact: temporalFieldExact, ingestion, raw_output: response.raw, model_call: response.call, error });
    }
    const questions = world.questions.map((question) => queryResult(ideal!, extracted!, world.repo, question, Boolean(provider)));
    return { id: world.id, repo: world.repo, sources, questions };
  } finally { ideal?.$client.close(); extracted?.$client.close(); }
}

function seedIdeal(db: RecallDb, world: CategoryWorld) {
  const ids = new Map<string, string>();
  for (const source of world.sources) if (source.expected_route === "temporal") {
    const fact = source.expected_fact!; const supersedes_id = fact.supersedes_event_id ? ids.get(fact.supersedes_event_id) : null;
    if (fact.supersedes_event_id && !supersedes_id) throw new Error(`Unresolved fixture supersession: ${fact.supersedes_event_id}`);
    const stored = appendTemporalFact(db, { repo: world.repo, event_id: source.id, ...fact, observed_at: source.observed_at, evidence: source.text, supersedes_id }); ids.set(source.id, stored.id);
  }
}
function queryResult(ideal: RecallDb, extracted: RecallDb, repo: string, question: CategoryQuestion, hasProvider: boolean): CategoryQueryResult {
  const idealResult = query(ideal, repo, question); const ideal_exact = matches(idealResult, question);
  const expected_nonempty = question.expected_event_ids.length > 0;
  if (!hasProvider) return { id: question.id, expected_nonempty, ideal_exact, extracted_exact: null, values: null, event_ids: null, conflict: null, error: null };
  try { const result = query(extracted, repo, question); return { id: question.id, expected_nonempty, ideal_exact, extracted_exact: matches(result, question), values: result.facts.map((item) => item.value), event_ids: result.facts.map((item) => item.event_id), conflict: result.conflict, error: null }; } catch (cause) { return { id: question.id, expected_nonempty, ideal_exact, extracted_exact: false, values: null, event_ids: null, conflict: null, error: safeError(cause) }; }
}
function query(db: RecallDb, repo: string, question: CategoryQuestion) { return queryTemporalFacts(db, { repo, subject: question.subject, predicate: question.predicate, as_of: question.as_of, observed_before: question.observed_before, mode: "snapshot", limit: 100 }); }
function matches(result: ReturnType<typeof queryTemporalFacts>, question: CategoryQuestion) { return same(result.facts.map((item) => item.value), question.expected_values) && same(result.facts.map((item) => item.event_id), question.expected_event_ids) && result.conflict === question.expected_conflict; }
function emptySource(source: CategorySource): CategorySourceResult { return { id: source.id, family: source.family, expected_route: source.expected_route, expected_type: source.expected_type ?? null, actual_route: null, route_exact: null, type_exact: null, fact_exact: null, temporal_field_exact: null, ingestion: "skipped", raw_output: null, model_call: null, error: null }; }

type Output = { route: Route; memory_type?: Type; fact?: NonNullable<CategorySource["expected_fact"]> };
async function request(user: string, answerer?: CategoryAnswerer): Promise<{ value: unknown | null; raw: string | null; call: CategorySourceResult["model_call"]; error: string | null }> {
  try { const answer = answerer ? await answerer({ system: SYSTEM, user }) : await callQwenLocal({ system: SYSTEM, user, reasoning_effort: "none" }); const value = json(answer.text); return { value, raw: answer.text, call: { provider: answer.provider, model: answer.model, duration_ms: answer.duration_ms, usage: answer.usage }, error: value === null ? "malformed model JSON" : null }; } catch (cause) { return { value: null, raw: null, call: null, error: safeError(cause) }; }
}
function parseOutput(value: unknown): Output | null {
  if (!record(value) || !route(value.route)) return null;
  if (value.route === "ordinary") return type(value.memory_type) && value.fact === undefined ? { route: value.route, memory_type: value.memory_type } : null;
  if (value.route !== "temporal") return value.memory_type === undefined && value.fact === undefined ? { route: value.route } : null;
  const fact = value.fact;
  if (!record(fact) || !text(fact.subject) || !predicate(fact.predicate) || !text(fact.value) || !validPredicateValue(fact.predicate, fact.value) || !timestamp(fact.valid_from) || !(fact.valid_to === null || timestamp(fact.valid_to)) || !(fact.supersedes_event_id === null || text(fact.supersedes_event_id))) return null;
  return { route: "temporal", fact: { subject: normalizedSubject(fact.subject), predicate: fact.predicate, value: fact.value, valid_from: normalized(fact.valid_from), valid_to: fact.valid_to === null ? null : normalized(fact.valid_to), supersedes_event_id: fact.supersedes_event_id ?? null } };
}
function exactFact(actual: NonNullable<Output["fact"]>, expected: NonNullable<CategorySource["expected_fact"]>) { return actual.subject === expected.subject && actual.predicate === expected.predicate && actual.value === expected.value && actual.valid_from === expected.valid_from && actual.valid_to === expected.valid_to && actual.supersedes_event_id === expected.supersedes_event_id; }
function exactFactFields(actual: Output["fact"] | undefined, expected: NonNullable<CategorySource["expected_fact"]>): CategoryTemporalFieldExact { return { subject: actual?.subject === expected.subject, predicate: actual?.predicate === expected.predicate, value: actual?.value === expected.value, valid_from: actual?.valid_from === expected.valid_from, valid_to: actual?.valid_to === expected.valid_to, supersedes_event_id: actual?.supersedes_event_id === expected.supersedes_event_id }; }
function resolveOpaqueSupersedes(output: Output, sourceIds: ReadonlyMap<string, string>): Output {
  if (!output.fact?.supersedes_event_id) return output;
  return { ...output, fact: { ...output.fact, supersedes_event_id: sourceIds.get(output.fact.supersedes_event_id) ?? output.fact.supersedes_event_id } };
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function route(value: unknown): value is Route { return value === "temporal" || value === "ordinary" || value === "ignore" || value === "defer"; }
function type(value: unknown): value is Type { return value === "rule" || value === "command" || value === "gotcha" || value === "decision" || value === "review_pattern"; }
function predicate(value: unknown): value is string { return typeof value === "string" && SUPPORTED_PREDICATES.has(value); }
function validPredicateValue(predicate: string, value: unknown): boolean { return predicate !== "ttl_days" || (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)); }
function normalizedSubject(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, " "); }
function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d\d-\d\d)(?:T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(Z|[+-]\d\d:\d\d))?$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const calendar = new Date(`${match[1]}T00:00:00.000Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== match[1]) return false;
  if (match[2] && (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59)) return false;
  return new Date(value).toISOString().length === 24;
}
function normalized(value: string): string { return new Date(value).toISOString(); }
function json(text: string): unknown | null { try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return null; } }
function same(left: readonly string[], right: readonly string[]): boolean { const ordered = [...right].sort(); return left.length === right.length && [...left].sort().every((item, index) => item === ordered[index]); }
function safeError(cause: unknown): string { return cause instanceof Error ? cause.message.replace(/Bearer\s+\S+/gi, "[redacted]").slice(0, 300) : "request failed"; }
function joinError(left: string | null, right: string): string { return left ? `${left}; ${right}` : right; }
function pool<T>(items: readonly T[], concurrency: number, work: (item: T, index: number) => Promise<void>) { let next = 0; return Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { for (;;) { const index = next++; if (index >= items.length) return; await work(items[index]!, index); } })); }
function usage(sources: CategorySourceResult[], enabled: boolean): CategoryReport["known_tokens"] { return Object.fromEntries((["prompt_tokens", "completion_tokens", "total_tokens", "cost_usd"] as const).map((field) => { if (!enabled) return [field, { value: null, unknown_attempts: 0 }]; const values = sources.map((source) => source.model_call?.usage[field] ?? null); const known = values.filter((value): value is number => value !== null); return [field, { value: known.length ? known.reduce((sum, value) => sum + value, 0) : null, unknown_attempts: values.length - known.length }]; })) as CategoryReport["known_tokens"]; }
function failures(report: CategoryReport) { return report.worlds.flatMap((world) => [...world.sources.filter((source) => source.error || source.route_exact === false || source.type_exact === false || source.fact_exact === false), ...world.questions.filter((question) => !question.ideal_exact || question.extracted_exact === false || question.error)]).length; }
function ratio(values: readonly (boolean | null)[]) { const known = values.filter((value): value is boolean => value !== null); return known.length ? known.filter(Boolean).length / known.length : null; }
function summarize(report: CategoryReport): Record<string, unknown> {
  const sources = report.worlds.flatMap((world) => world.sources); const questions = report.worlds.flatMap((world) => world.questions); const model = Boolean(report.invocation.provider);
  const planned = CATEGORY_WORLDS.flatMap((world) => world.sources);
  const temporal = sources.filter((row) => row.expected_route === "temporal");
  const supportedEvidence = questions.filter((row) => row.expected_nonempty);
  const emptyResult = questions.filter((row) => !row.expected_nonempty);
  const metric = (rows: CategorySourceResult[], count: number) => ({ planned: count, recorded: rows.length, route_exact: model ? ratio(rows.map((row) => row.route_exact)) : null, type_exact: model ? ratio(rows.filter((row) => row.expected_route === "ordinary").map((row) => row.type_exact)) : null, fact_exact: model ? ratio(rows.filter((row) => row.expected_route === "temporal").map((row) => row.fact_exact)) : null, errors: rows.filter((row) => row.error).length });
  const by = (key: (row: Pick<CategorySourceResult, "family" | "expected_route" | "expected_type">) => string) => Object.fromEntries([...new Set(planned.map((row) => key({ ...row, expected_type: row.expected_type ?? null })))].sort().map((name) => [name, metric(sources.filter((row) => key(row) === name), planned.filter((row) => key({ ...row, expected_type: row.expected_type ?? null }) === name).length)]));
  const queryScore = (rows: CategoryQueryResult[]) => ({ denominator: model ? rows.filter((row) => row.extracted_exact !== null).length : 0, accuracy: model ? ratio(rows.map((row) => row.extracted_exact)) : null });
  return { planned_source_attempts: report.counts.sources, recorded_source_attempts: sources.length, source_attempts: model ? sources.length : 0, planned_query_attempts: report.counts.questions, recorded_query_attempts: questions.length, route_exact: model ? ratio(sources.map((row) => row.route_exact)) : null, ordinary_type_exact: model ? ratio(sources.filter((row) => row.expected_route === "ordinary").map((row) => row.type_exact === true && row.route_exact === true)) : null, temporal_fact_exact: model ? ratio(temporal.map((row) => row.fact_exact)) : null, temporal_field_exact: Object.fromEntries((['subject', 'predicate', 'value', 'valid_from', 'valid_to', 'supersedes_event_id'] as const).map((field) => [field, { denominator: model ? temporal.length : 0, accuracy: model ? ratio(temporal.map((row) => row.temporal_field_exact?.[field] ?? false)) : null }])), ideal_query_exact: ratio(questions.map((row) => row.ideal_exact)), extracted_query_exact: model ? ratio(questions.map((row) => row.extracted_exact)) : null, extracted_query_scores: { aggregate: queryScore(questions), supported_evidence: queryScore(supportedEvidence), empty_result: queryScore(emptyResult) }, failed_source_attempts: sources.filter((row) => row.error).length, ignored_or_deferred_stored: sources.filter((row) => (row.expected_route === "ignore" || row.expected_route === "defer") && row.ingestion === "stored").length, failures: report.failure_count, by_family: by((row) => row.family), by_route: by((row) => row.expected_route), by_ordinary_type: by((row) => row.expected_type ?? "none") };
}
function hashes(): CategoryReport["reproducibility"] { const fixture = readFileSync(fileURLToPath(new URL("./temporal-category-fixtures.ts", import.meta.url))); const source = ["./temporal-categories.ts", "./temporal-category-fixtures.ts", "./temporal-model.ts", "../src/temporal/store.ts"].map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")).join("\n"); return { prompt_sha256: hash(`${SYSTEM}\n${ROUTER_PROMPT}`), fixture_sha256: hash(fixture), source_sha256: hash(source) }; }
function hash(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function atomicWrite(path: string, report: CategoryReport) { const temporary = `${path}.tmp`; writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`); renameSync(temporary, path); }
function cli() { const options: { provider?: Provider; out?: string } = {}; for (let index = 0; index < process.argv.length - 2; index += 1) { const arg = process.argv[index + 2]; if (arg === "--provider") options.provider = process.argv[++index + 2] as Provider; else if (arg === "--out") options.out = process.argv[++index + 2]; else throw new Error(`Unknown argument: ${arg}`); } return runCategoryEvaluation(options).then((report) => { if (!options.out) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); }); }
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void cli().catch((cause) => { console.error(safeError(cause)); process.exitCode = 1; });

/**
 * Source-language intake probe for the temporal assertion store. This is a
 * fixed-schema evaluation harness, not a production extractor or parser.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import { appendTemporalFact, queryTemporalFacts, type TemporalQueryResult } from "../src/temporal/store.js";
import { INTAKE_VERSION, INTAKE_WORLDS, type IntakeFact, type IntakeQuestion, type IntakeSource, type IntakeWorld } from "./temporal-intake-fixtures.js";
import { callQwenLocal, type LocalModelAnswer } from "./temporal-model.js";
import { withEmbeddingsDisabled } from "./temporal.js";

type Provider = "qwen-local";
type Status = "fact" | "ignore" | "unsupported";
type Usage = LocalModelAnswer["usage"];
type UsageTotals = Record<keyof Usage, { value: number | null; unknown_attempts: number }>;

const SCHEMA = [
  "Supported single-value assertions only:",
  "- subject production, predicate host (string value)",
  "- subject backups, predicate retention_days (canonical integer-day string value)",
  "- subject releases, predicate owner (string value)",
].join("\n");
const EXTRACTION_INSTRUCTIONS = [
  "Extract at most one supported temporal assertion from the current source.",
  "Ignore pretend, dry-run, example, dummy, and explicitly denied statements.",
  "Use unsupported for unrelated claims or claims that require multiple values outside the schema.",
  "A scheduled change has its stated effective date. Do not infer validity before that date.",
  "A correction may be observed after its effective date.",
  "Use supersedes_event_id only for an explicit replacement of a prior listed source.",
  "Return exactly JSON: {status:'fact'|'ignore'|'unsupported',subject?,predicate?,value?,valid_from?,valid_to?,supersedes_event_id?}. Dates must be YYYY-MM-DD.",
].join("\n");
const QUERY_INSTRUCTIONS = [
  "Parse the question into the fixed schema fields.",
  "Return exactly JSON: {subject,predicate,as_of,observed_before}. Both dates must be YYYY-MM-DD.",
].join("\n");
const SYSTEM = "You are a careful fixed-schema temporal parser. Do not invent facts outside supplied source language.";

export type IntakeAnswerer = (input: { kind: "extract" | "parse"; system: string; user: string }) => Promise<LocalModelAnswer>;

export interface IntakeStage {
  values: string[] | null;
  conflict: boolean | null;
  event_ids: string[] | null;
  exact: boolean | null;
}

export interface IntakeSourceResult {
  event_id: string;
  observed_at: string;
  extraction_exact: boolean | null;
  ingestion: "stored" | "not_applicable" | "failed" | "skipped";
  model_output: string | null;
  model_call: { model: string; provider: string; duration_ms: number; usage: Usage } | null;
  error: string | null;
}

export interface IntakeQuestionResult {
  id: string;
  parse_exact: boolean | null;
  model_output: string | null;
  model_call: { model: string; provider: string; duration_ms: number; usage: Usage } | null;
  error: string | null;
  ideal_oracle: IntakeStage;
  extracted_oracle: IntakeStage;
  extracted_parsed: IntakeStage;
}

export interface IntakeWorldResult {
  id: string;
  repo: string;
  sources: IntakeSourceResult[];
  questions: IntakeQuestionResult[];
}

export interface IntakeReport {
  status: "complete" | "partial";
  dataset_version: string;
  invocation: { provider: Provider | null; model_reasoning: "none" | null; model_concurrency: number; max_output_tokens: number };
  reproducibility: { prompt_sha256: string; source_sha256: string };
  counts: { worlds: number; sources: number; questions: number };
  known_tokens: UsageTotals;
  elapsed_ms: number;
  limitations: string[];
  worlds: IntakeWorldResult[];
  summary: Record<string, number | null>;
}

export function buildExtractionPrompt(source: Pick<IntakeSource, "event_id" | "observed_at" | "text">, prior: ReadonlyArray<Pick<IntakeSource, "event_id" | "observed_at" | "text">>): string {
  const priorText = prior.length
    ? prior.map((item) => `- event_id: ${item.event_id}\n  observed_at: ${item.observed_at}\n  text: ${item.text}`).join("\n")
    : "(none)";
  return `${SCHEMA}\n\n${EXTRACTION_INSTRUCTIONS}\n\nPrevious original sources in this world:\n${priorText}\n\nCurrent source:\nevent_id: ${source.event_id}\nobserved_at: ${source.observed_at}\ntext: ${source.text}`;
}

export function buildQueryPrompt(question: Pick<IntakeQuestion, "text">, repo: string): string {
  return `${SCHEMA}\n\n${QUERY_INSTRUCTIONS}\n\nRepository: ${repo}\nQuestion: ${question.text}`;
}

export async function runIntakeProbe(options: { provider?: Provider; out?: string; answerer?: IntakeAnswerer; onProgress?: (report: IntakeReport) => void } = {}): Promise<IntakeReport> {
  if (options.provider && options.provider !== "qwen-local") throw new Error(`Unsupported provider: ${options.provider}`);
  const started = performance.now();
  return withEmbeddingsDisabled(async () => {
    const temp = mkdtempSync(join(tmpdir(), "recall-temporal-intake-"));
    const report: IntakeReport = {
    status: "partial",
    dataset_version: INTAKE_VERSION,
    invocation: { provider: options.provider ?? null, model_reasoning: options.provider ? "none" : null, model_concurrency: options.provider ? 3 : 0, max_output_tokens: 512 },
    reproducibility: { prompt_sha256: hash(`${SYSTEM}\n${SCHEMA}\n${EXTRACTION_INSTRUCTIONS}\n${QUERY_INSTRUCTIONS}`), source_sha256: fixtureHash() },
    counts: { worlds: INTAKE_WORLDS.length, sources: INTAKE_WORLDS.reduce((total, world) => total + world.sources.length, 0), questions: INTAKE_WORLDS.reduce((total, world) => total + world.questions.length, 0) },
    known_tokens: emptyUsageTotals(),
    elapsed_ms: 0,
    limitations: [
      "This fixed-schema probe measures only single-assertion source extraction and temporal query parsing.",
      "It does not evaluate open-ended answering, entity resolution, multi-value claims, or production conversational capture.",
      "Gold annotations are evaluator-only and are never included in model prompts.",
    ],
    worlds: [],
    summary: {},
    };
    try {
      const results = new Array<IntakeWorldResult | undefined>(INTAKE_WORLDS.length);
      await pool(INTAKE_WORLDS, 3, async (world, index) => {
        results[index] = await runWorld(world, options.provider, options.answerer, temp);
        report.worlds = results.filter((value): value is IntakeWorldResult => value !== undefined);
        report.elapsed_ms = Math.round(performance.now() - started);
        report.known_tokens = usageTotal(report.worlds, Boolean(options.provider));
        report.summary = summarize(report);
        if (options.out) writeReport(options.out, report);
        options.onProgress?.(report);
      });
      report.worlds = results as IntakeWorldResult[];
      report.status = "complete";
      return report;
    } finally {
      report.elapsed_ms = Math.round(performance.now() - started);
      report.known_tokens = usageTotal(report.worlds, Boolean(options.provider));
      report.summary = summarize(report);
      if (options.out) writeReport(options.out, report);
      rmSync(temp, { recursive: true, force: true });
    }
  });
}

async function runWorld(world: IntakeWorld, provider: Provider | undefined, answerer: IntakeAnswerer | undefined, temp: string): Promise<IntakeWorldResult> {
  let ideal: RecallDb | undefined;
  let extracted: RecallDb | undefined;
  try {
    ideal = initStandaloneDb(join(temp, `${world.id}-ideal.db`));
    extracted = initStandaloneDb(join(temp, `${world.id}-extracted.db`));
    seedIdeal(ideal, world);
    const sourceResults: IntakeSourceResult[] = [];
    const extractedIds = new Map<string, string>();
    for (let index = 0; index < world.sources.length; index += 1) {
      const source = world.sources[index]!;
      if (!provider) {
        sourceResults.push({ event_id: source.event_id, observed_at: source.observed_at, extraction_exact: null, ingestion: "skipped", model_output: null, model_call: null, error: null });
        continue;
      }
      const response = await request("extract", buildExtractionPrompt(source, world.sources.slice(0, index)), answerer);
      const parsed = response.answer ? extraction(response.answer) : null;
      const extractionExact = parsed ? sameExtraction(parsed, source) : false;
      let ingestion: IntakeSourceResult["ingestion"] = !parsed ? "failed" : parsed.status === "fact" ? "failed" : "not_applicable";
      let error = response.error;
      if (parsed?.status === "fact") {
        const supersedes_id = parsed.supersedes_event_id ? extractedIds.get(parsed.supersedes_event_id) : null;
        if (parsed.supersedes_event_id && !supersedes_id) error = "unresolved supersedes_event_id";
        else {
          try {
            const stored = appendTemporalFact(extracted, { repo: world.repo, event_id: source.event_id, subject: parsed.subject!, predicate: parsed.predicate!, value: parsed.value!, valid_from: parsed.valid_from!, valid_to: parsed.valid_to, observed_at: source.observed_at, evidence: source.text, supersedes_id });
            extractedIds.set(source.event_id, stored.id);
            ingestion = "stored";
          } catch (cause) {
            error = safeError(cause);
          }
        }
      }
      sourceResults.push({ event_id: source.event_id, observed_at: source.observed_at, extraction_exact: extractionExact, ingestion, model_output: response.output, model_call: response.call, error });
    }
    const questions: IntakeQuestionResult[] = [];
    for (const question of world.questions) {
      const idealOracle = queryStage("ideal_oracle", ideal!, world.repo, question.subject, question.predicate, question.as_of, question.observed_before, question);
      if (!provider) {
        questions.push(skippedQuestion(question, idealOracle.stage, idealOracle.error));
        continue;
      }
      const extractedOracle = queryStage("extracted_oracle", extracted!, world.repo, question.subject, question.predicate, question.as_of, question.observed_before, question);
      const response = await request("parse", buildQueryPrompt(question, world.repo), answerer);
      const parsed = response.answer ? queryParse(response.answer) : null;
      const parsedResult = parsed
        ? queryStage("extracted_parsed", extracted!, world.repo, parsed.subject, parsed.predicate, parsed.as_of, parsed.observed_before, question)
        : { stage: failedStage(), error: null };
      questions.push({
        id: question.id,
        parse_exact: parsed ? sameQuery(parsed, question) : false,
        model_output: response.output,
        model_call: response.call,
        error: errors(response.error, idealOracle.error, extractedOracle.error, parsedResult.error),
        ideal_oracle: idealOracle.stage,
        extracted_oracle: extractedOracle.stage,
        extracted_parsed: parsedResult.stage,
      });
    }
    return { id: world.id, repo: world.repo, sources: sourceResults, questions };
  } finally {
    ideal?.$client.close();
    extracted?.$client.close();
  }
}

function seedIdeal(db: RecallDb, world: IntakeWorld) {
  const ids = new Map<string, string>();
  for (const source of world.sources) {
    if (source.expected_status !== "fact" || !source.expected_fact) continue;
    const fact = source.expected_fact;
    const predecessor = fact.supersedes_event_id ? ids.get(fact.supersedes_event_id) : undefined;
    if (fact.supersedes_event_id && !predecessor) throw new Error(`Unresolved fixture supersession: ${fact.supersedes_event_id}`);
    const stored = appendTemporalFact(db, { repo: world.repo, event_id: source.event_id, subject: fact.subject, predicate: fact.predicate, value: fact.value, valid_from: fact.valid_from, valid_to: fact.valid_to, observed_at: source.observed_at, evidence: source.text, supersedes_id: predecessor });
    ids.set(source.event_id, stored.id);
  }
}

function query(db: RecallDb, repo: string, subject: string, predicate: string, as_of: string, observed_before: string): TemporalQueryResult {
  return queryTemporalFacts(db, { repo, subject, predicate, as_of, observed_before, mode: "snapshot", limit: 100 });
}

function stage(result: TemporalQueryResult, question: IntakeQuestion): IntakeStage {
  const values = result.facts.map((fact) => fact.value);
  const event_ids = result.facts.map((fact) => fact.event_id);
  return { values, conflict: result.conflict, event_ids, exact: sameSet(values, question.expected_values) && result.conflict === question.expected_conflict && sameSet(event_ids, question.expected_event_ids) };
}

function queryStage(name: string, db: RecallDb, repo: string, subject: string, predicate: string, asOf: string, observedBefore: string, question: IntakeQuestion): { stage: IntakeStage; error: string | null } {
  try {
    return { stage: stage(query(db, repo, subject, predicate, asOf, observedBefore), question), error: null };
  } catch (cause) {
    return { stage: failedStage(), error: `${name} query failed: ${safeError(cause)}` };
  }
}

function failedStage(): IntakeStage {
  return { values: null, conflict: null, event_ids: null, exact: false };
}

function skippedQuestion(question: IntakeQuestion, idealOracle: IntakeStage, error: string | null): IntakeQuestionResult {
  return { id: question.id, parse_exact: null, model_output: null, model_call: null, error, ideal_oracle: idealOracle, extracted_oracle: { values: null, conflict: null, event_ids: null, exact: null }, extracted_parsed: { values: null, conflict: null, event_ids: null, exact: null } };
}

async function request(kind: "extract" | "parse", user: string, answerer?: IntakeAnswerer): Promise<{ answer: unknown | null; output: string | null; call: IntakeSourceResult["model_call"]; error: string | null }> {
  try {
    const response = answerer ? await answerer({ kind, system: SYSTEM, user }) : await callQwenLocal({ system: SYSTEM, user, reasoning_effort: "none" });
    return { answer: json(response.text), output: response.text, call: { model: response.model, provider: response.provider, duration_ms: response.duration_ms, usage: response.usage }, error: json(response.text) === null ? "malformed model JSON" : null };
  } catch (cause) {
    return { answer: null, output: null, call: null, error: safeError(cause) };
  }
}

type ParsedExtraction = { status: Status; subject?: string; predicate?: string; value?: string; valid_from?: string; valid_to: string | null; supersedes_event_id: string | null };
function extraction(value: unknown): ParsedExtraction | null {
  if (!record(value) || !status(value.status)) return null;
  if (value.status !== "fact") return { status: value.status, valid_to: null, supersedes_event_id: null };
  if (!schemaPair(value.subject, value.predicate) || typeof value.value !== "string" || !value.value.trim() || !date(value.valid_from) || !(value.valid_to === null || value.valid_to === undefined || date(value.valid_to)) || !(value.supersedes_event_id === null || value.supersedes_event_id === undefined || string(value.supersedes_event_id))) return null;
  const subject = value.subject as string;
  const predicate = value.predicate as string;
  if (predicate === "retention_days" && !/^(?:0|[1-9]\d*)$/.test(value.value)) return null;
  return { status: "fact", subject, predicate, value: value.value, valid_from: value.valid_from, valid_to: value.valid_to ?? null, supersedes_event_id: value.supersedes_event_id ?? null };
}

type ParsedQuery = { subject: string; predicate: string; as_of: string; observed_before: string };
function queryParse(value: unknown): ParsedQuery | null {
  if (!record(value) || !schemaPair(value.subject, value.predicate) || !date(value.as_of) || !date(value.observed_before)) return null;
  return { subject: value.subject as string, predicate: value.predicate as string, as_of: value.as_of, observed_before: value.observed_before };
}

function sameExtraction(actual: ParsedExtraction, source: IntakeSource): boolean {
  if (actual.status !== source.expected_status) return false;
  if (actual.status !== "fact") return true;
  const expected = source.expected_fact!;
  return actual.subject === expected.subject && actual.predicate === expected.predicate && actual.value === expected.value && actual.valid_from === expected.valid_from && actual.valid_to === expected.valid_to && actual.supersedes_event_id === expected.supersedes_event_id;
}

function sameQuery(actual: ParsedQuery, question: IntakeQuestion): boolean {
  return actual.subject === question.subject && actual.predicate === question.predicate && actual.as_of === question.as_of && actual.observed_before === question.observed_before;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function string(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function status(value: unknown): value is Status { return value === "fact" || value === "ignore" || value === "unsupported"; }
function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function schemaPair(subject: unknown, predicate: unknown): subject is string { return (subject === "production" && predicate === "host") || (subject === "backups" && predicate === "retention_days") || (subject === "releases" && predicate === "owner"); }
function json(text: string): unknown | null { try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return null; } }
function sameSet(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value) => right.includes(value)) && new Set(left).size === left.length && new Set(right).size === right.length; }
function safeError(cause: unknown): string { return cause instanceof Error ? cause.message.slice(0, 300) : "request failed"; }
function errors(...values: Array<string | null>): string | null { return values.filter((value): value is string => value !== null).join("; ") || null; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function fixtureHash(): string { return hash(readFileSync(fileURLToPath(new URL("./temporal-intake-fixtures.ts", import.meta.url)), "utf8")); }
function writeReport(path: string, report: IntakeReport) { writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`); }

function emptyUsageTotals(): UsageTotals {
  return Object.fromEntries((["prompt_tokens", "completion_tokens", "total_tokens", "cost_usd"] as const).map((field) => [field, { value: null, unknown_attempts: 0 }])) as UsageTotals;
}
function usageTotal(worlds: IntakeWorldResult[], providerEnabled: boolean): UsageTotals {
  if (!providerEnabled) return emptyUsageTotals();
  const attempts = [...worlds.flatMap((world) => world.sources), ...worlds.flatMap((world) => world.questions)];
  return Object.fromEntries((["prompt_tokens", "completion_tokens", "total_tokens", "cost_usd"] as const).map((field) => {
    const known = attempts.map((row) => row.model_call?.usage[field] ?? null).filter((value): value is number => value !== null);
    return [field, { value: known.length ? known.reduce((total, value) => total + value, 0) : null, unknown_attempts: attempts.length - known.length }];
  })) as UsageTotals;
}

function summarize(report: IntakeReport): Record<string, number | null> {
  const sources = report.worlds.flatMap((world) => world.sources);
  const questions = report.worlds.flatMap((world) => world.questions);
  const denominators = {
    planned_source_attempts: report.counts.sources,
    recorded_source_attempts: sources.length,
    source_attempts: report.invocation.provider ? sources.length : 0,
    planned_parse_attempts: report.counts.questions,
    recorded_parse_attempts: questions.length,
    parse_attempts: report.invocation.provider ? questions.length : 0,
    ideal_oracle_denominator: questions.length,
  };
  if (!report.invocation.provider) return { ...denominators, extraction_exact: null, parse_exact: null, extracted_oracle_exact: null, extracted_parsed_exact: null, ideal_oracle_exact: ratio(questions.map((question) => question.ideal_oracle.exact)) };
  return { ...denominators, extraction_exact: ratio(sources.map((source) => source.extraction_exact)), parse_exact: ratio(questions.map((question) => question.parse_exact)), extracted_oracle_exact: ratio(questions.map((question) => question.extracted_oracle.exact)), extracted_parsed_exact: ratio(questions.map((question) => question.extracted_parsed.exact)), ideal_oracle_exact: ratio(questions.map((question) => question.ideal_oracle.exact)) };
}
function ratio(values: readonly (boolean | null)[]): number | null { const known = values.filter((value): value is boolean => value !== null); return known.length ? known.filter(Boolean).length / known.length : null; }
async function pool<T>(items: readonly T[], concurrency: number, work: (item: T, index: number) => Promise<void>) { let next = 0; await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { for (;;) { const index = next++; if (index >= items.length) return; await work(items[index]!, index); } })); }

function cli() {
  const args = process.argv.slice(2);
  let provider: Provider | undefined;
  let out: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--provider") provider = args[++index] as Provider;
    else if (arg === "--out") out = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return runIntakeProbe({ provider, out }).then((report) => { if (!out) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void cli();

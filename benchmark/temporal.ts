/**
 * Synthetic temporal smoke benchmark. It measures three representations of the
 * same assertions; it is neither LongMemEval nor an APEX-MEM reproduction.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import { compileContext } from "../src/compiler/context.js";
import { createMemory } from "../src/models/memory.js";
import { callLlm, type LlmCallResult, type LlmProvider } from "../src/llm/client.js";
import { FIXTURE_VERSION, TEMPORAL_QUESTIONS, TEMPORAL_SOURCE_EVENTS, type TemporalQuestion, type TemporalSourceEvent } from "./temporal-fixtures.js";
import { callQwenLocal, type QwenReasoning } from "./temporal-model.js";

const CONTEXT_CAP_CHARS = 2_000 * 4;
const SYSTEM = [
  "Answer only from the supplied evidence. Return JSON with values (string array), conflict (boolean), and evidence_event_ids (string array). Use empty values only when the evidence supports no answer.",
  "Temporal semantics: validity is [valid_from, valid_to); observed_before limits which source observations are visible; an explicit replacement retires its predecessor from the successor's valid_from permanently; independent overlapping values remain a conflict; confidence never chooses a winner.",
].join("\n");
export type Provider = LlmProvider | "qwen-local";
type Answer = { values: string[]; conflict: boolean; evidence_event_ids: string[] };
export type Usage = { prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null; cost_usd: number | null };
export type BenchmarkAnswerer = (input: { provider: Provider; model?: string; system: string; user: string }) => Promise<{ text: string; provider: string; model: string; duration_ms: number; usage: Usage }>;
export type TemporalDataset = { version: string; events: readonly TemporalSourceEvent[]; questions: readonly TemporalQuestion[] };
export type ModelLimiter = <T>(work: () => Promise<T>) => Promise<T>;

// Benchmark runs use isolated stores but share this process environment. Keep
// embeddings disabled until the final overlapping run releases its lease.
let embeddingLease: { active: number; original: string | undefined } | undefined;
export async function withEmbeddingsDisabled<T>(work: () => Promise<T>): Promise<T> {
  if (!embeddingLease) {
    embeddingLease = { active: 0, original: process.env.RECALL_EMBEDDINGS_DISABLED };
  }
  embeddingLease.active += 1;
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  try {
    return await work();
  } finally {
    const lease = embeddingLease!;
    lease.active -= 1;
    if (lease.active === 0) {
      if (lease.original === undefined) delete process.env.RECALL_EMBEDDINGS_DISABLED;
      else process.env.RECALL_EMBEDDINGS_DISABLED = lease.original;
      embeddingLease = undefined;
    }
  }
}

export interface Score { answer_exact_match: boolean; grounded_exact_match: boolean; malformed: boolean; }
export interface ArmResult {
  arm: "compiler" | "temporal" | "history" | "scoped-history";
  context_chars: number; context_tokens_estimate: number; truncated: boolean;
  retrieved_event_ids: string[]; gold_source_coverage: boolean | null;
  temporal_conflict: boolean | null; temporal_values?: string[]; retrieval_ms: number;
  model_attempt_ms?: number;
  model_call?: { provider: string; model: string; duration_ms: number; usage: Usage };
  answer?: Answer; score?: Score; error?: string;
}
export interface BenchmarkReport {
  status: "complete" | "partial"; fixture_version: string; git_revision: string | null;
  reproducibility: { git_dirty: boolean | null; source_sha256: string | null; source_files: string[] };
  invocation: { provider: Provider | null; model: string | null; limit: number; context_cap_chars: number; fixed_time_inputs: true; model_concurrency: number; max_output_tokens: number; qwen_reasoning: QwenReasoning | "server_default" | null };
  apex_mem: { status: "not_run"; reason: string; paper_url: string };
  limitations: string[]; questions: Array<{ id: string; category: string; world_id?: string; stratum?: string; template_id?: string; arms: ArmResult[] }>;
  summary: Record<string, unknown>;
}

export function buildAnswerPrompt(question: TemporalQuestion, context: string): string {
  return `Question:\n${question.question}\n\nEffective as_of: ${question.as_of}\nKnowledge cutoff observed_before: ${question.observed_before}\n\nEvidence:\n${context || "(no retrieved evidence)"}\n\nReturn exactly one JSON object.`;
}

export function scoreOutcome(raw: unknown, question: Pick<TemporalQuestion, "expected_values" | "expected_event_ids" | "expected_conflict">): Score {
  const answer = parseAnswer(raw);
  if (!answer) return { answer_exact_match: false, grounded_exact_match: false, malformed: true };
  const answerExact = sameSet(answer.values, question.expected_values) && answer.conflict === question.expected_conflict;
  return { answer_exact_match: answerExact, grounded_exact_match: answerExact && sameSet(answer.evidence_event_ids, question.expected_event_ids), malformed: false };
}

export async function runTemporalBenchmark(options: {
  provider?: Provider; model?: string; limit?: number; out?: string; answerer?: BenchmarkAnswerer; qwen_reasoning?: QwenReasoning;
  dataset?: TemporalDataset; include_scoped_history?: boolean; model_limiter?: ModelLimiter;
  onProgress?: (progress: { complete_questions: number; planned_questions: number; report: BenchmarkReport }) => void;
} = {}): Promise<BenchmarkReport> {
  const provider = options.provider;
  if (provider && !["openai", "anthropic", "azure-openai", "qwen-local"].includes(provider)) throw new Error(`Unsupported provider: ${provider}`);
  if (options.qwen_reasoning && (provider !== "qwen-local" || !["none", "low", "medium", "high"].includes(options.qwen_reasoning))) throw new Error("qwen_reasoning requires qwen-local and one of none, low, medium, high");
  const dataset = options.dataset ?? { version: FIXTURE_VERSION, events: TEMPORAL_SOURCE_EVENTS, questions: TEMPORAL_QUESTIONS };
  const limit = validateLimit(options.limit, dataset.questions.length);
  const questions = dataset.questions.slice(0, limit);
  if (provider && questions.length > 100) throw new Error("Provider runs are capped at 100 questions");
  return withEmbeddingsDisabled(async () => {
    const temp = mkdtempSync(join(tmpdir(), "recall-temporal-benchmark-"));
    let db: RecallDb | undefined;
    const report: BenchmarkReport = {
    status: "partial", fixture_version: dataset.version, git_revision: gitRevision(), reproducibility: reproducibility(),
    invocation: { provider: provider ?? null, model: provider ? options.model ?? (provider === "qwen-local" ? "qwen3.8-flash-next" : null) : null, limit: questions.length, context_cap_chars: CONTEXT_CAP_CHARS, fixed_time_inputs: true, model_concurrency: provider ? (options.include_scoped_history ? 4 : 3) : 0, max_output_tokens: 512, qwen_reasoning: provider === "qwen-local" ? options.qwen_reasoning ?? "server_default" : null },
    apex_mem: { status: "not_run", reason: "No official runnable implementation located; paper results are a separate protocol", paper_url: "https://arxiv.org/abs/2604.14362" },
    limitations: ["Synthetic hand-structured smoke benchmark, not LongMemEval.", "Extraction and question parsing are not tested.", "Compiler arm is the deterministic SessionStart compiler path, not all Recall retrieval paths.", "Evidence coverage measures retrieval only; it is not answer accuracy."],
    questions: [], summary: {},
    };
    try {
      db = initStandaloneDb(join(temp, "benchmark.db"));
      await seed(db, dataset.events);
      for (const question of questions) {
        const arms = await runQuestion(db, question, dataset.events, provider, options.model, options.answerer, options.qwen_reasoning, options.include_scoped_history === true, options.model_limiter);
        const metadata = question as TemporalQuestion & { world_id?: string; stratum?: string; template_id?: string };
        report.questions.push({ id: question.id, category: question.category, ...(metadata.world_id ? { world_id: metadata.world_id } : {}), ...(metadata.stratum ? { stratum: metadata.stratum } : {}), ...(metadata.template_id ? { template_id: metadata.template_id } : {}), arms });
        if (options.out) writeReport(options.out, report);
        options.onProgress?.({ complete_questions: report.questions.length, planned_questions: questions.length, report });
      }
      report.status = "complete";
      report.summary = summarize(report, Boolean(provider));
      return report;
    } finally {
      if (db) db.$client.close();
      rmSync(temp, { recursive: true, force: true });
      if (options.out) writeReport(options.out, report);
    }
  });
}

async function seed(db: RecallDb, sourceEvents: readonly TemporalSourceEvent[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const events = dependencyOrderedEvents(sourceEvents);
  for (const event of events) {
    createMemory(db, { type: "decision", scope: "repo", repo: event.repo, source: "user_correction", confidence: 0.99, dedupe: false, text: sourcePayload(event) });
  }
  const temporal = await import("../src/temporal/store.js") as typeof import("../src/temporal/store.js");
  for (const event of events) {
    const predecessorKey = event.supersedes_event_id ? eventKey(event.repo, event.supersedes_event_id) : undefined;
    const supersedes_id = predecessorKey ? ids.get(predecessorKey) : undefined;
    if (predecessorKey && !supersedes_id) throw new Error(`Unresolved declared supersession: ${predecessorKey}`);
    const saved = temporal.appendTemporalFact(db, { ...event, supersedes_id });
    ids.set(eventKey(event.repo, event.event_id), saved.id);
  }
  return ids;
}

function dependencyOrderedEvents(events: readonly TemporalSourceEvent[]): TemporalSourceEvent[] {
  const known = new Set(events.map((event) => eventKey(event.repo, event.event_id)));
  const pending = [...events];
  const ordered: TemporalSourceEvent[] = [];
  const resolved = new Set<string>();
  for (;;) {
    const ready = pending.filter((event) => !event.supersedes_event_id || resolved.has(eventKey(event.repo, event.supersedes_event_id)));
    if (!ready.length) break;
    for (const event of ready) {
      pending.splice(pending.indexOf(event), 1);
      ordered.push(event);
      resolved.add(eventKey(event.repo, event.event_id));
    }
  }
  if (pending.length) {
    const missing = pending.map((event) => `${eventKey(event.repo, event.event_id)} -> ${eventKey(event.repo, event.supersedes_event_id!)}`);
    const unknown = missing.filter((edge) => !known.has(edge.split(" -> ")[1]!));
    throw new Error(`Unresolved declared supersession: ${(unknown.length ? unknown : missing).join(", ")}`);
  }
  return ordered;
}

function eventKey(repo: string, eventId: string): string { return `${repo}\u0000${eventId}`; }

async function runQuestion(db: RecallDb, question: TemporalQuestion, sourceEvents: readonly TemporalSourceEvent[], provider?: Provider, model?: string, answerer?: BenchmarkAnswerer, reasoning?: QwenReasoning, includeScopedHistory = false, modelLimiter?: ModelLimiter): Promise<ArmResult[]> {
  const compilerStarted = performance.now();
  const compiler = compileContext(db, { repo: question.repo });
  const compilerContext = cap(compiler.text);
  const compilerDuration = performance.now() - compilerStarted;
  const temporal = await import("../src/temporal/store.js") as typeof import("../src/temporal/store.js");
  const temporalStarted = performance.now();
  const snapshot = temporal.queryTemporalFacts(db, { repo: question.repo, subject: question.subject, predicate: question.predicate, as_of: question.as_of, observed_before: question.observed_before, mode: "snapshot", limit: 100 });
  const temporalContext = cap(JSON.stringify({ facts: snapshot.facts, conflict: snapshot.conflict }));
  const temporalDuration = performance.now() - temporalStarted;
  const historyStarted = performance.now();
  const historyText = dependencyOrderedEvents(sourceEvents).filter((event) => event.repo === question.repo).map(sourcePayload).join("\n\n");
  const historyContext = cap(historyText);
  const historyDuration = performance.now() - historyStarted;
  const arms: ArmResult[] = [
    makeArm("compiler", compilerContext, compiler.text.length > CONTEXT_CAP_CHARS, eventIds(compilerContext), question, null, compilerDuration),
    { ...makeArm("temporal", temporalContext, snapshot.truncated || JSON.stringify({ facts: snapshot.facts, conflict: snapshot.conflict }).length > CONTEXT_CAP_CHARS, eventIds(temporalContext), question, snapshot.conflict, temporalDuration), temporal_values: snapshot.facts.map((fact) => fact.value) },
    makeArm("history", historyContext, historyText.length > CONTEXT_CAP_CHARS, eventIds(historyContext), question, null, historyDuration),
  ];
  if (includeScopedHistory) {
    const started = performance.now();
    const scopedText = dependencyOrderedEvents(sourceEvents).filter((event) => event.repo === question.repo && normalized(event.subject) === normalized(question.subject) && normalized(event.predicate) === normalized(question.predicate)).map(sourcePayload).join("\n\n");
    const scopedContext = cap(scopedText);
    arms.push(makeArm("scoped-history", scopedContext, scopedText.length > CONTEXT_CAP_CHARS, eventIds(scopedContext), question, null, performance.now() - started));
  }
  if (!provider) return arms;
  const contexts = [compilerContext, temporalContext, historyContext, ...(includeScopedHistory ? [cap(dependencyOrderedEvents(sourceEvents).filter((event) => event.repo === question.repo && normalized(event.subject) === normalized(question.subject) && normalized(event.predicate) === normalized(question.predicate)).map(sourcePayload).join("\n\n"))] : [])];
  await Promise.all(arms.map((arm, index) => answerArm(db, arm, question, provider, model, contexts[index]!, answerer, reasoning, modelLimiter)));
  return arms;
}

function makeArm(arm: ArmResult["arm"], context: string, truncated: boolean, retrieved_event_ids: string[], question: TemporalQuestion, temporal_conflict: boolean | null, retrieval_ms: number): ArmResult {
  return { arm, context_chars: context.length, context_tokens_estimate: Math.ceil(context.length / 4), truncated, retrieved_event_ids, gold_source_coverage: question.expected_event_ids.length ? question.expected_event_ids.every((id) => retrieved_event_ids.includes(id)) : null, temporal_conflict, retrieval_ms };
}

async function answerArm(db: RecallDb, arm: ArmResult, question: TemporalQuestion, provider: Provider, model: string | undefined, context: string, answerer?: BenchmarkAnswerer, reasoning?: QwenReasoning, modelLimiter?: ModelLimiter): Promise<void> {
  const prompt = buildAnswerPrompt(question, context);
  const started = performance.now();
  try {
    const makeCall = (): Promise<LlmCallResult | Awaited<ReturnType<typeof callQwenLocal>> | Awaited<ReturnType<BenchmarkAnswerer>>> => answerer
      ? answerer({ provider, model, system: SYSTEM, user: prompt })
      : provider === "qwen-local"
      ? callQwenLocal({ system: SYSTEM, user: prompt, model, reasoning_effort: reasoning })
      : callLlm(db, { provider, model, task_kind: "temporal_benchmark", system: SYSTEM, user: prompt, max_output_tokens: 512, json_output: true, temperature: 0 });
    const call = modelLimiter ? await modelLimiter(makeCall) : await makeCall();
    const parsed = parseAnswer(call.text);
    if (!parsed) { arm.error = "malformed_output"; arm.score = { answer_exact_match: false, grounded_exact_match: false, malformed: true }; }
    else { arm.answer = parsed; arm.score = scoreOutcome(parsed, question); }
    arm.model_call = {
      provider: call.provider, model: call.model, duration_ms: call.duration_ms,
      usage: call.provider === "qwen-local" ? call.usage : measuredLegacyUsage(call.usage),
    };
  } catch (error) {
    arm.error = redactedError(error);
    arm.score = { answer_exact_match: false, grounded_exact_match: false, malformed: true };
  } finally {
    arm.model_attempt_ms = performance.now() - started;
  }
}

function sourcePayload(event: TemporalSourceEvent): string { return JSON.stringify({ event_id: event.event_id, subject: event.subject, predicate: event.predicate, value: event.value, valid_from: event.valid_from, valid_to: event.valid_to ?? null, observed_at: event.observed_at, evidence: event.evidence, confidence: event.confidence ?? 0.5, supersedes_event_id: event.supersedes_event_id ?? null }); }
function measuredLegacyUsage(usage: Usage): Usage {
  // Existing hosted adapters use zero for missing counters. A nonempty JSON
  // answer to this prompt necessarily consumes input and output tokens, so
  // zero cannot establish a measured total or dollar cost.
  const positiveInteger = (value: number | null) =>
    value !== null && Number.isInteger(value) && value > 0 ? value : null;
  const prompt_tokens = positiveInteger(usage.prompt_tokens);
  const completion_tokens = positiveInteger(usage.completion_tokens);
  const complete = prompt_tokens !== null && completion_tokens !== null;
  return {
    prompt_tokens, completion_tokens,
    total_tokens: complete ? positiveInteger(usage.total_tokens) : null,
    cost_usd: complete ? usage.cost_usd : null,
  };
}
function cap(text: string): string { return text.slice(0, CONTEXT_CAP_CHARS); }
function eventIds(context: string): string[] { return [...new Set([...context.matchAll(/"event_id"\s*:\s*"([^"]+)"/g)].map((match) => match[1]))]; }
function sameSet(actual: readonly string[], expected: readonly string[]): boolean { return actual.length === expected.length && actual.every((value) => expected.includes(value)) && new Set(actual).size === actual.length; }
function parseAnswer(raw: unknown): Answer | null { let value = raw; if (typeof raw === "string") { try { value = JSON.parse(raw); } catch { return null; } } if (!value || typeof value !== "object") return null; const record = value as Record<string, unknown>; if (!Array.isArray(record.values) || !record.values.every((v) => typeof v === "string") || typeof record.conflict !== "boolean" || !Array.isArray(record.evidence_event_ids) || !record.evidence_event_ids.every((v) => typeof v === "string")) return null; return { values: record.values as string[], conflict: record.conflict, evidence_event_ids: record.evidence_event_ids as string[] }; }
function redactedError(error: unknown): string { const message = error instanceof Error ? error.message : "request_failed"; return /HTTP \d{3}/.test(message) ? message.match(/HTTP \d{3}/)![0] : /timeout/.test(message) ? "timeout" : "request_failed"; }
function gitRevision(): string | null { try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } }
function reproducibility(): BenchmarkReport["reproducibility"] {
  const source_files = ["benchmark/temporal-fixtures.ts", "benchmark/temporal.ts", "benchmark/temporal-model.ts", "src/temporal/store.ts"];
  try {
    const hash = createHash("sha256");
    for (const file of source_files) hash.update(`${file}\0`).update(readFileSync(file));
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
    return { git_dirty: dirty, source_sha256: hash.digest("hex"), source_files };
  } catch { return { git_dirty: null, source_sha256: null, source_files }; }
}
function writeReport(path: string, report: BenchmarkReport): void { const temporary = `${path}.tmp`; writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`); renameSync(temporary, path); }
function armSummary(rows: ArmResult[], withModel: boolean): Record<string, unknown> {
  const coverage = rows.filter((arm) => arm.gold_source_coverage !== null);
  return {
    questions: rows.length,
    retrieval_source_coverage: coverage.length ? coverage.filter((arm) => arm.gold_source_coverage).length / coverage.length : null,
    context_chars_mean: rows.length ? Math.round(rows.reduce((sum, arm) => sum + arm.context_chars, 0) / rows.length) : 0,
    retrieval_ms_total: sum(rows.map((arm) => arm.retrieval_ms)),
    retrieval_ms_mean: mean(rows.map((arm) => arm.retrieval_ms)),
    ...(withModel ? {
      answer_exact_match: rows.length ? rows.filter((arm) => arm.score?.answer_exact_match).length / rows.length : 0,
      grounded_exact_match: rows.length ? rows.filter((arm) => arm.score?.grounded_exact_match).length / rows.length : 0,
      failed_attempts: rows.filter((arm) => arm.error || arm.score?.malformed).length,
      model_latency_ms_total: sum(rows.map((arm) => arm.model_attempt_ms ?? 0)),
      model_latency_ms_mean: mean(rows.map((arm) => arm.model_attempt_ms ?? 0)),
      usage: usageSummary(rows),
    } : { answer_exact_match: null, grounded_exact_match: null, qa_skipped: true, usage: { prompt_tokens: { value: null, unknown_count: 0 }, completion_tokens: { value: null, unknown_count: 0 }, total_tokens: { value: null, unknown_count: 0 }, cost_usd: { value: null, unknown_count: 0 } } }),
  };
}
function summarize(report: BenchmarkReport, withModel: boolean): Record<string, unknown> {
  const arms = report.questions.flatMap((question) => question.arms);
  const names = [...new Set(arms.map((arm) => arm.arm))];
  const byArm = Object.fromEntries(names.map((name) => [name, armSummary(arms.filter((arm) => arm.arm === name), withModel)]));
  const byCategory = Object.fromEntries([...new Set(report.questions.map((question) => question.category))].map((category) => {
    const categoryArms = report.questions.filter((question) => question.category === category).flatMap((question) => question.arms);
    return [category, Object.fromEntries(names.map((name) => [name, armSummary(categoryArms.filter((arm) => arm.arm === name), withModel)]))];
  }));
  return { arms: byArm, categories: byCategory, model_provider_totals: withModel ? modelProviderTotals(arms, report.invocation) : null, note: withModel ? "Answer scores use exact set matching." : "No provider selected: QA was skipped; reported coverage is retrieval only." };
}
function modelProviderTotals(arms: ArmResult[], invocation: BenchmarkReport["invocation"]): Record<string, unknown> {
  const fallback = `${invocation.provider ?? "unknown"}/${invocation.model ?? "default"}`;
  const groups = new Map<string, ArmResult[]>();
  for (const arm of arms) {
    const key = arm.model_call ? `${arm.model_call.provider}/${arm.model_call.model}` : fallback;
    groups.set(key, [...(groups.get(key) ?? []), arm]);
  }
  return Object.fromEntries([...groups].map(([key, rows]) => {
    return [key, {
      attempts: rows.length,
      failures: rows.filter((row) => row.error || row.score?.malformed).length,
      latency_ms_total: sum(rows.map((row) => row.model_attempt_ms ?? 0)),
      latency_ms_mean: mean(rows.map((row) => row.model_attempt_ms ?? 0)),
      usage: usageSummary(rows),
    }];
  }));
}
function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }
function mean(values: number[]): number { return values.length ? sum(values) / values.length : 0; }
function usageSummary(rows: ArmResult[]): Record<string, { value: number | null; unknown_count: number }> {
  const fields: Array<keyof Usage> = ["prompt_tokens", "completion_tokens", "total_tokens", "cost_usd"];
  return Object.fromEntries(fields.map((field) => {
    const values = rows.map((row) => row.model_call?.usage[field] ?? null);
    const known = values.filter((value): value is number => value !== null);
    return [field, { value: known.length ? sum(known) : null, unknown_count: values.length - known.length }];
  }));
}

function validateLimit(limit: number | undefined, max = TEMPORAL_QUESTIONS.length): number {
  if (limit === undefined) return max;
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new Error(`limit must be an integer from 1 to ${max}`);
  return limit;
}
function normalized(value: string): string { return value.trim().replace(/\s+/g, " ").toLowerCase(); }
function parseCli(args: string[]): { provider?: Provider; model?: string; limit?: number; out?: string; qwen_reasoning?: QwenReasoning } { const output: { provider?: Provider; model?: string; limit?: number; out?: string; qwen_reasoning?: QwenReasoning } = {}; for (let index = 0; index < args.length; index += 2) { const value = args[index + 1]; if (!value || !args[index].startsWith("--")) throw new Error(`Invalid argument: ${args[index]}`); if (args[index] === "--provider") output.provider = value as Provider; else if (args[index] === "--model") output.model = value; else if (args[index] === "--qwen-reasoning") output.qwen_reasoning = value as QwenReasoning; else if (args[index] === "--limit") output.limit = Number(value); else if (args[index] === "--out") output.out = value; else throw new Error(`Unknown option: ${args[index]}`); } validateLimit(output.limit); return output; }
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) { runTemporalBenchmark(parseCli(process.argv.slice(2))).then((report) => { console.table(Object.entries(report.summary.arms as Record<string, { questions: number; context_chars_mean: number; answer_exact_match: number | null }>).map(([arm, stats]) => ({ arm, questions: stats.questions, context_chars_mean: stats.context_chars_mean, answer_exact_match: stats.answer_exact_match ?? "skipped" }))); console.log("Synthetic smoke benchmark only; APEX-MEM was not run."); }).catch((error) => { console.error(error instanceof Error ? error.message : "benchmark failed"); process.exitCode = 1; }); }

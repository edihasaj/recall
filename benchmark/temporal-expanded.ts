/**
 * Repeated, synthetic temporal evaluation. This is a development harness, not
 * evidence for replacing Recall's memory engine or enabling a deployment.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  runTemporalBenchmark,
  type ArmResult,
  type BenchmarkAnswerer,
  type BenchmarkReport,
  type ModelLimiter,
  type Provider,
  type TemporalDataset,
} from "./temporal.js";
import type { QwenReasoning } from "./temporal-model.js";
import type { TemporalQuestion } from "./temporal-fixtures.js";
import { generateExpandedDataset } from "./temporal-expanded-fixtures.js";

export interface ExpandedQuestion extends TemporalQuestion {
  readonly world_id: string;
  readonly stratum: "clean" | "noise";
  /** The fixture generator may expose this explicitly; category is the fallback. */
  readonly template_id?: string;
}
export interface ExpandedDataset extends TemporalDataset {
  readonly questions: readonly ExpandedQuestion[];
}
type Metric = "grounded_exact_match" | "answer_exact_match";
type MetricSummary = { trials: number; distinct_questions: number; correct_trials: number; fully_correct_questions: number; value: number; answer_exact_match: number; grounded_exact_match: number; failures: number; malformed: number; context_chars_mean: number; latency_ms_mean: number; usage: Record<string, { value: number | null; unknown_count: number }> };
type Difference = { estimate: number; matched_worlds: number; world_ci_95: [number, number] | null; template_ci_95: [number, number] | null; leave_one_template_out: Array<{ omitted_template: string; estimate: number }> };
type RunState = { repeat: number; report: BenchmarkReport; complete_questions: number; planned_questions: number };

export interface ExpandedBenchmarkReport {
  status: "complete" | "partial";
  dataset: { version: string; seed: number; worlds_per_template: number; distinct_questions: number; distinct_worlds: number; templates: number };
  invocation: { provider: Provider | null; model: string | null; qwen_reasoning: QwenReasoning | "server_default" | null; repeats_planned: number; repeats_completed: number; limit: number; model_concurrency_global: number; arms: string[] };
  progress: { complete_trials: number; planned_trials: number };
  reproducibility: { source_sha256: string | null; source_files: string[] };
  runs: RunState[];
  summary: Record<string, unknown>;
  decision: { statement: string; integration_hurdles: Record<string, unknown> | null };
}
export interface ExpandedOptions {
  seed?: number;
  worlds_per_template?: number;
  repeats?: number;
  provider?: Provider;
  model?: string;
  qwen_reasoning?: QwenReasoning;
  out?: string;
  limit?: number;
  answerer?: BenchmarkAnswerer;
  dataset?: ExpandedDataset;
  generateDataset?: (seed: number, worldsPerTemplate: number) => ExpandedDataset;
}

/** A single process-wide gate shared by every arm of every repeat. */
export function createModelSemaphore(capacity = 6): ModelLimiter {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error("semaphore capacity must be a positive integer");
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (active < capacity) { active += 1; return; }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) { next(); return; }
    active -= 1;
  };
  return async <T>(work: () => Promise<T>): Promise<T> => {
    await acquire();
    try { return await work(); } finally { release(); }
  };
}

// All invocations in this process share admission, including concurrent callers.
const globalModelSemaphore = createModelSemaphore(6);

export async function runExpandedTemporalBenchmark(options: ExpandedOptions = {}): Promise<ExpandedBenchmarkReport> {
  const seed = options.seed ?? 20261018;
  const worldsPerTemplate = options.worlds_per_template ?? 4;
  const repeats = options.repeats ?? 3;
  if (!Number.isInteger(seed) || !Number.isInteger(worldsPerTemplate) || worldsPerTemplate < 1 || !Number.isInteger(repeats) || repeats < 1) throw new Error("seed, worlds-per-template, and repeats must be positive integers");
  const dataset = options.dataset ?? await loadGeneratedDataset(options.generateDataset, seed, worldsPerTemplate);
  const questions = dataset.questions.slice(0, options.limit ?? dataset.questions.length);
  if (!questions.length || (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > dataset.questions.length))) throw new Error(`limit must be an integer from 1 to ${dataset.questions.length}`);
  const limitedDataset: ExpandedDataset = { ...dataset, questions };
  const provider = options.provider;
  const semaphore = globalModelSemaphore;
  const states: RunState[] = Array.from({ length: repeats }, (_, index) => ({ repeat: index + 1, report: emptyRun(limitedDataset, provider, options), complete_questions: 0, planned_questions: questions.length }));
  const report: ExpandedBenchmarkReport = {
    status: "partial",
    dataset: { version: dataset.version, seed, worlds_per_template: worldsPerTemplate, distinct_questions: questions.length, distinct_worlds: new Set(questions.map((question) => question.world_id)).size, templates: new Set(questions.map(templateFor)).size },
    invocation: { provider: provider ?? null, model: options.model ?? (provider === "qwen-local" ? "qwen3.8-flash-next" : null), qwen_reasoning: provider === "qwen-local" ? options.qwen_reasoning ?? "server_default" : null, repeats_planned: repeats, repeats_completed: 0, limit: questions.length, model_concurrency_global: provider ? 6 : 0, arms: ["compiler", "temporal", "history", "scoped-history"] },
    progress: { complete_trials: 0, planned_trials: repeats * questions.length },
    reproducibility: sourceHash(),
    runs: states,
    summary: {},
    decision: decision(null),
  };
  const persist = (): void => { report.progress.complete_trials = states.reduce((total, state) => total + state.complete_questions, 0); if (options.out) atomicWrite(options.out, report); };
  const jobs = states.map((state) => async (): Promise<void> => {
    state.report = await runTemporalBenchmark({
      provider, model: options.model, qwen_reasoning: options.qwen_reasoning, answerer: options.answerer,
      dataset: limitedDataset, include_scoped_history: true, model_limiter: semaphore,
      onProgress: ({ complete_questions, planned_questions, report: run }) => {
        state.report = run; state.complete_questions = complete_questions; state.planned_questions = planned_questions; persist();
        process.stdout.write(`temporal-expanded repeat ${state.repeat}: ${complete_questions}/${planned_questions} questions\n`);
      },
    });
    state.complete_questions = state.report.questions.length;
    state.planned_questions = questions.length;
    report.invocation.repeats_completed += state.report.status === "complete" ? 1 : 0;
    persist();
  });
  await runWorkerPool(jobs, 2);
  report.status = report.invocation.repeats_completed === repeats ? "complete" : "partial";
  report.summary = summarizeExpanded(report, Boolean(provider));
  report.decision = decision(report.summary);
  persist();
  return report;
}

async function loadGeneratedDataset(factory: ExpandedOptions["generateDataset"], seed: number, worlds: number): Promise<ExpandedDataset> {
  if (factory) return factory(seed, worlds);
  return generateExpandedDataset(seed, worlds);
}

function emptyRun(dataset: ExpandedDataset, provider: Provider | undefined, options: ExpandedOptions): BenchmarkReport {
  return { status: "partial", fixture_version: dataset.version, git_revision: null, reproducibility: { git_dirty: null, source_sha256: null, source_files: [] }, invocation: { provider: provider ?? null, model: options.model ?? null, limit: dataset.questions.length, context_cap_chars: 8_000, fixed_time_inputs: true, model_concurrency: provider ? 4 : 0, max_output_tokens: 512, qwen_reasoning: provider === "qwen-local" ? options.qwen_reasoning ?? "server_default" : null }, apex_mem: { status: "not_run", reason: "not run", paper_url: "https://arxiv.org/abs/2604.14362" }, limitations: [], questions: [], summary: {} };
}
async function runWorkerPool(jobs: Array<() => Promise<void>>, workers: number): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, async () => {
    for (;;) { const index = next++; if (index >= jobs.length) return; await jobs[index]!(); }
  }));
}

function summarizeExpanded(report: ExpandedBenchmarkReport, withModel: boolean): Record<string, unknown> {
  const completeRuns = report.runs.filter((run) => run.report.status === "complete");
  const arms = [...new Set(completeRuns.flatMap((run) => run.report.questions.flatMap((question) => question.arms.map((arm) => arm.arm))))];
  const allRows = completeRuns.flatMap((run) => run.report.questions.flatMap((question) => question.arms.map((arm) => ({ question, arm }))));
  const categories = groupMetrics(allRows, (row) => row.question.category, arms, withModel);
  const strata = groupMetrics(allRows, (row) => row.question.stratum ?? "unlabelled", arms, withModel);
  const overall = groupMetrics(allRows, () => "all", arms, withModel).all;
  const paired = withModel && report.status === "complete" ? pairedDifferences(completeRuns) : null;
  const staticRows = allRows.filter((row) => isStatic(row.question));
  return {
    arms: overall,
    categories,
    strata,
    static_regression: withModel ? groupMetrics(staticRows, () => "static", arms, true).static : null,
    paired,
    note: withModel ? "Repeats are averaged per question before world/template aggregation; failures remain in denominators." : "No provider selected: QA and confidence intervals were skipped.",
  };
}
function groupMetrics(rows: Array<{ question: BenchmarkReport["questions"][number]; arm: ArmResult }>, key: (row: { question: BenchmarkReport["questions"][number]; arm: ArmResult }) => string, arms: string[], withModel: boolean): Record<string, Record<string, MetricSummary | null>> {
  const grouped = new Map<string, Array<{ question: BenchmarkReport["questions"][number]; arm: ArmResult }>>();
  for (const row of rows) grouped.set(key(row), [...(grouped.get(key(row)) ?? []), row]);
  return Object.fromEntries([...grouped].map(([name, values]) => [name, Object.fromEntries(arms.map((arm) => [arm, metricSummary(values.filter((row) => row.arm.arm === arm).map((row) => ({ ...row.arm, __question_id: row.question.id } as ArmResult & { __question_id: string })), withModel)]))]));
}
function metricSummary(rows: ArmResult[], withModel: boolean): MetricSummary | null {
  if (!withModel) return null;
  const failures = rows.filter((row) => row.error || row.score?.malformed).length;
  // Rows arrive repeat-major. Pair repeated calls by their stable question id in
  // groupMetrics before this point by attaching the id to the arm object.
  const byQuestion = new Map<string, ArmResult[]>();
  for (const row of rows) {
    const id = (row as ArmResult & { __question_id?: string }).__question_id ?? String(byQuestion.size);
    byQuestion.set(id, [...(byQuestion.get(id) ?? []), row]);
  }
  const questionScores = [...byQuestion.values()].map((answers) => ({ answer: average(answers.map((answer) => answer.score?.answer_exact_match ? 1 : 0)), grounded: average(answers.map((answer) => answer.score?.grounded_exact_match ? 1 : 0)) }));
  const grounded = average(questionScores.map((score) => score.grounded));
  const answer = average(questionScores.map((score) => score.answer));
  return { trials: rows.length, distinct_questions: questionScores.length, correct_trials: rows.filter((row) => row.score?.grounded_exact_match).length, fully_correct_questions: questionScores.filter((score) => score.grounded === 1).length, value: grounded, answer_exact_match: answer, grounded_exact_match: grounded, failures, malformed: rows.filter((row) => row.score?.malformed).length, context_chars_mean: average(rows.map((row) => row.context_chars)), latency_ms_mean: average(rows.map((row) => row.model_attempt_ms ?? 0)), usage: usage(rows) };
}
function pairedDifferences(runs: RunState[]): Record<string, Record<string, Difference>> {
  const armNames = [...new Set(runs.flatMap((run) => run.report.questions.flatMap((question) => question.arms.map((arm) => arm.arm))))].filter((arm) => arm !== "temporal");
  return Object.fromEntries((["grounded_exact_match", "answer_exact_match"] as Metric[]).map((metric) => [metric, Object.fromEntries(armNames.map((control) => [control, pairedFor(runs, control, metric)]))]));
}
function pairedFor(runs: RunState[], control: string, metric: Metric): Difference {
  const perQuestion = new Map<string, { world: string; template: string; differences: number[] }>();
  for (const run of runs) for (const question of run.report.questions) {
    const temporal = question.arms.find((arm) => arm.arm === "temporal")?.score?.[metric] ? 1 : 0;
    const other = question.arms.find((arm) => arm.arm === control)?.score?.[metric] ? 1 : 0;
    const world = question.world_id ?? question.id;
    const key = `${world}\0${question.id}`;
    const item = perQuestion.get(key) ?? { world, template: templateFor(question), differences: [] };
    item.differences.push(temporal - other); perQuestion.set(key, item);
  }
  const worlds = new Map<string, { template: string; values: number[] }>();
  for (const item of perQuestion.values()) {
    const world = worlds.get(item.world) ?? { template: item.template, values: [] };
    world.values.push(average(item.differences)); worlds.set(item.world, world);
  }
  const worldValues = [...worlds.values()].map((world) => average(world.values));
  const templates = new Map<string, number[]>();
  for (const world of worlds.values()) templates.set(world.template, [...(templates.get(world.template) ?? []), average(world.values)]);
  const templateValues = [...templates.values()].map(average);
  const estimate = average(templateValues);
  return { estimate, matched_worlds: worldValues.length, world_ci_95: bootstrap(worldValues, 20261018), template_ci_95: bootstrap(templateValues, 20261019), leave_one_template_out: [...templates.keys()].map((template) => ({ omitted_template: template, estimate: average([...templates].filter(([name]) => name !== template).map(([, values]) => average(values))) })) };
}
/** Seeded non-parametric cluster bootstrap. One observation is one world/template, never a repeat. */
export function bootstrap(values: readonly number[], seed: number, resamples = 2_000): [number, number] | null {
  if (!values.length) return null;
  let state = seed >>> 0;
  const next = (): number => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
  const means: number[] = [];
  for (let sample = 0; sample < resamples; sample += 1) { let total = 0; for (let draw = 0; draw < values.length; draw += 1) total += values[Math.floor(next() * values.length)]!; means.push(total / values.length); }
  means.sort((left, right) => left - right);
  return [means[Math.floor((resamples - 1) * 0.025)]!, means[Math.floor((resamples - 1) * 0.975)]!];
}
function decision(summary: Record<string, unknown> | null): ExpandedBenchmarkReport["decision"] {
  if (!summary) return { statement: "Synthetic generated variants and repeated calls are not independent real-world evidence and cannot authorize replacing the memory engine.", integration_hurdles: null };
  return { statement: "Synthetic generated variants and repeated calls are not independent real-world evidence and cannot authorize replacing the memory engine or any automatic deployment.", integration_hurdles: { grounded_gain_requirement: "+5 percentage points versus the strongest control with template 95% CI entirely above zero", static_regression_maximum: "5 percentage points", failures_maximum: "5%", status: "diagnostic development hurdles only; never an automatic switch" } };
}
function isStatic(question: BenchmarkReport["questions"][number]): boolean { return /static/i.test(question.category); }
function templateFor(question: { category: string; template_id?: string }): string { return question.template_id ?? question.category; }
function average(values: readonly number[]): number { return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0; }
function usage(rows: ArmResult[]): Record<string, { value: number | null; unknown_count: number }> { return Object.fromEntries((["prompt_tokens", "completion_tokens", "total_tokens", "cost_usd"] as const).map((field) => { const values = rows.map((row) => row.model_call?.usage[field] ?? null); const known = values.filter((value): value is number => value !== null); return [field, { value: known.length ? known.reduce((total, value) => total + value, 0) : null, unknown_count: values.length - known.length }]; })); }
function sourceHash(): { source_sha256: string | null; source_files: string[] } { const configured = ["benchmark/temporal-expanded-fixtures.ts", "benchmark/temporal-expanded-fixtures.js", "benchmark/temporal-expanded.ts", "benchmark/temporal.ts", "benchmark/temporal-model.ts", "src/compiler/context.ts", "src/temporal/store.ts"]; const source_files = configured.filter(existsSync); try { const hash = createHash("sha256"); for (const file of source_files) hash.update(`${file}\0`).update(readFileSync(file)); return { source_sha256: hash.digest("hex"), source_files }; } catch { return { source_sha256: null, source_files }; } }
function atomicWrite(path: string, value: unknown): void { const temporary = `${path}.tmp`; writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`); renameSync(temporary, path); }
function parseCli(args: string[]): ExpandedOptions { const out: ExpandedOptions = {}; for (let index = 0; index < args.length; index += 2) { const option = args[index]; const value = args[index + 1]; if (!option?.startsWith("--") || !value) throw new Error(`Invalid argument: ${option ?? ""}`); if (option === "--seed") out.seed = Number(value); else if (option === "--worlds-per-template") out.worlds_per_template = Number(value); else if (option === "--repeats") out.repeats = Number(value); else if (option === "--provider") out.provider = value as Provider; else if (option === "--model") out.model = value; else if (option === "--qwen-reasoning") out.qwen_reasoning = value as QwenReasoning; else if (option === "--out") out.out = value; else if (option === "--limit") out.limit = Number(value); else throw new Error(`Unknown option: ${option}`); } return out; }
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runExpandedTemporalBenchmark(parseCli(process.argv.slice(2))).then((report) => console.log(`temporal-expanded ${report.status}: ${report.progress.complete_trials}/${report.progress.planned_trials} trials`)).catch((error) => { console.error(error instanceof Error ? error.message : "expanded benchmark failed"); process.exitCode = 1; });

/** Fresh paired one-pass answer-policy trial over the frozen Recall-only saved contexts. */
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTEXT_REPLAY_CAP, type ContextReplayInput } from "./longmemeval-context-replay-input.js";
import { answerPrompt, createModelCall, judgePrompt, parseAnswer, parseJudge, safeError, sha256, type Call, type ModelCall } from "./longmemeval-qa-support.js";
import { longRequestFetch } from "./longmemeval-qa-transport.js";
import { HISTORY_EVIDENCE_POLICY } from "../src/history/evidence-policy.js";
import { MINIMAL_ANSWER_POLICY } from "./longmemeval-minimal-answer-policy.js";

export type MinimalPolicyTrialArm = "control" | "comparison";
export type MinimalPolicyTrialSelection = { development_ids: string[]; selected_review_ids: string[]; input_sha256: string; mask_seed: number | string };
export type MinimalPolicyTrialCalls = { control: ModelCall; comparison: ModelCall; judge: ModelCall };
export type MinimalPolicyTrialRow = {
  task_index: number; case_index: number; question_id: string; arm: MinimalPolicyTrialArm;
  question_type: string; is_abstention: boolean; context_sha256: string; context_utf16_chars: number;
  answer_prompt_sha256: string; base_prompt_sha256: string; answer_call: Call | null; judge_call: Call | null;
  answer: string | null; correct: boolean | null; error: string | null; judge_prompt_sha256: string | null;
};
export type MinimalPolicyTrialOptions = { input: ContextReplayInput | string; selection: MinimalPolicyTrialSelection | string; out: string; concurrency?: number; live?: boolean };
export const MINIMAL_POLICY_TRIAL_CONFIGS = {
  control: { provider: "qwen-local" as const, fetcher: longRequestFetch, options: { structuredOutput: true, reasoningEffort: "adaptive" as const, maxOutputTokens: 16_384, answerInstructions: HISTORY_EVIDENCE_POLICY } },
  comparison: { provider: "qwen-local" as const, fetcher: longRequestFetch, options: { structuredOutput: true, reasoningEffort: "adaptive" as const, maxOutputTokens: 16_384, answerInstructions: `${HISTORY_EVIDENCE_POLICY}\n\n${MINIMAL_ANSWER_POLICY}` } },
  judge: { provider: "qwen-local" as const, fetcher: longRequestFetch, options: { structuredOutput: true, reasoningEffort: "none" as const, maxOutputTokens: 4_096 } },
};
export type MinimalPolicyTrialCallFactory = (configs: typeof MINIMAL_POLICY_TRIAL_CONFIGS) => MinimalPolicyTrialCalls;

const CASES = 60, TASKS = 120, CALLS_PER_TASK = 2, LOGICAL_MODEL_INVOCATIONS = TASKS * CALLS_PER_TASK;

export const canonicalMinimalPolicyJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonicalMinimalPolicyJson).join(",")}]`
  : value && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalMinimalPolicyJson(item)}`).join(",")}}`
  : JSON.stringify(value) ?? "null";

const fail = (prompt: string, error: unknown, started: number): Call => ({ text: null, error: safeError(error), attempts: 0, elapsed_ms: Date.now() - started, model: "unknown_after_thrown_call", usage: { attempts_known: false, usage_known: false }, prompt_sha256: sha256(prompt) });
const paths = (out: string) => ({ out, jsonl: `${out}.jsonl`, progress: `${out}.progress.json`, calls: `${out}.calls.jsonl` });
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const parseFile = <T>(value: T | string): { value: T; raw_sha256: string | null } =>
  typeof value === "string" ? { value: JSON.parse(readFileSync(value, "utf8")) as T, raw_sha256: sha256(readFileSync(value)) } : { value, raw_sha256: null };
const taskPlan = (input: ContextReplayInput) => input.cases.flatMap((item) => {
  const arms: MinimalPolicyTrialArm[] = item.index % 2 ? ["comparison", "control"] : ["control", "comparison"];
  return arms.map((arm, offset) => ({ task_index: item.index * 2 + offset, arm, case: item }));
});

function validate(input: ContextReplayInput, selection: MinimalPolicyTrialSelection, inputHash: string | null) {
  if (!Array.isArray(input.cases) || input.cases.length !== CASES || input.selected_question_ids?.length !== CASES) throw new Error(`Expected exactly ${CASES} input cases`);
  const ids = input.cases.map((item) => item.question_id);
  if (new Set(ids).size !== CASES || ids.some((id, index) => id !== input.selected_question_ids[index] || input.cases[index]!.index !== index)) throw new Error("Input identity/order mismatch");
  const categories = new Map<string, number>();
  for (const item of input.cases) {
    categories.set(item.question_type, (categories.get(item.question_type) ?? 0) + 1);
    const context = item.sides.recall;
    if (item.is_abstention || !context || context.context_utf16_chars !== context.context.length || context.context_utf16_chars > CONTEXT_REPLAY_CAP || context.context_sha256 !== sha256(context.context)) throw new Error("Invalid Recall-only source context");
    if (item.generation.question !== item.judge_case.question || item.question_id !== item.judge_case.question_id) throw new Error("Question metadata mismatch");
    answerPrompt(item.generation, context.context); judgePrompt(item.judge_case, "candidate");
  }
  if (categories.size !== 6 || [...categories.values()].some((count) => count !== 10)) throw new Error("Expected six categories of ten");
  if (!Array.isArray(selection.development_ids) || selection.development_ids.length !== CASES || selection.development_ids.some((id, index) => id !== ids[index])) throw new Error("Selection development identity mismatch");
  if (!Array.isArray(selection.selected_review_ids) || selection.selected_review_ids.length !== 17 || new Set(selection.selected_review_ids).size !== 17 || selection.selected_review_ids.some((id) => !ids.includes(id))) throw new Error("Invalid selection review cohort");
  if (selection.input_sha256 !== (inputHash ?? sha256(canonicalMinimalPolicyJson(input)))) throw new Error("Selection input hash mismatch");
}

type UsageMetric = "input" | "output" | "reasoning" | "cached" | "total";
const usageMetrics = ["input", "output", "reasoning", "cached", "total"] as const satisfies readonly UsageMetric[];

function usageValue(call: Call, metric: UsageMetric): { value: number | null; invalid: boolean } {
  const usage = call.usage, key = `${metric}_tokens`;
  if (!usage || usage.usage_known === false) return { value: null, invalid: false };
  const nested = metric === "reasoning" ? "output_tokens_details" : metric === "cached" ? "input_tokens_details" : null;
  if (nested && Object.hasOwn(usage, nested)) {
    const details = usage[nested];
    if (!details || typeof details !== "object" || Array.isArray(details)) return { value: null, invalid: true };
    if (Object.hasOwn(details, key)) {
      const value = (details as Record<string, unknown>)[key];
      return typeof value === "number" && Number.isInteger(value) && value >= 0 ? { value, invalid: false } : { value: null, invalid: true };
    }
  }
  if (!Object.hasOwn(usage, key)) return { value: null, invalid: false };
  const value = usage[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? { value, invalid: false } : { value: null, invalid: true };
}

const usageOf = (calls: Call[]) => calls.reduce((value, call) => {
  const input = usageValue(call, "input"), output = usageValue(call, "output"), reasoning = usageValue(call, "reasoning");
  const cached = usageValue(call, "cached"), total = usageValue(call, "total");
  const metrics = { input, output, reasoning, cached, total };
  const attemptsKnown = call.usage?.attempts_known !== false && Number.isInteger(call.attempts) && call.attempts >= 0;
  const complete = input.value !== null && output.value !== null && total.value !== null;
  const consistent = input.value !== null && output.value !== null && total.value !== null
    && input.value + output.value === total.value;
  for (const metric of usageMetrics) {
    const entry = metrics[metric], observed = `observed_${metric}_tokens` as const;
    const missing = `calls_with_missing_${metric}_tokens` as const, invalid = `calls_with_invalid_${metric}_tokens` as const;
    value[observed] += entry.value ?? 0; value[missing] += Number(entry.value === null); value[invalid] += Number(entry.invalid);
  }
  value.calls++;
  value.elapsed_ms += call.elapsed_ms;
  value.calls_with_errors += Number(call.error !== null);
  value.observed_attempts += attemptsKnown ? call.attempts : 0;
  value.calls_with_unknown_attempts += Number(!attemptsKnown);
  value.calls_with_retries += Number(attemptsKnown && call.attempts > 1);
  value.observed_retries += attemptsKnown ? Math.max(0, call.attempts - 1) : 0;
  value.calls_with_unknown_usage += Number(usageMetrics.some((metric) => metrics[metric].value === null));
  value.calls_with_inconsistent_input_output_total += Number(complete && !consistent);
  value.comparable_calls += Number(call.error === null && attemptsKnown && consistent);
  return value;
}, {
  calls: 0, calls_with_errors: 0, elapsed_ms: 0, observed_attempts: 0, calls_with_unknown_attempts: 0,
  calls_with_retries: 0, observed_retries: 0, calls_with_unknown_usage: 0,
  calls_with_inconsistent_input_output_total: 0, comparable_calls: 0,
  observed_input_tokens: 0, calls_with_missing_input_tokens: 0, calls_with_invalid_input_tokens: 0,
  observed_output_tokens: 0, calls_with_missing_output_tokens: 0, calls_with_invalid_output_tokens: 0,
  observed_reasoning_tokens: 0, calls_with_missing_reasoning_tokens: 0, calls_with_invalid_reasoning_tokens: 0,
  observed_cached_tokens: 0, calls_with_missing_cached_tokens: 0, calls_with_invalid_cached_tokens: 0,
  observed_total_tokens: 0, calls_with_missing_total_tokens: 0, calls_with_invalid_total_tokens: 0,
});

function resources(rows: MinimalPolicyTrialRow[]) {
  const stages = ["answer_call", "judge_call"] as const;
  return Object.fromEntries((["control", "comparison"] as MinimalPolicyTrialArm[]).map((arm) => [arm, Object.fromEntries(stages.map((stage) => [stage, usageOf(rows.filter((row) => row.arm === arm).map((row) => row[stage]).filter((call): call is Call => call !== null))]))]));
}

function summary(rows: MinimalPolicyTrialRow[], input: ContextReplayInput) {
  const group = (arm: MinimalPolicyTrialArm, type?: string) => {
    const planned = type ? input.cases.filter((item) => item.question_type === type).length : CASES;
    const items = rows.filter((row) => row.arm === arm && (!type || row.question_type === type));
    const scored = items.filter((row) => typeof row.correct === "boolean"), correct = items.filter((row) => row.correct).length;
    const answers = items.map((row) => row.answer).filter((value): value is string => typeof value === "string").map((value) => value.length);
    return { planned, recorded: items.length, scored: scored.length, correct, accuracy: scored.length ? correct / planned : null, errors: items.filter((row) => row.error).length,
      output_answer_utf16_chars: { answers: answers.length, total: answers.reduce((total, size) => total + size, 0), mean: answers.length ? answers.reduce((total, size) => total + size, 0) / answers.length : null, max: answers.length ? Math.max(...answers) : null, min: answers.length ? Math.min(...answers) : null } };
  };
  const by_arm = { control: group("control"), comparison: group("comparison") };
  const categories = Object.fromEntries([...new Set(input.cases.map((item) => item.question_type))].map((type) => [type, { control: group("control", type), comparison: group("comparison", type) }]));
  let gain = 0, loss = 0, paired = 0;
  for (const item of input.cases) {
    const control = rows.find((row) => row.case_index === item.index && row.arm === "control"), comparison = rows.find((row) => row.case_index === item.index && row.arm === "comparison");
    if (typeof control?.correct === "boolean" && typeof comparison?.correct === "boolean") { paired++; if (!control.correct && comparison.correct) gain++; if (control.correct && !comparison.correct) loss++; }
  }
  return { planned_tasks: TASKS, planned_logical_model_invocations: LOGICAL_MODEL_INVOCATIONS, recorded_tasks: rows.length, by_arm, categories,
    abstention: { planned: 0, control: { planned: 0, accuracy: null }, comparison: { planned: 0, accuracy: null } },
    paired_fresh_verdicts: { paired, comparison_gain: gain, comparison_loss: loss },
    errors_by_kind: Object.fromEntries([...new Set(rows.flatMap((row) => row.error ? [row.error] : []))].map((error) => [error, rows.filter((row) => row.error === error).length])),
    resources: resources(rows), resource_note: "Attempt, elapsed and token counts are descriptive. Unknown or invalid usage is not treated as zero; only error-free calls with known attempts and consistent input plus output equals total usage are comparable. The runner computes no resource verdict." };
}

function reserve(out: string, report: unknown, status: "prepared" | "partial") {
  const result = paths(out), collision = Object.values(result).find(existsSync);
  if (collision) throw new Error(`Output already exists: ${collision}`);
  writeFileSync(result.out, `${JSON.stringify(report)}\n`, { flag: "wx" }); writeFileSync(result.jsonl, "", { flag: "wx" }); writeFileSync(result.calls, "", { flag: "wx" }); writeFileSync(result.progress, `${JSON.stringify({ status, completed_tasks: 0, elapsed_ms: 0 })}\n`, { flag: "wx" });
  return result;
}

type Latch = { error: unknown | null };
type Journal = (task: ReturnType<typeof taskPlan>[number], stage: "answer" | "judge", prompt: string, call: Call) => void;
async function execute(task: ReturnType<typeof taskPlan>[number], calls: MinimalPolicyTrialCalls | undefined, live: boolean, journal: Journal, latch: Latch): Promise<MinimalPolicyTrialRow> {
  const { case: item, arm } = task, context = item.sides.recall, prompt = answerPrompt(item.generation, context.context);
  const row: MinimalPolicyTrialRow = { task_index: task.task_index, case_index: item.index, question_id: item.question_id, arm, question_type: item.question_type, is_abstention: item.is_abstention,
    context_sha256: context.context_sha256, context_utf16_chars: context.context_utf16_chars, answer_prompt_sha256: sha256(prompt), base_prompt_sha256: sha256(prompt),
    answer_call: null, judge_call: null, answer: null, correct: null, error: null, judge_prompt_sha256: null };
  if (!live || !calls) return row;
  const ensureOpen = () => { if (latch.error) throw latch.error; };
  const guarded = async (model: ModelCall, kind: "answer" | "judge", value: string, meta?: { question?: string }) => {
    const started = Date.now();
    ensureOpen();
    try { return await model(kind, value, meta); } catch (error) { return fail(value, error, started); }
  };
  row.answer_call = await guarded(calls[arm], "answer", prompt, { question: item.generation.question });
  journal(task, "answer", prompt, row.answer_call);
  if (row.answer_call.error) { row.correct = false; row.error = `answer_${row.answer_call.error}`; return row; }
  row.answer = parseAnswer(row.answer_call.text);
  if (row.answer === null) { row.correct = false; row.error = "malformed_answer"; return row; }
  const judge = judgePrompt(item.judge_case, row.answer); row.judge_prompt_sha256 = sha256(judge);
  row.judge_call = await guarded(calls.judge, "judge", judge); journal(task, "judge", judge, row.judge_call);
  if (row.judge_call.error) { row.correct = false; row.error = `judge_${row.judge_call.error}`; return row; }
  const correct = parseJudge(row.judge_call.text);
  if (correct === null) { row.correct = false; row.error = "malformed_judge"; return row; }
  row.correct = correct; return row;
}

export async function runMinimalPolicyTrial(options: MinimalPolicyTrialOptions, injectedCalls?: MinimalPolicyTrialCalls, callFactory?: MinimalPolicyTrialCallFactory) {
  const concurrency = options.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error("Concurrency must be 1 through 3");
  const parsedInput = parseFile<ContextReplayInput>(options.input), parsedSelection = parseFile<MinimalPolicyTrialSelection>(options.selection);
  validate(parsedInput.value, parsedSelection.value, parsedInput.raw_sha256);
  const input = parsedInput.value, live = options.live === true, injected = injectedCalls !== undefined || callFactory !== undefined, started = Date.now();
  const hash = (raw: string | null, value: unknown) => raw ? { kind: "raw_bytes", sha256: raw } : { kind: "provided_object_canonical", sha256: sha256(canonicalMinimalPolicyJson(value)) };
  const report = {
    status: live ? "partial" : "prepared", comparison_valid: live && !injected, execution_mode: injected ? "injected" : live ? "native" : "prepared",
    started_at: new Date().toISOString(), finished_at: null as string | null, elapsed_ms: null as number | null, runtime: process.version,
    invocation: { concurrency, live }, input_sha256: hash(parsedInput.raw_sha256, input), selection_sha256: hash(parsedSelection.raw_sha256, parsedSelection.value),
    selected_question_ids: input.selected_question_ids, review_question_ids: parsedSelection.value.selected_review_ids,
    design: { arms: ["control", "comparison"], passes_per_arm: 1, tasks: TASKS, logical_model_invocations: LOGICAL_MODEL_INVOCATIONS, counterbalance: "arm order alternates by case index", context_side: "recall", fixed_denominator_per_arm: CASES },
    configs: MINIMAL_POLICY_TRIAL_CONFIGS,
    instruction_hashes: { history: sha256(HISTORY_EVIDENCE_POLICY), minimal: sha256(MINIMAL_ANSWER_POLICY), combined: sha256(`${HISTORY_EVIDENCE_POLICY}\n\n${MINIMAL_ANSWER_POLICY}`), control: sha256(HISTORY_EVIDENCE_POLICY), comparison: sha256(`${HISTORY_EVIDENCE_POLICY}\n\n${MINIMAL_ANSWER_POLICY}`) },
    code_hashes: Object.fromEntries([fileURLToPath(import.meta.url), source("./longmemeval-context-replay-input.ts"), source("./longmemeval-qa-support.ts"), source("./longmemeval-qa-transport.ts"), source("./longmemeval-answer-review.ts"), source("./longmemeval-inference-policy.ts"), source("./longmemeval-minimal-answer-policy.ts"), source("../src/history/evidence-policy.ts")].map((path) => [path, sha256(readFileSync(path))])),
    settings: { provider: "qwen-local", model: "qwen3.8-flash-next", structured_output: true, answer_reasoning: "adaptive", answer_max_output_tokens: 16384, judge_reasoning: "none", judge_max_output_tokens: 4096, temperature: 0, context_cap_utf16: CONTEXT_REPLAY_CAP, max_concurrency: 3 },
    generation_blinding: input.generation_blinding,
    limitations: [
      "Development-only paired answer-policy experiment; not an acceptance gate or normal Recall default.",
      "Both arms send the byte-identical original answer prompt with only the saved Recall context; Hindsight saved context is not used.",
      "The judge receives no answer policy, so it cannot prefer either instruction set.",
      "Failures score false against the fixed 60-case denominator; there is no repair, rejudge, survivor fallback or selective retry.",
      "Stage costs are descriptive and never create a resource verdict.",
    ],
    results: [] as MinimalPolicyTrialRow[], summary: summary([], input),
  };
  const output = reserve(options.out, report, live ? "partial" : "prepared");
  let calls: MinimalPolicyTrialCalls | undefined;
  if (live) try {
    calls = injectedCalls ?? (callFactory ?? ((configs) => Object.fromEntries(Object.entries(configs).map(([key, value]) => [key, createModelCall(value.provider, value.fetcher, value.options)])) as MinimalPolicyTrialCalls))(MINIMAL_POLICY_TRIAL_CONFIGS);
  } catch (error) {
    report.status = "partial"; report.finished_at = new Date().toISOString(); report.elapsed_ms = Date.now() - started; (report as { setup_error?: string }).setup_error = safeError(error);
    writeFileSync(output.out, `${JSON.stringify(report)}\n`); writeFileSync(output.progress, `${JSON.stringify({ status: "partial", completed_tasks: 0, elapsed_ms: report.elapsed_ms, setup_error: safeError(error) })}\n`);
    return report;
  }
  const tasks = taskPlan(input), rows: Array<MinimalPolicyTrialRow | undefined> = new Array(TASKS), latch: Latch = { error: null }; let next = 0;
  const persist = (write: () => void) => { try { write(); } catch (error) { latch.error ??= error; throw error; } };
  const journal: Journal = (task, stage, prompt, call) => {
    persist(() => appendFileSync(output.calls, `${JSON.stringify({ task_index: task.task_index, case_index: task.case.index, question_id: task.case.question_id, arm: task.arm, stage, kind: stage, prompt_sha256: sha256(prompt), call })}\n`));
    if (latch.error) throw latch.error;
  };
  const progress = (recorded: MinimalPolicyTrialRow[]) => persist(() => writeFileSync(output.progress, `${JSON.stringify({ status: live ? "partial" : "prepared", completed_tasks: recorded.length, elapsed_ms: Date.now() - started, summary: summary(recorded, input) })}\n`));
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    for (;;) {
      if (latch.error) throw latch.error;
      const claimed = next++; if (claimed >= tasks.length) return;
      try {
        const row = await execute(tasks[claimed]!, calls, live, journal, latch);
        rows[row.task_index] = row;
        persist(() => appendFileSync(output.jsonl, `${JSON.stringify(row)}\n`));
        progress(rows.filter((value): value is MinimalPolicyTrialRow => value !== undefined));
      } catch (error) { latch.error ??= error; throw error; }
    }
  });
  const finalize = (results: MinimalPolicyTrialRow[], status: "prepared" | "partial" | "complete") => {
    report.results = results; report.summary = summary(results, input); report.status = status;
    report.finished_at = new Date().toISOString(); report.elapsed_ms = Date.now() - started;
    persist(() => writeFileSync(output.out, `${JSON.stringify(report)}\n`));
    persist(() => writeFileSync(output.progress, `${JSON.stringify({ status, completed_tasks: results.length, elapsed_ms: report.elapsed_ms, summary: report.summary })}\n`));
    return report;
  };
  const settled = await Promise.allSettled(workers), results = rows.filter((value): value is MinimalPolicyTrialRow => value !== undefined);
  const rejected = settled.find((value) => value.status === "rejected");
  if (latch.error || rejected) {
    finalize(results, "partial");
    throw latch.error ?? (rejected as PromiseRejectedResult).reason;
  }
  return finalize(results, live && results.length === TASKS ? "complete" : "prepared");
}

export function parseMinimalPolicyTrialArgs(args: string[]): MinimalPolicyTrialOptions {
  const result: Partial<MinimalPolicyTrialOptions> = { concurrency: 3, live: false };
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (key === "--live") { result.live = true; continue; }
    const value = args[++index]; if (!value) throw new Error("Unknown or missing argument");
    if (key === "--input") result.input = value; else if (key === "--selection") result.selection = value; else if (key === "--out") result.out = value;
    else if (key === "--concurrency") result.concurrency = Number(value); else throw new Error("Unknown or missing argument");
  }
  if (!result.input || !result.selection || !result.out) throw new Error("--input, --selection and --out are required");
  return result as MinimalPolicyTrialOptions;
}
function main() { try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } }
if (main()) runMinimalPolicyTrial(parseMinimalPolicyTrialArgs(process.argv.slice(2))).then((report) => { if (report.invocation.live && report.status !== "complete") process.exitCode = 1; }).catch(() => { process.exitCode = 1; });

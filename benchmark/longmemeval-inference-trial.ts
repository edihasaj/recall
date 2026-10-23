/** Fresh paired inference trial over the frozen Recall-only saved contexts. */
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMPARISON_INSTRUCTIONS, generateComparedAnswer, type DraftOrder } from "./longmemeval-answer-comparison.js";
import { CONTEXT_REPLAY_CAP, type ContextReplayInput, type ReplayCase } from "./longmemeval-context-replay-input.js";
import { answerPrompt, createModelCall, judgePrompt, parseAnswer, parseJudge, safeError, sha256, type Call, type ModelCall } from "./longmemeval-qa-support.js";
import { longRequestFetch } from "./longmemeval-qa-transport.js";
import { HISTORY_EVIDENCE_POLICY } from "../src/history/evidence-policy.js";

type Arm = "control" | "comparison";
type Selection = { development_ids: string[]; selected_review_ids: string[]; input_sha256: string; mask_seed: number | string };
type Calls = { control: ModelCall; draftA: ModelCall; draftB: ModelCall; arbiter: ModelCall; judge: ModelCall };
export type TrialRow = {
  task_index: number; case_index: number; question_id: string; arm: Arm; question_type: string; is_abstention: boolean;
  context_sha256: string; context_utf16_chars: number; base_prompt_sha256: string; presentation_order: DraftOrder | null;
  control_call: Call | null; draft_a_call: Call | null; draft_b_call: Call | null; arbitration_call: Call | null; judge_call: Call | null;
  draft_a_answer: string | null; draft_b_answer: string | null; draft_errors: { a: string | null; b: string | null } | null; arbitration_prompt_sha256: string | null; derived_draft_chars: number;
  answer: string | null; correct: boolean | null; error: string | null; judge_prompt_sha256: string | null;
};
export type TrialOptions = { input: ContextReplayInput | string; selection: Selection | string; out: string; concurrency?: number; live?: boolean };
export const INFERENCE_TRIAL_CONFIGS = {
  control: { provider: "qwen-local" as const, fetcher: longRequestFetch, options: { structuredOutput: true, reasoningEffort: "adaptive" as const, maxOutputTokens: 16_384, answerInstructions: HISTORY_EVIDENCE_POLICY } },
  draftA: { provider: "qwen-local" as const, fetcher: longRequestFetch, options: { structuredOutput: true, reasoningEffort: "low" as const, maxOutputTokens: 8_192, answerInstructions: HISTORY_EVIDENCE_POLICY } },
  draftB: { provider: "qwen-local" as const, fetcher: longRequestFetch, options: { structuredOutput: true, reasoningEffort: "adaptive" as const, maxOutputTokens: 16_384, answerInstructions: HISTORY_EVIDENCE_POLICY } },
  arbiter: { provider: "qwen-local" as const, fetcher: longRequestFetch, options: { structuredOutput: true, reasoningEffort: "adaptive" as const, maxOutputTokens: 16_384, answerInstructions: `${HISTORY_EVIDENCE_POLICY}\n\n${COMPARISON_INSTRUCTIONS}` } },
  judge: { provider: "qwen-local" as const, fetcher: longRequestFetch, options: { structuredOutput: true, reasoningEffort: "none" as const, maxOutputTokens: 4_096 } },
};
export type TrialCallFactory = (configs: typeof INFERENCE_TRIAL_CONFIGS) => Calls;

export const canonicalInferenceJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonicalInferenceJson).join(",")}]`
  : value && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalInferenceJson(item)}`).join(",")}}`
  : JSON.stringify(value) ?? "null";
const fail = (prompt: string, error: unknown, started: number): Call => ({ text: null, error: safeError(error), attempts: 0, elapsed_ms: Date.now() - started, model: "unknown_after_thrown_call", usage: { attempts_known: false, usage_known: false }, prompt_sha256: sha256(prompt) });
const paths = (out: string) => ({ out, jsonl: `${out}.jsonl`, progress: `${out}.progress.json`, calls: `${out}.calls.jsonl` });
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const parseFile = <T>(value: T | string): { value: T; raw_sha256: string | null } =>
  typeof value === "string" ? { value: JSON.parse(readFileSync(value, "utf8")) as T, raw_sha256: sha256(readFileSync(value)) } : { value, raw_sha256: null };
const taskPlan = (input: ContextReplayInput) => input.cases.flatMap((item) => {
  const arms: Arm[] = item.index % 2 ? ["comparison", "control"] : ["control", "comparison"];
  return arms.map((arm, offset) => ({ task_index: item.index * 2 + offset, case: item, arm }));
});

function validate(input: ContextReplayInput, selection: Selection, inputHash: string | null) {
  if (!Array.isArray(input.cases) || input.cases.length !== 60 || input.selected_question_ids?.length !== 60) throw new Error("Expected exactly 60 input cases");
  const ids = input.cases.map((item) => item.question_id);
  if (new Set(ids).size !== 60 || ids.some((id, index) => id !== input.selected_question_ids[index] || input.cases[index]!.index !== index)) throw new Error("Input identity/order mismatch");
  const categories = new Map<string, number>();
  for (const item of input.cases) {
    categories.set(item.question_type, (categories.get(item.question_type) ?? 0) + 1);
    const context = item.sides.recall;
    if (item.is_abstention || !context || context.context_utf16_chars !== context.context.length || context.context_utf16_chars > CONTEXT_REPLAY_CAP || context.context_sha256 !== sha256(context.context)) throw new Error("Invalid Recall-only source context");
    if (item.generation.question !== item.judge_case.question || item.question_id !== item.judge_case.question_id) throw new Error("Question metadata mismatch");
    answerPrompt(item.generation, context.context); judgePrompt(item.judge_case, "candidate");
  }
  if (categories.size !== 6 || [...categories.values()].some((count) => count !== 10)) throw new Error("Expected six categories of ten");
  if (!Array.isArray(selection.development_ids) || selection.development_ids.length !== 60 || selection.development_ids.some((id, index) => id !== ids[index])) throw new Error("Selection development identity mismatch");
  if (!Array.isArray(selection.selected_review_ids) || selection.selected_review_ids.length !== 17 || new Set(selection.selected_review_ids).size !== 17 || selection.selected_review_ids.some((id) => !ids.includes(id))) throw new Error("Invalid grounding review selection");
  if (selection.input_sha256 !== (inputHash ?? sha256(canonicalInferenceJson(input)))) throw new Error("Selection input hash mismatch");
}
function resources(rows: TrialRow[]) {
  const stages = ["control_call", "draft_a_call", "draft_b_call", "arbitration_call", "judge_call"] as const;
  const usage = (calls: Call[]) => calls.reduce((value, call) => {
    const tokens = typeof call.usage?.total_tokens === "number" ? call.usage.total_tokens : null;
    return { calls: value.calls + 1, observed_attempts: value.observed_attempts + call.attempts, calls_with_unknown_attempts: value.calls_with_unknown_attempts + Number(call.usage?.attempts_known === false), elapsed_ms: value.elapsed_ms + call.elapsed_ms, unknown_usage: value.unknown_usage + Number(tokens === null), observed_total_tokens: value.observed_total_tokens + (tokens ?? 0) };
  }, { calls: 0, observed_attempts: 0, calls_with_unknown_attempts: 0, elapsed_ms: 0, unknown_usage: 0, observed_total_tokens: 0 });
  return Object.fromEntries((["control", "comparison"] as Arm[]).map((arm) => [arm, Object.fromEntries(stages.map((stage) => [stage, usage(rows.filter((row) => row.arm === arm).map((row) => row[stage]).filter((call): call is Call => call !== null))]))]));
}
function summary(rows: TrialRow[], input: ContextReplayInput) {
  const group = (arm: Arm, type?: string) => {
    const planned = type ? input.cases.filter((item) => item.question_type === type).length : 60;
    const items = rows.filter((row) => row.arm === arm && (!type || row.question_type === type)), scored = items.filter((row) => typeof row.correct === "boolean");
    const correct = items.filter((row) => row.correct).length;
    return { planned, recorded: items.length, scored: scored.length, correct, accuracy: scored.length ? correct / planned : null, errors: items.filter((row) => row.error).length };
  };
  const by_arm = { control: group("control"), comparison: group("comparison") };
  const categories = Object.fromEntries([...new Set(input.cases.map((item) => item.question_type))].map((type) => [type, { control: group("control", type), comparison: group("comparison", type) }]));
  let gain = 0, loss = 0, paired = 0;
  for (const item of input.cases) {
    const control = rows.find((row) => row.case_index === item.index && row.arm === "control"), comparison = rows.find((row) => row.case_index === item.index && row.arm === "comparison");
    if (typeof control?.correct === "boolean" && typeof comparison?.correct === "boolean") { paired++; if (!control.correct && comparison.correct) gain++; if (control.correct && !comparison.correct) loss++; }
  }
  return { planned_tasks: 120, recorded_tasks: rows.length, by_arm, categories, abstention: { planned: 0, control: { planned: 0, accuracy: null }, comparison: { planned: 0, accuracy: null } }, paired_fresh_verdicts: { paired, comparison_gain: gain, comparison_loss: loss }, errors_by_kind: Object.fromEntries([...new Set(rows.flatMap((row) => row.error ? [row.error] : []))].map((error) => [error, rows.filter((row) => row.error === error).length])), resources: resources(rows) };
}
function reserve(out: string, report: unknown, status: "prepared" | "partial") {
  const result = paths(out), collision = Object.values(result).find(existsSync);
  if (collision) throw new Error(`Output already exists: ${collision}`);
  writeFileSync(result.out, `${JSON.stringify(report)}\n`, { flag: "wx" }); writeFileSync(result.jsonl, "", { flag: "wx" }); writeFileSync(result.calls, "", { flag: "wx" }); writeFileSync(result.progress, `${JSON.stringify({ status, completed_tasks: 0, elapsed_ms: 0 })}\n`, { flag: "wx" });
  return result;
}
async function invoke(call: ModelCall, kind: "answer" | "judge", prompt: string, question?: string) {
  const started = Date.now();
  try { return await call(kind, prompt, question ? { question } : undefined); } catch (error) { return fail(prompt, error, started); }
}
type Journal = (task: ReturnType<typeof taskPlan>[number], stage: string, kind: "answer" | "judge", prompt: string, call: Call) => void;
type Latch = { error: unknown | null };
async function execute(task: ReturnType<typeof taskPlan>[number], calls: Calls | undefined, live: boolean, journal: Journal, latch: Latch): Promise<TrialRow> {
  const { case: item, arm } = task, context = item.sides.recall, prompt = answerPrompt(item.generation, context.context);
  const row: TrialRow = { task_index: task.task_index, case_index: item.index, question_id: item.question_id, arm, question_type: item.question_type, is_abstention: item.is_abstention, context_sha256: context.context_sha256, context_utf16_chars: context.context_utf16_chars, base_prompt_sha256: sha256(prompt), presentation_order: arm === "comparison" ? item.index % 2 ? "b_a" : "a_b" : null, control_call: null, draft_a_call: null, draft_b_call: null, arbitration_call: null, judge_call: null, draft_a_answer: null, draft_b_answer: null, draft_errors: null, arbitration_prompt_sha256: null, derived_draft_chars: 0, answer: null, correct: null, error: null, judge_prompt_sha256: null };
  if (!live || !calls) return row;
  const ensureOpen = () => { if (latch.error) throw latch.error; };
  const guarded = Object.fromEntries(Object.entries(calls).map(([name, call]) => [name, async (kind: "answer" | "judge", value: string, meta?: { question?: string }) => {
    ensureOpen(); return call(kind, value, meta);
  }])) as Calls;
  if (arm === "control") {
    ensureOpen(); row.control_call = await invoke(guarded.control, "answer", prompt, item.generation.question); journal(task, "control", "answer", prompt, row.control_call);
    if (row.control_call.error) { row.correct = false; row.error = `control_${row.control_call.error}`; return row; }
    row.answer = parseAnswer(row.control_call.text);
    if (row.answer === null) { row.correct = false; row.error = "malformed_control"; return row; }
  } else {
    ensureOpen();
    const compared = await generateComparedAnswer({ originalPrompt: prompt, question: item.generation.question, order: row.presentation_order!, onCall: (stage, call, actualPrompt) => journal(task, stage, "answer", actualPrompt, call) }, { draftA: guarded.draftA, draftB: guarded.draftB, arbiter: guarded.arbiter });
    Object.assign(row, { draft_a_call: compared.draft_a_call, draft_b_call: compared.draft_b_call, arbitration_call: compared.arbitration_call, draft_a_answer: compared.draft_a_answer, draft_b_answer: compared.draft_b_answer, draft_errors: compared.draft_errors, arbitration_prompt_sha256: compared.arbitration_prompt_sha256, derived_draft_chars: compared.derived_draft_chars, answer: compared.answer, base_prompt_sha256: compared.base_prompt_sha256 });
    if (compared.error || row.answer === null) { row.correct = false; row.error = compared.error ?? "malformed_comparison"; return row; }
  }
  const judge = judgePrompt(item.judge_case, row.answer); row.judge_prompt_sha256 = sha256(judge);
  ensureOpen(); row.judge_call = await invoke(guarded.judge, "judge", judge); journal(task, "judge", "judge", judge, row.judge_call);
  if (row.judge_call.error) { row.correct = false; row.error = `judge_${row.judge_call.error}`; return row; }
  const correct = parseJudge(row.judge_call.text);
  if (correct === null) { row.correct = false; row.error = "malformed_judge"; return row; }
  row.correct = correct; return row;
}

export async function runInferenceTrial(options: TrialOptions, injectedCalls?: Calls, callFactory?: TrialCallFactory) {
  const concurrency = options.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error("Concurrency must be 1 through 3");
  const parsedInput = parseFile<ContextReplayInput>(options.input), parsedSelection = parseFile<Selection>(options.selection);
  validate(parsedInput.value, parsedSelection.value, parsedInput.raw_sha256);
  const input = parsedInput.value, live = options.live === true, injected = injectedCalls !== undefined || callFactory !== undefined, started = Date.now();
  const report = { status: live ? "partial" : "prepared", comparison_valid: live && !injected, execution_mode: injected ? "injected" : live ? "native" : "prepared", started_at: new Date().toISOString(), finished_at: null as string | null, elapsed_ms: null as number | null, runtime: process.version, invocation: { concurrency, live }, input_sha256: parsedInput.raw_sha256 ? { kind: "raw_bytes", sha256: parsedInput.raw_sha256 } : { kind: "provided_object_canonical", sha256: sha256(canonicalInferenceJson(input)) }, selection_sha256: parsedSelection.raw_sha256 ? { kind: "raw_bytes", sha256: parsedSelection.raw_sha256 } : { kind: "provided_object_canonical", sha256: sha256(canonicalInferenceJson(parsedSelection.value)) }, selected_question_ids: input.selected_question_ids, review_question_ids: parsedSelection.value.selected_review_ids, configs: INFERENCE_TRIAL_CONFIGS, instruction_hashes: { history: sha256(HISTORY_EVIDENCE_POLICY), comparison: sha256(COMPARISON_INSTRUCTIONS) }, code_hashes: Object.fromEntries([fileURLToPath(import.meta.url), source("./longmemeval-answer-comparison.ts"), source("./longmemeval-inference-grounding.ts"), source("./longmemeval-qa-support.ts"), source("./longmemeval-qa-transport.ts"), source("./longmemeval-answer-review.ts"), source("./longmemeval-inference-policy.ts"), source("../src/history/evidence-policy.ts")].map((path) => [path, sha256(readFileSync(path))])), limitations: ["Development-only paired inference experiment; not an acceptance gate or normal Recall default.", "Both arms use byte-identical saved Recall contexts; Hindsight saved context is not used.", "Stage costs are descriptive and do not create a cost adoption rule."], results: [] as TrialRow[], summary: summary([], input) };
  const output = reserve(options.out, report, live ? "partial" : "prepared");
  let calls: Calls | undefined;
  if (live) try { calls = injectedCalls ?? (callFactory ?? ((configs) => Object.fromEntries(Object.entries(configs).map(([key, value]) => [key, createModelCall(value.provider, value.fetcher, value.options)])) as Calls))(INFERENCE_TRIAL_CONFIGS); }
  catch (error) { report.status = "partial"; report.finished_at = new Date().toISOString(); report.elapsed_ms = Date.now() - started; (report as { setup_error?: string }).setup_error = safeError(error); writeFileSync(output.out, `${JSON.stringify(report)}\n`); writeFileSync(output.progress, `${JSON.stringify({ status: "partial", completed_tasks: 0, elapsed_ms: report.elapsed_ms, setup_error: safeError(error) })}\n`); return report; }
  const tasks = taskPlan(input), rows: Array<TrialRow | undefined> = new Array(120), latch: Latch = { error: null }; let next = 0;
  const journal: Journal = (task, stage, kind, prompt, call) => { appendFileSync(output.calls, `${JSON.stringify({ task_index: task.task_index, case_index: task.case.index, question_id: task.case.question_id, arm: task.arm, stage, kind, prompt_sha256: sha256(prompt), call })}\n`); if (latch.error) throw latch.error; };
  const workers = Array.from({ length: concurrency }, async () => { for (;;) { if (latch.error) throw latch.error; const nextTask = next++; if (nextTask >= tasks.length) return; try { const row = await execute(tasks[nextTask]!, calls, live, journal, latch); rows[row.task_index] = row; appendFileSync(output.jsonl, `${JSON.stringify(row)}\n`); const recorded = rows.filter((value): value is TrialRow => value !== undefined); writeFileSync(output.progress, `${JSON.stringify({ status: live ? "partial" : "prepared", completed_tasks: recorded.length, elapsed_ms: Date.now() - started, summary: summary(recorded, input) })}\n`); } catch (error) { latch.error ??= error; throw error; } } });
  const settled = await Promise.allSettled(workers);
  if (latch.error) { report.status = "partial"; report.results = rows.filter((value): value is TrialRow => value !== undefined); report.summary = summary(report.results, input); report.finished_at = new Date().toISOString(); report.elapsed_ms = Date.now() - started; writeFileSync(output.out, `${JSON.stringify(report)}\n`); writeFileSync(output.progress, `${JSON.stringify({ status: "partial", completed_tasks: report.results.length, elapsed_ms: report.elapsed_ms, summary: report.summary })}\n`); throw latch.error; }
  report.results = rows.filter((value): value is TrialRow => value !== undefined); report.summary = summary(report.results, input); report.status = live ? "complete" : "prepared"; report.finished_at = new Date().toISOString(); report.elapsed_ms = Date.now() - started;
  writeFileSync(output.out, `${JSON.stringify(report)}\n`); writeFileSync(output.progress, `${JSON.stringify({ status: report.status, completed_tasks: 120, elapsed_ms: report.elapsed_ms, summary: report.summary })}\n`); return report;
}
export function parseInferenceTrialArgs(args: string[]): TrialOptions {
  const result: Partial<TrialOptions> = { concurrency: 3, live: false };
  for (let index = 0; index < args.length; index++) { const key = args[index]!; if (key === "--live") { result.live = true; continue; } const value = args[++index]; if (!value) throw new Error("Unknown or missing argument"); if (key === "--input") result.input = value; else if (key === "--selection") result.selection = value; else if (key === "--out") result.out = value; else if (key === "--concurrency") result.concurrency = Number(value); else throw new Error("Unknown or missing argument"); }
  if (!result.input || !result.selection || !result.out) throw new Error("--input, --selection and --out are required"); return result as TrialOptions;
}
function main() { try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } }
if (main()) runInferenceTrial(parseInferenceTrialArgs(process.argv.slice(2))).then((report) => { if (report.invocation.live && report.status !== "complete") process.exitCode = 1; }).catch(() => { process.exitCode = 1; });

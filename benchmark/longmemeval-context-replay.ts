/** Saved-context LongMemEval diagnostic. Preparation is offline; live calls require --live. */
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { answerPrompt, createModelCall, judgePrompt, parseAnswer, parseJudge, safeError, sha256, type Call, type ModelCall } from "./longmemeval-qa-support.js";
import { longRequestFetch } from "./longmemeval-qa-transport.js";
import { CONTEXT_REPLAY_CAP, type ContextReplayInput, type ReplayCase, type ReplaySide } from "./longmemeval-context-replay-input.js";
import { HISTORY_EVIDENCE_POLICY } from "../src/history/evidence-policy.js";

export type ReplayTask = { task_index: number; case_index: number; question_id: string; side: ReplaySide["name"] };
export type ReplayRow = ReplayTask & {
  question_type: string; is_abstention: boolean; context_utf16_chars: number; context_sha256: string;
  answer_prompt_sha256: string; judge_prompt_sha256: string | null; answer_call: Call | null; judge_call: Call | null;
  answer: string | null; correct: boolean | null; error: string | null;
};
export type ReplayOptions = {
  input: ContextReplayInput | string; out: string; concurrency?: number; live?: boolean;
};
export const CONTEXT_REPLAY_MODEL_CONFIG = {
  provider: "qwen-local" as const, fetcher: longRequestFetch,
  options: { structuredOutput: true, reasoningEffort: "adaptive" as const, maxOutputTokens: 16_384, answerInstructions: HISTORY_EVIDENCE_POLICY },
};
export type CallFactory = (config: typeof CONTEXT_REPLAY_MODEL_CONFIG) => ModelCall;
type ReplayPlan = { by_type: Record<string, number>; abstention: number };

const failedCall = (prompt: string, error: unknown, elapsed_ms: number): Call => ({
  text: null, error: safeError(error), attempts: 0, elapsed_ms, model: "unknown_after_thrown_call",
  usage: { attempts_known: false, usage_known: false }, prompt_sha256: sha256(prompt),
});
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const readBundle = (input: ContextReplayInput | string) =>
  typeof input === "string" ? JSON.parse(readFileSync(input, "utf8")) as ContextReplayInput : input;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
  : JSON.stringify(value) ?? "null";
const planFor = (bundle: ContextReplayInput): ReplayPlan => ({
  by_type: Object.fromEntries([...new Set(bundle.cases.map((item) => item.question_type))]
    .map((type) => [type, bundle.cases.filter((item) => item.question_type === type).length])),
  abstention: bundle.cases.filter((item) => item.is_abstention).length,
});
const taskOrder = (input: ContextReplayInput): ReplayTask[] => input.cases.flatMap((item) => {
  const sides: ReplaySide["name"][] = item.index % 2 === 0 ? ["recall", "hindsight"] : ["hindsight", "recall"];
  return sides.map((side, offset) => ({ task_index: item.index * 2 + offset, case_index: item.index, question_id: item.question_id, side }));
});
const outputPaths = (out: string) => ({ out, jsonl: `${out}.jsonl`, progress: `${out}.progress.json` });

function reserve(out: string, report: unknown) {
  const paths = outputPaths(out);
  const collision = Object.values(paths).find(existsSync);
  if (collision) throw new Error(`Output already exists: ${collision}`);
  writeFileSync(paths.out, `${JSON.stringify(report)}\n`, { flag: "wx" });
  writeFileSync(paths.jsonl, "", { flag: "wx" });
  writeFileSync(paths.progress, `${JSON.stringify({ status: "prepared", completed_tasks: 0 })}\n`, { flag: "wx" });
  return paths;
}
function group(rows: ReplayRow[], side: ReplaySide["name"], planned: number, filter = (_row: ReplayRow) => true) {
  const items = rows.filter((row) => row.side === side && filter(row));
  const scored = items.filter((row) => typeof row.correct === "boolean");
  const correct = items.filter((row) => row.correct === true).length;
  return { planned, recorded: items.length, scored: scored.length, correct, accuracy: planned && scored.length ? correct / planned : null,
    errors: items.filter((row) => row.error !== null).length };
}
export function summarizeContextReplay(rows: ReplayRow[], plan: ReplayPlan = { by_type: {}, abstention: 0 }) {
  const by_side = { recall: group(rows, "recall", 60), hindsight: group(rows, "hindsight", 60) };
  const categories = Object.fromEntries(Object.entries(plan.by_type).map(([type, planned]) => [type, {
    recall: group(rows, "recall", planned, (row) => row.question_type === type),
    hindsight: group(rows, "hindsight", planned, (row) => row.question_type === type),
  }]));
  const abstention = {
    recall: group(rows, "recall", plan.abstention, (row) => row.is_abstention),
    hindsight: group(rows, "hindsight", plan.abstention, (row) => row.is_abstention),
  };
  const pairs = new Map<number, ReplayRow[]>();
  for (const row of rows) pairs.set(row.case_index, [...(pairs.get(row.case_index) ?? []), row]);
  let hindsight_gain = 0, hindsight_loss = 0, paired_scored = 0;
  for (const pair of pairs.values()) {
    const recall = pair.find((row) => row.side === "recall"), hindsight = pair.find((row) => row.side === "hindsight");
    if (typeof recall?.correct === "boolean" && typeof hindsight?.correct === "boolean") {
      paired_scored++;
      if (!recall.correct && hindsight.correct) hindsight_gain++;
      if (recall.correct && !hindsight.correct) hindsight_loss++;
    }
  }
  return { planned_tasks: 120, recorded_tasks: rows.length, by_side, categories, abstention,
    errors_by_kind: Object.fromEntries([...new Set(rows.flatMap((row) => row.error ? [row.error] : []))]
      .map((error) => [error, rows.filter((row) => row.error === error).length])),
    paired_fresh_verdicts: { paired_scored, hindsight_gain, hindsight_loss } };
}
function validate(bundle: ContextReplayInput) {
  if (!Array.isArray(bundle.cases) || bundle.cases.length !== 60 || bundle.selected_question_ids?.length !== 60) throw new Error("Replay bundle must contain exactly 60 cases");
  if (new Set(bundle.selected_question_ids).size !== 60 || bundle.cases.some((item, index) => item.question_id !== bundle.selected_question_ids[index] || item.index !== index)) throw new Error("Replay bundle identity/order mismatch");
  for (const item of bundle.cases) for (const side of ["recall", "hindsight"] as const) {
    const context = item.sides[side];
    if (!context || context.context_utf16_chars !== context.context.length || context.context_utf16_chars > CONTEXT_REPLAY_CAP || context.context_sha256 !== sha256(context.context)) throw new Error("Replay bundle context integrity mismatch");
  }
  for (const item of bundle.cases) {
    if (item.generation.question !== item.judge_case.question || item.question_id !== item.judge_case.question_id) throw new Error("Replay generation/judge question mismatch");
    answerPrompt(item.generation, item.sides.recall.context);
    answerPrompt(item.generation, item.sides.hindsight.context);
    judgePrompt(item.judge_case, "candidate");
  }
}
function baseReport(bundle: ContextReplayInput, options: Required<Pick<ReplayOptions, "concurrency" | "live">>, inputBytesHash: string | null) {
  const files = [fileURLToPath(import.meta.url), source("./longmemeval-context-replay-input.ts"), source("./longmemeval-qa-support.ts"), source("./longmemeval-qa-transport.ts"), source("../src/history/evidence-policy.ts")];
  return {
    status: "prepared", comparison_valid: true, started_at: new Date().toISOString(), finished_at: null as string | null, elapsed_ms: null as number | null,
    runtime: process.version, invocation: { ...options, live: options.live },
    selected_question_ids: bundle.selected_question_ids, source_canonical_sha256: bundle.source_canonical_sha256,
    input_sha256: inputBytesHash, canonical_bundle_sha256: sha256(canonical(bundle)),
    code_hashes: Object.fromEntries(files.map((path) => [path, sha256(readFileSync(path))])),
    settings: { provider: "qwen-local", model: "qwen3.8-flash-next", structured_output: true, answer_reasoning: "adaptive", answer_max_output_tokens: 16384, judge_reasoning: "none", judge_max_output_tokens: 4096, temperature: 0, context_cap_utf16: CONTEXT_REPLAY_CAP },
    generation_blinding: bundle.generation_blinding,
    limitations: [
      "This is a joint saved-context representation-and-quantity diagnostic, not a fresh Hindsight retrieval or raw-prompt reproduction.",
      "Sanitization cannot undo original-ID effects during upstream retrieval or retention.",
      "Questions are repeatedly inspected public development data and contain no abstentions.",
      "This diagnostic has no acceptance-gate advancement role.",
    ],
    results: [] as ReplayRow[], summary: summarizeContextReplay([], planFor(bundle)),
  };
}
async function execute(task: ReplayTask, item: ReplayCase, call: ModelCall | undefined, live: boolean): Promise<ReplayRow> {
  const side = item.sides[task.side], answerPromptText = answerPrompt(item.generation, side.context);
  const row: ReplayRow = {
    ...task, question_type: item.question_type, is_abstention: item.is_abstention, context_utf16_chars: side.context_utf16_chars,
    context_sha256: side.context_sha256, answer_prompt_sha256: sha256(answerPromptText), judge_prompt_sha256: null,
    answer_call: null, judge_call: null, answer: null, correct: null, error: null,
  };
  if (!live || !call) return row;
  const answerStarted = Date.now();
  try { row.answer_call = await call("answer", answerPromptText, { question: item.generation.question }); }
  catch (error) { row.answer_call = failedCall(answerPromptText, error, Date.now() - answerStarted); }
  if (row.answer_call.error) { row.correct = false; row.error = `answer_${row.answer_call.error}`; return row; }
  row.answer = parseAnswer(row.answer_call.text);
  if (row.answer === null) { row.correct = false; row.error = "malformed_answer"; return row; }
  const judgePromptText = judgePrompt(item.judge_case, row.answer);
  row.judge_prompt_sha256 = sha256(judgePromptText);
  const judgeStarted = Date.now();
  try { row.judge_call = await call("judge", judgePromptText); }
  catch (error) { row.judge_call = failedCall(judgePromptText, error, Date.now() - judgeStarted); }
  if (row.judge_call.error) { row.correct = false; row.error = `judge_${row.judge_call.error}`; return row; }
  const verdict = parseJudge(row.judge_call.text);
  if (verdict === null) { row.correct = false; row.error = "malformed_judge"; return row; }
  row.correct = verdict;
  return row;
}

export async function runContextReplay(options: ReplayOptions, injectedCall?: ModelCall, callFactory?: CallFactory) {
  const concurrency = options.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error("Concurrency must be an integer from 1 through 3");
  const bundle = readBundle(options.input); validate(bundle);
  const live = options.live === true;
  const plan = planFor(bundle);
  const inputBytesHash = typeof options.input === "string" ? sha256(readFileSync(options.input)) : null;
  const started = Date.now();
  const report = baseReport(bundle, { concurrency, live }, inputBytesHash);
  const paths = reserve(options.out, report);
  let call: ModelCall | undefined;
  if (live) {
    try {
      call = injectedCall ?? (callFactory ?? ((config) => createModelCall(config.provider, config.fetcher, config.options)))(CONTEXT_REPLAY_MODEL_CONFIG);
    } catch (error) {
      report.status = "partial"; (report as { setup_error?: string }).setup_error = safeError(error);
      report.finished_at = new Date().toISOString(); report.elapsed_ms = Date.now() - started;
      writeFileSync(paths.out, `${JSON.stringify(report)}\n`);
      writeFileSync(paths.progress, `${JSON.stringify({ status: "partial", setup_error: safeError(error), completed_tasks: 0, elapsed_ms: report.elapsed_ms })}\n`);
      return report;
    }
  }
  const tasks = taskOrder(bundle), rows: (ReplayRow | undefined)[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    for (;;) {
      const current = next++;
      if (current >= tasks.length) return;
      const task = tasks[current]!, row = await execute(task, bundle.cases[task.case_index]!, call, live);
      rows[task.task_index] = row;
      appendFileSync(paths.jsonl, `${JSON.stringify(row)}\n`);
      const recorded = rows.filter((value): value is ReplayRow => value !== undefined);
      writeFileSync(paths.progress, `${JSON.stringify({ status: live ? "partial" : "prepared", completed_tasks: recorded.length, elapsed_ms: Date.now() - started, summary: summarizeContextReplay(recorded, plan) })}\n`);
    }
  }));
  report.results = rows.filter((value): value is ReplayRow => value !== undefined);
  report.summary = summarizeContextReplay(report.results, plan);
  report.status = live ? "complete" : "prepared";
  report.finished_at = new Date().toISOString(); report.elapsed_ms = Date.now() - started;
  writeFileSync(paths.out, `${JSON.stringify(report)}\n`);
  writeFileSync(paths.progress, `${JSON.stringify({ status: report.status, completed_tasks: report.results.length, elapsed_ms: report.elapsed_ms, summary: report.summary })}\n`);
  return report;
}

export function parseContextReplayArgs(args: string[]): ReplayOptions {
  const options: Partial<ReplayOptions> = { concurrency: 3, live: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--live") { options.live = true; continue; }
    const value = args[++index];
    if (!value) throw new Error("Unknown or missing argument");
    if (argument === "--input") options.input = value;
    else if (argument === "--out") options.out = value;
    else if (argument === "--concurrency") options.concurrency = Number(value);
    else throw new Error("Unknown or missing argument");
  }
  if (!options.input || !options.out) throw new Error("--input and --out are required");
  return options as ReplayOptions;
}
function isMainModule() {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
  catch { return false; }
}
if (isMainModule()) {
  runContextReplay(parseContextReplayArgs(process.argv.slice(2))).then((report) => {
    if (report.invocation.live && report.status !== "complete") {
      console.error("Context replay setup failed; inspect the reserved partial report and use a fresh output path.");
      process.exitCode = 1;
    }
  }).catch(() => {
    console.error("Context replay failed; inspect the reserved partial report and use a fresh output path.");
    process.exitCode = 1;
  });
}

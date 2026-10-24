/**
 * Gold-blind, check-only screen of the opt-in category-union premise sentence against the original
 * premise check. Each fixed-cohort question gets two fresh premise calls (original and category-union)
 * on the saved canonical 472 evidence. No answers are regenerated, no judge runs and no score is
 * produced. Cohort membership reads only question IDs and the abstention safety stratum.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { answerGenerationClock } from "./longmemeval-answer-review.js";
import { CATEGORY_UNION_SENTENCE, premiseCheckPrompt, type PremisePolicy } from "./longmemeval-premise-check.js";
import { longRequestFetch } from "./longmemeval-qa-transport.js";
import { createModelCall, parseObject, safeError, sha256, type Call, type ModelCall } from "./longmemeval-qa-support.js";

export const TRIAL_SEED = "recall-longmemeval-additive-2026-10-23-v1";
export const BASELINE_SHA = "9cba4555cad8031eec9e404d96ae4f7065c302cbacfa8a87f1232c0b9e0105f0";
export const INPUT_SHA = "169e909e5e514a8376871fb3351c6597e90bfdf696f6d7206ec33d91dd9c02f4";
const CANONICAL_QUESTIONS = 500;

export type TrialOptions = {
  report: string; input: string; out: string; live: boolean; concurrency: number;
  baselineSha?: string; inputSha?: string; abstentions?: number; answerable?: number;
};
export type TrialDeps = { call?: ModelCall; fetcher?: (url: string, init: RequestInit) => Promise<Response> };
type Verdict = { call: Call; recorded: boolean | null; prompt_sha256: string };
type InputCase = { question_id: string; is_abstention: boolean; question: string; answer_prompt_prefix: string };
type Saved = { question_id: string; premise_recorded?: boolean | null; draft_answer?: string | null; evidence?: { text?: unknown } | null };
type Row = Record<string, any>;

const hkey = (id: string) => createHash("sha256").update(TRIAL_SEED).update("\0").update(id).digest("hex");
const byKey = (a: string, b: string) => { const x = hkey(a), y = hkey(b); return x < y ? -1 : x > y ? 1 : 0; };
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
/** Every local module that shapes the prompts, transport, request settings or parsing of these calls. */
const CODE_FILES = [
  "./longmemeval-premise-union-trial.ts", "./longmemeval-premise-check.ts", "./longmemeval-qa-support.ts", "./longmemeval-qa-transport.ts",
  "./longmemeval-inference-policy.ts", "./longmemeval-answer-review.ts", "./temporal-model.ts",
  "../src/vector/sqlite-fts.ts", "../src/text/match.ts", "../src/vector/synonyms.ts", "../src/data/synonyms.en.json", "../src/models/retrieval-text.ts",
];

/** All abstention IDs plus the first N answerable IDs by SHA-256(seed NUL id), sorted by the same hash. Reads IDs and the flag only. */
export function deriveCohort(cases: readonly { question_id: string; is_abstention: boolean }[], abstentions = 30, answerable = 70) {
  const ids = cases.map((item) => item.question_id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate input IDs");
  if (cases.some((item) => typeof item.is_abstention !== "boolean")) throw new Error("Abstention flag must be boolean");
  const abstain = cases.filter((item) => item.is_abstention).map((item) => item.question_id).sort(byKey);
  const rest = cases.filter((item) => !item.is_abstention).map((item) => item.question_id).sort(byKey);
  if (abstain.length !== abstentions || rest.length < answerable) throw new Error("Cohort count mismatch");
  const answerableIds = rest.slice(0, answerable);
  return { abstention_ids: abstain, answerable_ids: answerableIds, selected_question_ids: [...abstain, ...answerableIds].sort(byKey) };
}

/** A failed screen exits nonzero; a completed one exits zero even when its numeric gate fails. */
export const trialExitCode = (report: { status: string }): number => (report.status === "failed" ? 1 : 0);

export async function runTrial(options: TrialOptions, deps: TrialDeps = {}) {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 3) throw new Error("Concurrency must be 1 to 3");
  if (!options.out) throw new Error("--out is required");
  const jsonlPath = `${options.out}.jsonl`, callsPath = `${options.out}.calls.jsonl`;
  if (existsSync(options.out) || existsSync(jsonlPath) || existsSync(callsPath)) throw new Error("Output already exists; choose a new path");
  const reportBytes = readFileSync(options.report), inputBytes = readFileSync(options.input);
  if (sha256(reportBytes) !== (options.baselineSha ?? BASELINE_SHA)) throw new Error("Saved report is not the pinned baseline");
  if (sha256(inputBytes) !== (options.inputSha ?? INPUT_SHA)) throw new Error("Input is not the pinned input");
  const results = (JSON.parse(reportBytes.toString()) as { results: Saved[] }).results;
  const inputCases = (JSON.parse(inputBytes.toString()) as { cases: InputCase[] }).cases;
  if (!Array.isArray(results) || !Array.isArray(inputCases)) throw new Error("Report results and input cases must be arrays");
  const cohortOverridden = options.abstentions !== undefined || options.answerable !== undefined;
  if (!cohortOverridden) {
    const sameIds = new Set(inputCases.map((c) => c.question_id)).size === CANONICAL_QUESTIONS
      && results.length === CANONICAL_QUESTIONS && results.every((row) => inputCases.some((c) => c.question_id === row.question_id));
    if (inputCases.length !== CANONICAL_QUESTIONS || !sameIds) throw new Error(`Canonical input and report must hold the same ${CANONICAL_QUESTIONS} questions`);
  }
  const saved = new Map(results.map((row) => [row.question_id, row]));
  const cases = new Map(inputCases.map((item) => [item.question_id, item]));
  const cohort = deriveCohort(inputCases, options.abstentions, options.answerable);
  const ids = cohort.selected_question_ids;
  for (const id of ids) {
    const item = cases.get(id)!;
    if (typeof saved.get(id)?.evidence?.text !== "string") throw new Error("Saved evidence missing for a selected question");
    if (typeof item.question !== "string" || typeof item.answer_prompt_prefix !== "string") throw new Error("Input case schema is invalid for a selected question");
  }

  const prompt = (id: string, policy: PremisePolicy) => {
    const item = cases.get(id)!;
    return premiseCheckPrompt(item.question, answerGenerationClock(item.answer_prompt_prefix), saved.get(id)!.evidence!.text as string, policy);
  };
  const canonical = options.baselineSha === undefined && options.inputSha === undefined && !cohortOverridden && ids.length === 100;
  const comparisonValid = options.live && deps.call === undefined && deps.fetcher === undefined && canonical;
  const base = {
    kind: "premise_union_check_only_screen", live: options.live, comparison_valid: comparisonValid, live_answer_calls: 0, judge_calls: 0, score_output: false,
    settings: { provider: "qwen-local", kind: "premise", reasoning_effort: "low", max_output_tokens: 4096, structured_output: true, concurrency: options.concurrency, calls_per_case: 2 },
    hashes: {
      report: sha256(reportBytes), input: sha256(inputBytes), trial_source: sha256(readFileSync(here("./longmemeval-premise-union-trial.ts"))),
      premise_check_source: sha256(readFileSync(here("./longmemeval-premise-check.ts"))), union_sentence: sha256(CATEGORY_UNION_SENTENCE),
      code: Object.fromEntries(CODE_FILES.map((path) => [here(path), sha256(readFileSync(here(path)))])),
    },
    cohort: { seed: TRIAL_SEED, rule: "all abstention cases plus the first 70 answerable by SHA256(seed NUL id); sorted by the same hash", count: ids.length, ...cohort },
    selection_note: "Cohort membership reads only question IDs and the abstention-flag safety stratum; scores, references, correctness and gold IDs never enter selection or either check. Saved premise_recorded and draft presence are diagnostics only.",
  };
  writeFileSync(options.out, JSON.stringify({ ...base, status: "partial", rows: [] }), { flag: "wx" });
  writeFileSync(jsonlPath, "", { flag: "wx" });
  writeFileSync(callsPath, "", { flag: "wx" });

  // Credentials are read only here, after every output path is reserved.
  let call: ModelCall | undefined;
  try {
    call = !options.live ? undefined : deps.call ?? createModelCall("qwen-local", deps.fetcher ?? longRequestFetch, { structuredOutput: true });
  } catch (error) {
    writeFileSync(options.out, `${JSON.stringify({ ...base, status: "failed", error: safeError(error), rows: [] })}\n`);
    throw error;
  }

  const rows: Row[] = new Array(ids.length);
  const allCalls: Call[] = [];
  const journal = (entry: Row) => appendFileSync(callsPath, `${JSON.stringify(entry)}\n`);
  let next = 0;
  /** Journals the logical call at start and again at completion, so an interrupted pair keeps the first call's result. */
  const ask = async (index: number, id: string, arm: "original" | "category-union", position: number, text: string): Promise<Verdict> => {
    const start = Date.now();
    journal({ event: "start", index, question_id: id, arm, position, prompt_sha256: sha256(text), prompt: text, at: new Date(start).toISOString() });
    let result: Call;
    try { result = await call!("premise", text); } catch (error) {
      result = { text: null, error: `call_threw:${safeError(error)}`, attempts: 0, elapsed_ms: Date.now() - start, model: "unknown", usage: null, prompt_sha256: sha256(text) };
    }
    allCalls.push(result);
    const check = result.error ? null : parseObject(result.text);
    const recorded = typeof check?.correct === "boolean" ? check.correct : null;
    journal({ event: "finish", index, question_id: id, arm, position, prompt_sha256: sha256(text), recorded, call: result });
    return { call: result, recorded, prompt_sha256: sha256(text) };
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, ids.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= ids.length) return;
      const id = ids[index]!, item = cases.get(id)!, old = saved.get(id)!;
      const unionFirst = index % 2 === 1;
      const controlPrompt = prompt(id, "original"), treatmentPrompt = prompt(id, "category-union");
      const row: Row = {
        index, question_id: id, is_abstention: item.is_abstention, order: unionFirst ? "union_first" : "original_first",
        saved_premise_recorded: old.premise_recorded ?? null, saved_draft_present: typeof old.draft_answer === "string" && old.draft_answer.length > 0,
        control_prompt: controlPrompt, treatment_prompt: treatmentPrompt,
        control_prompt_sha256: sha256(controlPrompt), treatment_prompt_sha256: sha256(treatmentPrompt),
      };
      if (call) {
        // Both calls are always attempted; a thrown or failed call is recorded, never allowed to escape the accounting.
        const first = await ask(index, id, unionFirst ? "category-union" : "original", 1, unionFirst ? treatmentPrompt : controlPrompt);
        const second = await ask(index, id, unionFirst ? "original" : "category-union", 2, unionFirst ? controlPrompt : treatmentPrompt);
        const control = unionFirst ? second : first, treatment = unionFirst ? first : second;
        Object.assign(row, { control, treatment, status: control.recorded === null || treatment.recorded === null ? "error" : "ok" });
      } else row.status = "preflight";
      rows[index] = row;
      appendFileSync(jsonlPath, `${JSON.stringify(row)}\n`);
    }
  }));

  const ok = rows.filter((row) => row.status === "ok");
  const abs = (row: Row) => row.is_abstention === true;
  const flips = (filter: (row: Row) => boolean, from: boolean, to: boolean) =>
    ok.filter((row) => filter(row) && row.control.recorded === from && row.treatment.recorded === to).map((row) => row.question_id as string);
  const absFalseToTrue = flips(abs, false, true);
  const ansTrueToFalse = flips((row) => !abs(row), true, false);
  const ansFalseToTrue = flips((row) => !abs(row), false, true);
  const complete = call !== undefined && ok.length === ids.length;
  const numericPassed = complete && absFalseToTrue.length === 0 && ansTrueToFalse.length === 0 && ansFalseToTrue.length >= 1;
  // A call's usage is complete only when input and output tokens are both finite non-negative integers.
  const validTokens = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
  const tokens = (c: Call, key: string) => { const v = c.usage?.[key]; return validTokens(v) ? v : 0; };
  const usageComplete = (c: Call) => validTokens(c.usage?.input_tokens) && validTokens(c.usage?.output_tokens);
  const unknownFinal = allCalls.filter((c) => !usageComplete(c)).length;
  const priorUnknown = allCalls.reduce((n, c) => n + Math.max(c.attempts - 1, 0), 0);
  const usage = {
    calls: allCalls.length, attempts: allCalls.reduce((n, c) => n + c.attempts, 0), http_retries: priorUnknown,
    elapsed_ms_total: allCalls.reduce((n, c) => n + c.elapsed_ms, 0), elapsed_ms_max: allCalls.reduce((n, c) => Math.max(n, c.elapsed_ms), 0),
    unknown_usage_calls: unknownFinal, prior_http_attempts_unknown_usage: priorUnknown,
    usage_complete: unknownFinal === 0 && priorUnknown === 0, observed_totals_are_lower_bounds: unknownFinal > 0 || priorUnknown > 0,
    call_errors: allCalls.filter((c) => c.error !== null).length,
    thrown_calls: allCalls.filter((c) => c.error?.startsWith("call_threw:")).length,
    // Malformed means the model answered without a transport error but gave no boolean verdict.
    malformed_checks: allCalls.filter((c) => !c.error && typeof parseObject(c.text)?.correct !== "boolean").length,
    input_tokens_known: allCalls.reduce((n, c) => n + tokens(c, "input_tokens"), 0), output_tokens_known: allCalls.reduce((n, c) => n + tokens(c, "output_tokens"), 0),
    fallbacks: 0, note: "No fallback or answer-level retry exists in this screen; attempts above one are adapter HTTP retries whose usage is unknown. Known tokens are a lower bound unless usage_complete is true.",
  };
  const summary = {
    usage,
    planned: ids.length, scored: ok.length, errors: rows.filter((row) => row.status === "error").length, errored_rows: rows.filter((row) => row.status === "error").length,
    abstention_false_to_true: absFalseToTrue, answerable_true_to_false: ansTrueToFalse, answerable_false_to_true: ansFalseToTrue,
    drafts_retained_diagnostic: ok.filter((row) => row.treatment.recorded === true).length,
    drafts_dropped_diagnostic: ok.filter((row) => row.treatment.recorded === false).length,
    gate: call === undefined ? null : {
      all_complete: complete, no_abstention_flipped_to_true: complete && absFalseToTrue.length === 0,
      no_newly_rejected_answerable: complete && ansTrueToFalse.length === 0, recovery_candidates_for_source_review: ansFalseToTrue.length,
      numeric_screen_passed: numericPassed, comparison_valid: comparisonValid,
      passed: numericPassed && comparisonValid, source_review_pending: true,
      advancement: "Not authorized: a passing numeric screen still requires independent source review of every recovery before any full500.",
    },
  };
  const report = { ...base, status: call === undefined ? "preflight" : complete ? "complete" : "failed", summary, rows };
  writeFileSync(options.out, `${JSON.stringify(report)}\n`);
  return report;
}

export function parseTrialArgs(args: string[]): TrialOptions {
  const options: TrialOptions = { report: "", input: "", out: "", live: false, concurrency: 3 };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--live") { options.live = true; continue; }
    const value = args[++i];
    if (!value) throw new Error("Unknown or missing argument");
    if (key === "--report") options.report = value;
    else if (key === "--input") options.input = value;
    else if (key === "--out") options.out = value;
    else if (key === "--concurrency") options.concurrency = Number(value);
    else throw new Error("Unknown or missing argument");
  }
  if (!options.report || !options.input || !options.out) throw new Error("--report, --input and --out are required");
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTrial(parseTrialArgs(process.argv.slice(2)))
    .then((report) => { console.log(JSON.stringify({ status: report.status, summary: report.summary })); process.exitCode = trialExitCode(report); })
    .catch((error) => { console.error(String(error instanceof Error ? error.message : error)); process.exitCode = 1; });
}

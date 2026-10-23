import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerPrompt, createModelCall, judgePrompt, sha256, type Call, type ModelCall } from "../benchmark/longmemeval-qa-support.js";
import { CONTEXT_REPLAY_MODEL_CONFIG } from "../benchmark/longmemeval-context-replay.js";
import { MINIMAL_ANSWER_POLICY } from "../benchmark/longmemeval-minimal-answer-policy.js";
import { canonicalMinimalPolicyJson, MINIMAL_POLICY_TRIAL_CONFIGS, parseMinimalPolicyTrialArgs, runMinimalPolicyTrial, type MinimalPolicyTrialCalls, type MinimalPolicyTrialSelection } from "../benchmark/longmemeval-minimal-policy-trial.js";
import { HISTORY_EVIDENCE_POLICY } from "../src/history/evidence-policy.js";
import type { ContextReplayInput } from "../benchmark/longmemeval-context-replay-input.js";

const appendMock = vi.hoisted(() => ({
  target: null as string | null,
  shouldFail: false,
  onFailure: null as (() => void) | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
      if (typeof args[0] === "string" && args[0] === appendMock.target && appendMock.shouldFail) {
        appendMock.shouldFail = false;
        appendMock.onFailure?.();
        throw new Error("synthetic journal failure");
      }
      return actual.appendFileSync(...args);
    },
  };
});

const temp = () => mkdtempSync(join(tmpdir(), "recall-minimal-policy-"));
const TYPES = ["knowledge-update", "multi-session", "single-session-assistant", "single-session-preference", "single-session-user", "temporal-reasoning"];
const completeUsage = {
  input_tokens: 3, output_tokens: 4, total_tokens: 7,
  input_tokens_details: { cached_tokens: 1 },
  output_tokens_details: { reasoning_tokens: 2 },
};
const response = (text: string | null, error: string | null = null, usage: Call["usage"] = completeUsage): Call => ({ text, error, attempts: 1, elapsed_ms: 1, model: "stub", usage, prompt_sha256: "stub" });
const caseOf = (prompt: string) => Number(/Recall-only evidence (\d+)\./.exec(prompt)?.[1] ?? -1);

function fixture(): { input: ContextReplayInput; selection: MinimalPolicyTrialSelection } {
  const cases = Array.from({ length: 60 }, (_, index) => {
    const question_id = `q${String(index).padStart(2, "0")}`, question = `Question ${index}?`, context = `Recall-only evidence ${index}.`;
    return {
      index, question_id, question_type: TYPES[Math.floor(index / 10)]!, is_abstention: false,
      generation: { question, answer_prompt_prefix: `Answer only from evidence.\nQuestion: ${question}\nQuestion Date: 2026-01-01\n\nRetrieved Context:\n__RECALL_CONTEXT__` },
      judge_case: { question_id, question_type: TYPES[Math.floor(index / 10)]!, is_abstention: false, question, question_date: "2026-01-01", reference: `REFERENCE-${index}`, gold_session_ids: [`GOLD-${index}`], answer_prompt_prefix: "unused __RECALL_CONTEXT__", judge_prompt_template: `Reference: REFERENCE-${index}\nCandidate: __RECALL_CANDIDATE__`, sessions: [] },
      sides: {
        recall: { name: "recall" as const, context, context_sha256: sha256(context), context_utf16_chars: context.length, replacements: [] },
        hindsight: { name: "hindsight" as const, context: "HINDSIGHT-MUST-NOT-APPEAR", context_sha256: sha256("HINDSIGHT-MUST-NOT-APPEAR"), context_utf16_chars: 26, replacements: [] },
      },
    };
  });
  const input = { selected_question_ids: cases.map((item) => item.question_id), cases, source_canonical_sha256: {}, generation_blinding: "fixture" } as unknown as ContextReplayInput;
  return { input, selection: { development_ids: input.selected_question_ids, selected_review_ids: input.selected_question_ids.slice(0, 17), input_sha256: sha256(canonicalMinimalPolicyJson(input)), mask_seed: 20261022 } };
}

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((finish) => { resolve = finish; });
  return { promise, release: () => resolve?.() };
}

describe("LongMemEval minimal policy trial", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    appendMock.target = null;
    appendMock.shouldFail = false;
    appendMock.onFailure = null;
  });

  it("runs 120 one-pass tasks as 240 calls over identical evidence and base prompts", async () => {
    const { input, selection } = fixture(), out = join(temp(), "report.json");
    const seen: { arm: string; kind: string; prompt: string }[] = [], active = { now: 0, max: 0 };
    let judgeChecks = 0;
    const seq: Record<string, number> = { control: 0, comparison: 0 };
    const armCall = (arm: "control" | "comparison"): ModelCall => async (kind, prompt) => {
      seen.push({ arm, kind, prompt }); active.now++; active.max = Math.max(active.max, active.now);
      await new Promise((resolve) => setTimeout(resolve, seq[arm] % 2 ? 4 : 1)); seq[arm]++; active.now--;
      return response(`{"reasoning":"r","answer":"${arm}-${seq[arm]} final"}`);
    };
    const judge: ModelCall = async (kind, prompt) => {
      seen.push({ arm: "judge", kind, prompt }); active.now++; active.max = Math.max(active.max, active.now);
      const journal = readFileSync(`${out}.calls.jsonl`, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { stage: string; arm: string; case_index: number; task_index: number; call: Call });
      const candidate = /Candidate: ([^\n]+) final/.exec(prompt)?.[1]!;
      const source = journal.filter((entry) => entry.stage === "answer" && entry.call.text === `{"reasoning":"r","answer":"${candidate} final"}`);
      expect(source).toHaveLength(1);
      expect(journal.some((entry) => entry.stage === "judge" && entry.arm === source[0]!.arm && entry.case_index === source[0]!.case_index)).toBe(false);
      judgeChecks++; await new Promise((resolve) => setTimeout(resolve, 1)); active.now--;
      return response('{"correct":true,"reason":"ok"}');
    };
    const report = await runMinimalPolicyTrial({ input, selection, out, live: true, concurrency: 3 }, { control: armCall("control"), comparison: armCall("comparison"), judge });
    expect(report.results).toHaveLength(120);
    expect(report.results.map((row) => row.task_index)).toEqual(Array.from({ length: 120 }, (_, index) => index));
    expect(report.results.slice(0, 4).map((row) => [row.case_index, row.arm])).toEqual([[0, "control"], [0, "comparison"], [1, "comparison"], [1, "control"]]);
    expect(seen).toHaveLength(240); expect(active.max).toBeLessThanOrEqual(3);
    expect(seen.filter((entry) => entry.arm !== "judge")).toHaveLength(120);
    expect(seen.every((entry) => !entry.prompt.includes("HINDSIGHT-MUST-NOT-APPEAR"))).toBe(true);
    for (const item of input.cases) {
      const prompt = answerPrompt(item.generation, item.sides.recall.context);
      const rows = report.results.filter((row) => row.case_index === item.index);
      expect(rows).toHaveLength(2);
      expect([...new Set(rows.map((row) => row.answer_prompt_sha256))]).toEqual([sha256(prompt)]);
      expect([...new Set(rows.map((row) => row.base_prompt_sha256))]).toEqual([sha256(prompt)]);
      const sent = seen.filter((entry) => entry.kind === "answer" && caseOf(entry.prompt) === item.index);
      expect(sent).toHaveLength(2); expect(sent[0]!.prompt).toBe(sent[1]!.prompt);
      const judged = seen.filter((entry) => entry.arm === "judge" && entry.prompt.startsWith(`Reference: REFERENCE-${item.index}\nCandidate: `));
      expect(judged).toHaveLength(2);
      expect(judged.every((entry) => !entry.prompt.includes("Recall-only evidence") && !entry.prompt.includes("HISTORY") && !entry.prompt.includes(MINIMAL_ANSWER_POLICY))).toBe(true);
    }
    expect(report.summary).toMatchObject({ planned_tasks: 120, planned_logical_model_invocations: 240, recorded_tasks: 120, by_arm: { control: { planned: 60, correct: 60, accuracy: 1, errors: 0 }, comparison: { planned: 60, correct: 60, accuracy: 1, errors: 0 } }, paired_fresh_verdicts: { paired: 60, comparison_gain: 0, comparison_loss: 0 } });
    expect(Object.values(report.summary.categories).every((value) => value.control.planned === 10 && value.comparison.planned === 10)).toBe(true);
    expect(report.summary.abstention).toMatchObject({ planned: 0 });
    expect(report.summary.resources.control.answer_call).toMatchObject({
      calls: 60, comparable_calls: 60, calls_with_unknown_usage: 0, calls_with_errors: 0,
      observed_input_tokens: 180, observed_output_tokens: 240, observed_reasoning_tokens: 120,
      observed_cached_tokens: 60, observed_total_tokens: 420, calls_with_unknown_attempts: 0,
    });
    expect(report.summary.resources.comparison.judge_call.calls).toBe(60);
    expect(report.summary.by_arm.control.output_answer_utf16_chars.answers).toBe(60);
    expect(readFileSync(`${out}.jsonl`, "utf8").split("\n").filter(Boolean)).toHaveLength(120);
    const journal = readFileSync(`${out}.calls.jsonl`, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { stage: string; kind: string; task_index: number; prompt_sha256: string; call: Call });
    expect(journal).toHaveLength(240);
    expect(journal.filter((entry) => entry.stage === "answer").map((entry) => entry.task_index).sort((a, b) => a - b)).toEqual(Array.from({ length: 120 }, (_, index) => index));
    expect(journal.every((entry) => entry.prompt_sha256 === entry.call.prompt_sha256 || entry.call.prompt_sha256 === "stub")).toBe(true);
    expect(report.status).toBe("complete");
    expect(JSON.parse(readFileSync(`${out}.progress.json`, "utf8"))).toMatchObject({ status: "complete", completed_tasks: 120 });
  });

  it("keeps the control arm byte-identical to the prior one-pass wire profile and differs only by answer policy", async () => {
    const directory = temp(), token = join(directory, "token");
    writeFileSync(token, "test-token");
    vi.stubEnv("DGX_BASE_URL", "http://127.0.0.1:4010/v1");
    vi.stubEnv("DGX_KEY_FILE", token);
    const requests: { path: string; body: string }[] = [];
    const capture = async (url: string, init: RequestInit) => {
      requests.push({ path: new URL(url).pathname, body: String(init.body) });
      return Response.json({ status: "completed", model: "qwen3.8-flash-next", output_text: '{"reasoning":"r","answer":"wire"}', usage: { total_tokens: 3 } });
    };
    const { input, selection } = fixture();
    const native: MinimalPolicyTrialCalls = {
      control: createModelCall(MINIMAL_POLICY_TRIAL_CONFIGS.control.provider, capture, MINIMAL_POLICY_TRIAL_CONFIGS.control.options),
      comparison: createModelCall(MINIMAL_POLICY_TRIAL_CONFIGS.comparison.provider, capture, MINIMAL_POLICY_TRIAL_CONFIGS.comparison.options),
      judge: createModelCall(MINIMAL_POLICY_TRIAL_CONFIGS.judge.provider, capture, MINIMAL_POLICY_TRIAL_CONFIGS.judge.options),
    };
    const report = await runMinimalPolicyTrial({ input, selection, out: join(directory, "wire.json"), live: true }, native);
    expect(report.execution_mode).toBe("injected"); expect(report.comparison_valid).toBe(false);
    expect(requests).toHaveLength(240);
    expect(MINIMAL_POLICY_TRIAL_CONFIGS.control.options).toEqual(CONTEXT_REPLAY_MODEL_CONFIG.options);
    const reference = await createModelCall(CONTEXT_REPLAY_MODEL_CONFIG.provider, capture, CONTEXT_REPLAY_MODEL_CONFIG.options)("answer", answerPrompt(input.cases[0]!.generation, input.cases[0]!.sides.recall.context), { question: input.cases[0]!.generation.question });
    expect(reference.error).toBeNull();
    const onePass = requests.at(-1)!, control = requests.find((entry) => JSON.parse(entry.body).input[0].content.includes(HISTORY_EVIDENCE_POLICY) && !entry.body.includes(MINIMAL_ANSWER_POLICY))!;
    expect(control.body).toBe(onePass.body); expect(control.path).toBe("/v1/responses");
    const bodies = requests.slice(0, 240).map((entry) => JSON.parse(entry.body) as { input: { role: string; content: string }[]; temperature: number; reasoning: { effort: string }; max_output_tokens: number; model: string; text: { format: { name: string } } });
    const answers = bodies.filter((body) => body.text.format.name === "benchmark_answer"), judges = bodies.filter((body) => body.text.format.name === "benchmark_judge");
    expect(answers).toHaveLength(120); expect(judges).toHaveLength(120);
    expect(new Set(answers.map((body) => body.input[0].content)).size).toBe(2);
    const systems = new Set(answers.map((body) => body.input[0].content));
    const controlSystem = [...systems].find((text) => !text.includes(MINIMAL_ANSWER_POLICY))!, comparisonSystem = [...systems].find((text) => text.includes(MINIMAL_ANSWER_POLICY))!;
    expect(comparisonSystem).toBe(`${controlSystem}\n\n${MINIMAL_ANSWER_POLICY}`);
    expect(answers.every((body) => body.temperature === 0 && body.max_output_tokens === 16384 && ["low", "high"].includes(body.reasoning.effort))).toBe(true);
    expect(judges.every((body) => body.max_output_tokens === 4096 && body.reasoning.effort === "none" && !body.input[0].content.includes(HISTORY_EVIDENCE_POLICY) && !body.input[0].content.includes(MINIMAL_ANSWER_POLICY))).toBe(true);
    expect(judges.map((body) => body.input[1].content).every((text) => text.includes("wire") || text.includes("Reference:"))).toBe(true);
    expect("answerInstructions" in MINIMAL_POLICY_TRIAL_CONFIGS.judge.options).toBe(false);
  });

  it("scores failures against the fixed denominator with no repair, rejudge, or survivor fallback", async () => {
    const { input, selection } = fixture();
    const invokes: string[] = [];
    const control: ModelCall = async (kind, prompt) => { invokes.push(`control:${caseOf(prompt)}`); return kind === "answer" ? response(null, "request_failed") : response('{"correct":true}'); };
    const comparison: ModelCall = async (_kind, prompt) => { invokes.push(`comparison:${caseOf(prompt)}`); return response("not json at all"); };
    const judge: ModelCall = async () => { invokes.push("judge"); return response('{"correct":true,"reason":"ok"}'); };
    const report = await runMinimalPolicyTrial({ input, selection, out: join(temp(), "failures.json"), live: true }, { control, comparison, judge });
    expect(invokes.filter((value) => value.startsWith("control:"))).toHaveLength(60);
    expect(invokes.filter((value) => value.startsWith("comparison:"))).toHaveLength(60);
    expect(invokes.filter((value) => value === "judge")).toHaveLength(0);
    expect(report.results.filter((row) => row.arm === "control").every((row) => row.correct === false && row.error === "answer_request_failed" && row.judge_call === null)).toBe(true);
    expect(report.results.filter((row) => row.arm === "comparison").every((row) => row.correct === false && row.error === "malformed_answer" && row.answer === null && row.judge_call === null)).toBe(true);
    expect(report.summary.by_arm).toMatchObject({ control: { planned: 60, scored: 60, correct: 0, accuracy: 0, errors: 60 }, comparison: { planned: 60, scored: 60, correct: 0, accuracy: 0, errors: 60 } });
    expect(report.summary.paired_fresh_verdicts).toMatchObject({ paired: 60, comparison_gain: 0, comparison_loss: 0 });
    expect(report.summary.errors_by_kind).toMatchObject({ answer_request_failed: 60, malformed_answer: 60 });
    expect(report.status).toBe("complete");
  });

  it("treats a thrown call and a malformed verdict as scored failures and flags unknown usage", async () => {
    const { input, selection } = fixture();
    let controlAnswers = 0, judges = 0;
    const control: ModelCall = async () => { controlAnswers++; throw new Error("socket hang up"); };
    const comparison: ModelCall = async () => response('{"reasoning":"r","answer":"ok"}', null);
    const judge: ModelCall = async () => { judges++; return response('{"note":"no verdict"}', null); };
    const report = await runMinimalPolicyTrial({ input, selection, out: join(temp(), "thrown.json"), live: true }, { control, comparison, judge });
    expect(controlAnswers).toBe(60); expect(judges).toBe(60);
    expect(report.results.filter((row) => row.arm === "control").every((row) => row.correct === false && row.error === "answer_request_failed" && row.answer_call?.attempts === 0 && row.answer_call?.model === "unknown_after_thrown_call")).toBe(true);
    expect(report.results.filter((row) => row.arm === "comparison").every((row) => row.correct === false && row.error === "malformed_judge")).toBe(true);
    expect(report.summary.by_arm.control).toMatchObject({ planned: 60, correct: 0, accuracy: 0, errors: 60 });
    expect(report.summary.by_arm.comparison).toMatchObject({ planned: 60, correct: 0, accuracy: 0, errors: 60 });
    expect(report.summary.resources.control.answer_call).toMatchObject({ calls: 60, comparable_calls: 0, calls_with_errors: 60, calls_with_unknown_usage: 60, calls_with_unknown_attempts: 60 });
    expect(report.summary.resource_note).toContain("computes no resource verdict");
    expect(report.summary.categories["multi-session"]!.control.errors).toBe(10);
  });

  it("keeps missing, invalid, and inconsistent usage out of comparable stage totals", async () => {
    const { input, selection } = fixture();
    const without = (key: keyof typeof completeUsage) => {
      const usage: Record<string, unknown> = { ...completeUsage };
      delete usage[key];
      return usage;
    };
    const answerUsage: Call["usage"][] = [
      without("input_tokens"), without("output_tokens"), without("total_tokens"), null,
      { ...completeUsage, total_tokens: 8 }, { ...completeUsage, output_tokens: -1 },
    ];
    let controlCalls = 0;
    const control: ModelCall = async () => {
      const index = controlCalls++, usage = index < answerUsage.length ? answerUsage[index]! : completeUsage;
      const call = response('{"reasoning":"r","answer":"ok"}', null, usage);
      if (controlCalls === 7) call.attempts = 2;
      return call;
    };
    const comparison: ModelCall = async () => response('{"reasoning":"r","answer":"ok"}');
    const judge: ModelCall = async () => response('{"correct":true,"reason":"ok"}');
    const report = await runMinimalPolicyTrial({ input, selection, out: join(temp(), "usage.json"), live: true }, { control, comparison, judge });
    expect(report.summary.resources.control.answer_call).toMatchObject({
      calls: 60, calls_with_errors: 0, comparable_calls: 54,
      calls_with_missing_input_tokens: 2, calls_with_missing_output_tokens: 3, calls_with_missing_total_tokens: 2,
      calls_with_invalid_output_tokens: 1, calls_with_inconsistent_input_output_total: 1,
      calls_with_unknown_usage: 5, calls_with_retries: 1, observed_retries: 1, calls_with_unknown_attempts: 0,
    });
  });

  it("reports native Responses nested reasoning and cached usage without replacing invalid nested values", async () => {
    const { input, selection } = fixture();
    const nested = {
      input_tokens: 11, output_tokens: 13, total_tokens: 24,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens_details: { reasoning_tokens: 7 },
    };
    let controlCalls = 0;
    const control: ModelCall = async () => {
      const usage = controlCalls++ === 0
        ? { ...nested, input_tokens_details: { cached_tokens: -1 }, cached_tokens: 99 }
        : nested;
      return response('{"reasoning":"r","answer":"ok"}', null, usage);
    };
    const comparison: ModelCall = async () => response('{"reasoning":"r","answer":"ok"}');
    const judge: ModelCall = async () => response('{"correct":true,"reason":"ok"}');
    const report = await runMinimalPolicyTrial({ input, selection, out: join(temp(), "nested-usage.json"), live: true }, { control, comparison, judge });
    expect(report.summary.resources.control.answer_call).toMatchObject({
      calls: 60, comparable_calls: 60, calls_with_unknown_usage: 1,
      observed_input_tokens: 660, observed_output_tokens: 780, observed_total_tokens: 1440,
      observed_reasoning_tokens: 420, observed_cached_tokens: 295,
      calls_with_missing_cached_tokens: 1, calls_with_invalid_cached_tokens: 1,
    });
  });

  it("aborts successors before the next underlying invoke when a peer journal write fails", async () => {
    const { input, selection } = fixture(), out = join(temp(), "journal-fail.json");
    const invoked: string[] = [];
    const initial = new Map([
      ["answer:control:0", deferred()], ["answer:comparison:0", deferred()], ["answer:comparison:1", deferred()],
    ]);
    const initialCalls = deferred(), journalFailure = deferred();
    const armCall = (arm: "control" | "comparison"): ModelCall => async (_kind, prompt) => {
      const key = `answer:${arm}:${caseOf(prompt)}`;
      invoked.push(key);
      if (invoked.length === 3) initialCalls.release();
      await initial.get(key)?.promise;
      return response('{"reasoning":"r","answer":"aborted"}');
    };
    const judge: ModelCall = async () => { invoked.push("judge"); return response('{"correct":true}'); };
    appendMock.target = `${out}.calls.jsonl`;
    appendMock.shouldFail = true;
    appendMock.onFailure = journalFailure.release;
    const running = runMinimalPolicyTrial({ input, selection, out, live: true, concurrency: 3 }, { control: armCall("control"), comparison: armCall("comparison"), judge });
    await initialCalls.promise;
    expect(new Set(invoked)).toEqual(new Set(["answer:control:0", "answer:comparison:0", "answer:comparison:1"]));
    initial.get("answer:control:0")!.release();
    await journalFailure.promise;
    initial.forEach((gate) => gate.release());
    await expect(running).rejects.toThrow();
    expect(invoked.filter((value) => value === "judge")).toHaveLength(0);
    expect(invoked).toHaveLength(3);
    const report = JSON.parse(readFileSync(out, "utf8")) as { status: string; results: unknown[]; summary: { recorded_tasks: number } };
    expect(report.status).toBe("partial"); expect(report.results).toHaveLength(0);
    expect(JSON.parse(readFileSync(`${out}.progress.json`, "utf8"))).toMatchObject({ status: "partial", completed_tasks: 0 });
  });

  it("reserves every output before any factory, prepares offline with zero calls, and rejects collisions", async () => {
    const directory = temp(), { input, selection } = fixture(), collision = join(directory, "exists.json");
    writeFileSync(collision, "keep");
    const unavailable = (async () => { throw new Error("must not be invoked"); }) as unknown as ModelCall;
    let factories = 0;
    await expect(runMinimalPolicyTrial({ input, selection, out: collision, live: true }, undefined, () => { factories++; return { control: unavailable, comparison: unavailable, judge: unavailable }; })).rejects.toThrow("Output already exists");
    expect(readFileSync(collision, "utf8")).toBe("keep"); expect(factories).toBe(0);
    input.cases[3]!.judge_case.judge_prompt_template = "invalid";
    await expect(runMinimalPolicyTrial({ input, selection, out: join(directory, "bad.json"), live: true }, undefined, () => { factories++; return { control: unavailable, comparison: unavailable, judge: unavailable }; })).rejects.toThrow("Invalid judge prompt marker");
    expect(existsSync(join(directory, "bad.json"))).toBe(false); expect(factories).toBe(0);
    let offlineInvokes = 0;
    const count = (): ModelCall => async () => { offlineInvokes++; return response("{}"); };
    const injectedOffline = await runMinimalPolicyTrial({ input: fixture().input, selection: fixture().selection, out: join(directory, "injected-offline.json") }, undefined, () => ({ control: count(), comparison: count(), judge: count() }));
    expect(injectedOffline).toMatchObject({ status: "prepared", execution_mode: "injected", comparison_valid: false });
    expect(offlineInvokes).toBe(0);
    const offline = await runMinimalPolicyTrial({ input: fixture().input, selection: fixture().selection, out: join(directory, "offline.json") });
    expect(offline.results).toHaveLength(120);
    expect(offline).toMatchObject({ status: "prepared", comparison_valid: false, execution_mode: "prepared" });
    expect(offline.results.every((row) => row.answer_call === null && row.judge_call === null && row.correct === null && row.answer === null)).toBe(true);
    expect(offline.summary.by_arm.control.accuracy).toBeNull();
    expect(offline.summary.by_arm.control.planned).toBe(60);
    expect(readFileSync(join(directory, "offline.json.calls.jsonl"), "utf8")).toBe("");
    await expect(runMinimalPolicyTrial({ input: fixture().input, selection: fixture().selection, out: join(directory, "over.json"), live: true, concurrency: 4 })).rejects.toThrow("Concurrency must be 1 through 3");
  });

  it("parses CLI arguments and runs the no-live entry point through an absolute symlink", () => {
    expect(parseMinimalPolicyTrialArgs(["--input", "i.json", "--selection", "s.json", "--out", "o.json", "--concurrency", "2"])).toEqual({ input: "i.json", selection: "s.json", out: "o.json", concurrency: 2, live: false });
    expect(parseMinimalPolicyTrialArgs(["--live", "--input", "i.json", "--selection", "s.json", "--out", "o.json"]).live).toBe(true);
    expect(() => parseMinimalPolicyTrialArgs(["--input", "i.json"])).toThrow("--input, --selection and --out are required");
    expect(() => parseMinimalPolicyTrialArgs(["--nope", "x"])).toThrow("Unknown or missing argument");
    const directory = temp(), { input, selection } = fixture(), inputPath = join(directory, "input.json"), selectionPath = join(directory, "selection.json"), out = join(directory, "report.json");
    writeFileSync(inputPath, JSON.stringify(input)); writeFileSync(selectionPath, JSON.stringify({ ...selection, input_sha256: sha256(readFileSync(inputPath)) }));
    const runner = fileURLToPath(new URL("../benchmark/longmemeval-minimal-policy-trial.ts", import.meta.url)), alias = join(directory, "trial.ts"); symlinkSync(runner, alias);
    expect(realpathSync(alias)).toBe(realpathSync(runner));
    const child = spawnSync(process.execPath, ["--import", "tsx", alias, "--input", inputPath, "--selection", selectionPath, "--out", out], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
    expect(child.status).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8")) as { results: { base_prompt_sha256: string }[]; status: string; execution_mode: string; input_sha256: { kind: string; sha256: string }; comparison_valid: boolean };
    expect(report.results).toHaveLength(120); expect(report.status).toBe("prepared"); expect(report.execution_mode).toBe("prepared");
    expect(report.input_sha256).toEqual({ kind: "raw_bytes", sha256: sha256(readFileSync(inputPath)) });
    expect(readFileSync(`${out}.calls.jsonl`, "utf8")).toBe("");
    const live = spawnSync(process.execPath, ["--import", "tsx", alias, "--input", inputPath, "--selection", selectionPath, "--out", join(directory, "live.json"), "--live"], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, env: { DGX_BASE_URL: "http://127.0.0.1:4011/v1", DGX_KEY_FILE: join(directory, "missing-token") } });
    expect(live.status).not.toBe(0);
    expect((JSON.parse(readFileSync(join(directory, "live.json"), "utf8")) as { status: string; execution_mode: string; comparison_valid: boolean; setup_error?: string }).setup_error).toBeDefined();
  });
});

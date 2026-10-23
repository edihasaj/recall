import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sha256, type Call, type ModelCall } from "../benchmark/longmemeval-qa-support.js";
import { canonicalInferenceJson, INFERENCE_TRIAL_CONFIGS, runInferenceTrial } from "../benchmark/longmemeval-inference-trial.js";
import type { ContextReplayInput } from "../benchmark/longmemeval-context-replay-input.js";
import { COMPARISON_INSTRUCTIONS } from "../benchmark/longmemeval-answer-comparison.js";

const temp = () => mkdtempSync(join(tmpdir(), "recall-inference-trial-"));
const response = (text: string | null, error: string | null = null): Call => ({ text, error, attempts: 1, elapsed_ms: 1, model: "stub", usage: { total_tokens: 1 }, prompt_sha256: "stub" });
function fixture(): { input: ContextReplayInput; selection: { development_ids: string[]; selected_review_ids: string[]; input_sha256: string; mask_seed: number } } {
  const types = ["knowledge-update", "multi-session", "single-session-assistant", "single-session-preference", "single-session-user", "temporal-reasoning"];
  const cases = Array.from({ length: 60 }, (_, index) => {
    const question_id = `q${String(index).padStart(2, "0")}`, question = `Question ${index}?`, context = `Recall-only evidence ${index}.`;
    return {
      index, question_id, question_type: types[Math.floor(index / 10)]!, is_abstention: false,
      generation: { question, answer_prompt_prefix: `Answer only from evidence.\nQuestion: ${question}\nQuestion Date: 2026/01/01\n\nRetrieved Context:\n__RECALL_CONTEXT__` },
      judge_case: { question_id, question_type: types[Math.floor(index / 10)]!, is_abstention: false, question, question_date: "2026/01/01", reference: `REFERENCE-${index}`, gold_session_ids: [`GOLD-${index}`], answer_prompt_prefix: "unused __RECALL_CONTEXT__", judge_prompt_template: `Reference: REFERENCE-${index}\nCandidate: __RECALL_CANDIDATE__`, sessions: [] },
      sides: {
        recall: { name: "recall" as const, context, context_sha256: sha256(context), context_utf16_chars: context.length, replacements: [] },
        hindsight: { name: "hindsight" as const, context: "HINDSIGHT-MUST-NOT-APPEAR", context_sha256: sha256("HINDSIGHT-MUST-NOT-APPEAR"), context_utf16_chars: 26, replacements: [] },
      },
    };
  });
  const input = { selected_question_ids: cases.map((item) => item.question_id), cases, source_canonical_sha256: {}, generation_blinding: "fixture" };
  return { input, selection: { development_ids: input.selected_question_ids, selected_review_ids: input.selected_question_ids.slice(0, 17), input_sha256: sha256(canonicalInferenceJson(input)), mask_seed: 20261022 } };
}
function calls(onCall?: (name: string, kind: string, prompt: string) => void | Promise<void>) {
  const make = (name: string): ModelCall => async (kind, prompt) => {
    await onCall?.(name, kind, prompt);
    return kind === "judge" ? response('{"correct":true,"reason":"ok"}') : response(`{"reasoning":"${name}","answer":"${name} final"}`);
  };
  return { control: make("control"), draftA: make("draftA"), draftB: make("draftB"), arbiter: make("arbiter"), judge: make("judge") };
}

describe("LongMemEval inference trial", () => {
  it("runs 120 counterbalanced arms with 360 physical calls, isolated judges, and identical Recall evidence", async () => {
    const seen: Array<[string, string, string]> = [], active = { value: 0, max: 0 };
    const map = calls(async (name, kind, prompt) => {
      active.value++; active.max = Math.max(active.max, active.value); await new Promise((resolve) => setTimeout(resolve, 1)); active.value--;
      seen.push([name, kind, prompt]);
    });
    const out = join(temp(), "report.json");
    const report = await runInferenceTrial({ input: fixture().input, selection: fixture().selection, out, live: true, concurrency: 3 }, map);
    expect(report.results).toHaveLength(120);
    expect(seen).toHaveLength(360);
    expect(active.max).toBeLessThanOrEqual(3);
    expect(report.results.map((row) => [row.case_index, row.arm]).slice(0, 4)).toEqual([[0, "control"], [0, "comparison"], [1, "comparison"], [1, "control"]]);
    expect(report.summary.by_arm).toMatchObject({ control: { planned: 60, correct: 60 }, comparison: { planned: 60, correct: 60 } });
    expect(Object.values(report.summary.categories).every((value: any) => value.control.planned === 10 && value.comparison.planned === 10)).toBe(true);
    expect(seen.filter(([name]) => name === "judge").every(([, , prompt]) => prompt.includes("final") && !prompt.includes("Recall-only evidence"))).toBe(true);
    expect(seen.filter(([, , prompt]) => prompt.includes("HINDSIGHT-MUST-NOT-APPEAR"))).toHaveLength(0);
    const journal = readFileSync(`${out}.calls.jsonl`, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { stage: string; kind: string; prompt_sha256: string; call: Call });
    expect(journal).toHaveLength(360);
    expect(journal.filter((entry) => entry.stage === "draft_a" || entry.stage === "draft_b").every((entry) => entry.kind === "answer")).toBe(true);
    expect(journal.every((entry) => entry.prompt_sha256 === entry.call.prompt_sha256 || entry.call.prompt_sha256 === "stub")).toBe(true);
  });

  it("runs both drafts on comparison failure, skips arbiter and judge, and counts failures", async () => {
    let drafts = 0, arbiters = 0, judges = 0;
    const map = calls((name) => { if (name === "draftA" || name === "draftB") drafts++; if (name === "arbiter") arbiters++; if (name === "judge") judges++; });
    map.draftA = async () => response(null, "request_failed");
    const report = await runInferenceTrial({ input: fixture().input, selection: fixture().selection, out: join(temp(), "failed.json"), live: true }, map);
    expect(drafts).toBe(60);
    expect(arbiters).toBe(0);
    expect(judges).toBe(60);
    expect(report.results.filter((row) => row.arm === "comparison").every((row) => row.correct === false && row.judge_call === null && row.draft_b_call !== null)).toBe(true);
    expect(report.summary.by_arm.comparison).toMatchObject({ planned: 60, correct: 0, errors: 60 });
    expect(report.results.filter((row) => row.arm === "comparison").every((row) => row.draft_errors?.a === "request_failed" && row.draft_errors.b === null)).toBe(true);
  });

  it("uses the fixed native configs through the factory and prepares without calls by default", async () => {
    const paths = temp(), { input, selection } = fixture(); let captured: typeof INFERENCE_TRIAL_CONFIGS | undefined;
    const prepared = await runInferenceTrial({ input, selection, out: join(paths, "prepared.json") }, undefined, () => { throw new Error("factory must not run"); });
    expect(prepared.results).toHaveLength(120);
    expect(prepared.summary.by_arm.control.accuracy).toBeNull();
    expect(prepared.summary.abstention).toMatchObject({ planned: 0 });
    const live = await runInferenceTrial({ input, selection, out: join(paths, "live.json"), live: true }, undefined, (configs) => { captured = configs; return calls(); });
    expect(live).toMatchObject({ execution_mode: "injected", comparison_valid: false });
    expect(captured).toBe(INFERENCE_TRIAL_CONFIGS);
    expect(captured?.control.options).toMatchObject({ reasoningEffort: "adaptive", maxOutputTokens: 16_384, structuredOutput: true });
    expect(captured?.draftA.options).toMatchObject({ reasoningEffort: "low", maxOutputTokens: 8_192 });
    expect(captured?.draftB.options).toMatchObject({ reasoningEffort: "adaptive", maxOutputTokens: 16_384 });
    expect(captured?.draftA.options.answerInstructions).toBe(captured?.control.options.answerInstructions);
    expect(captured?.draftB.options.answerInstructions).toBe(captured?.control.options.answerInstructions);
    expect(captured?.arbiter.options.answerInstructions).toBe(`${captured?.control.options.answerInstructions}\n\n${COMPARISON_INSTRUCTIONS}`);
    expect(captured?.judge.options).toMatchObject({ reasoningEffort: "none", maxOutputTokens: 4_096 });
    expect("answerInstructions" in captured!.judge.options).toBe(false);
  });

  it("reserves all outputs before factories and rejects invalid templates before reservation", async () => {
    const directory = temp(), { input, selection } = fixture(), collision = join(directory, "exists.json");
    writeFileSync(collision, "keep");
    let factories = 0;
    await expect(runInferenceTrial({ input, selection, out: collision, live: true }, undefined, () => { factories++; return calls(); })).rejects.toThrow("Output already exists");
    expect(readFileSync(collision, "utf8")).toBe("keep"); expect(factories).toBe(0);
    input.cases[0]!.judge_case.judge_prompt_template = "invalid";
    const bad = join(directory, "bad.json");
    await expect(runInferenceTrial({ input, selection, out: bad, live: true }, undefined, () => { factories++; return calls(); })).rejects.toThrow("Invalid judge prompt marker");
    expect(existsSync(bad)).toBe(false);
  });

  it("runs the no-live CLI through an absolute symlink and writes 120 prepared rows", () => {
    const directory = temp(), { input, selection } = fixture(), inputPath = join(directory, "input.json"), selectionPath = join(directory, "selection.json"), out = join(directory, "report.json");
    writeFileSync(inputPath, JSON.stringify(input)); writeFileSync(selectionPath, JSON.stringify({ ...selection, input_sha256: sha256(readFileSync(inputPath)) }));
    const runner = fileURLToPath(new URL("../benchmark/longmemeval-inference-trial.ts", import.meta.url)), alias = join(directory, "trial.ts"); symlinkSync(runner, alias);
    const child = spawnSync(process.execPath, ["--import", "tsx", alias, "--input", inputPath, "--selection", selectionPath, "--out", out], { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 });
    expect(child.status).toBe(0); expect(existsSync(out)).toBe(true);
    expect((JSON.parse(readFileSync(out, "utf8")) as { results: unknown[] }).results).toHaveLength(120);
  });
});

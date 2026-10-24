import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CATEGORY_UNION_SENTENCE } from "../benchmark/longmemeval-premise-check.js";
import { sha256, type Call, type ModelCall } from "../benchmark/longmemeval-qa-support.js";
import { deriveCohort, parseTrialArgs, runTrial, trialExitCode, type TrialOptions } from "../benchmark/longmemeval-premise-union-trial.js";

const ABS = 4, ANS = 6;
const makeCases = (answerable = 9) => [
  ...Array.from({ length: ABS }, (_, i) => ({ question_id: `abs${i}_abs`, is_abstention: true })),
  ...Array.from({ length: answerable }, (_, i) => ({ question_id: `ans${i}`, is_abstention: false })),
].map((c) => ({
  ...c, question: `Question QID-${c.question_id}-END about things?`, reference: "REFERENCE_SENTINEL", gold_session_ids: ["gold"],
  answer_prompt_prefix: `Rules.\nQuestion: q\nQuestion Date: 2026-10-01T00:00:00+00:00\n\nRetrieved Context:\n__RECALL_CONTEXT__`,
}));
const call = (text: string | null, error: string | null = null): Call => ({ text, error, attempts: 1, elapsed_ms: 1, model: "stub", usage: null, prompt_sha256: "stub" });

function fixture(mutate?: (cases: ReturnType<typeof makeCases>) => void) {
  const cases = makeCases();
  mutate?.(cases);
  const dir = makeTemp("/tmp/recall-lme-union-trial-");
  const input = join(dir, "input.json"), report = join(dir, "report.json");
  const inputBytes = Buffer.from(JSON.stringify({ cases }));
  const reportBytes = Buffer.from(JSON.stringify({
    results: cases.map((c) => ({ question_id: c.question_id, premise_recorded: !c.is_abstention, draft_answer: "DRAFT", correct: false, evidence: { text: `## Memory 1\nuser: note for ${c.question_id}` } })),
  }));
  writeFileSync(input, inputBytes); writeFileSync(report, reportBytes);
  const options: TrialOptions = {
    report, input, out: join(dir, "out.json"), live: true, concurrency: 3,
    baselineSha: sha256(reportBytes), inputSha: sha256(inputBytes), abstentions: ABS, answerable: ANS,
  };
  return { options, dir };
}

type Verdicts = (id: string, union: boolean) => boolean | "malformed" | "error";
function stub(verdicts: Verdicts, log: { kind: string; id: string; union: boolean }[] = [], gauge = { active: 0, max: 0 }): ModelCall {
  return async (kind, prompt) => {
    const id = /QID-(\w+)-END/.exec(prompt)![1]!, union = prompt.includes(CATEGORY_UNION_SENTENCE);
    log.push({ kind, id, union });
    gauge.active++; gauge.max = Math.max(gauge.max, gauge.active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    gauge.active--;
    const v = verdicts(id, union);
    if (v === "error") return call(null, "request_failed");
    if (v === "malformed") return call("not json");
    return call(JSON.stringify({ correct: v, reason: "r" }));
  };
}
// Control: abstentions rejected (false), answerable accepted (true); treatment identical unless a test overrides it.
const same: Verdicts = (id) => !id.endsWith("_abs");

const tempRoots: string[] = [];
const makeTemp = (prefix: string): string => { const dir = mkdtempSync(prefix); tempRoots.push(dir); return dir; };
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("premise union check-only screen", () => {
  it("derives the cohort from IDs and the abstention flag only", () => {
    const a = deriveCohort(makeCases(), ABS, ANS);
    const b = deriveCohort(makeCases().map((c) => ({ ...c, reference: "X", gold_session_ids: [], question: "different" })), ABS, ANS);
    expect(b).toEqual(a);
    expect(a.abstention_ids).toHaveLength(ABS);
    expect(a.answerable_ids).toHaveLength(ANS);
    expect(new Set(a.selected_question_ids)).toEqual(new Set([...a.abstention_ids, ...a.answerable_ids]));
    expect(() => deriveCohort(makeCases(), ABS + 1, ANS)).toThrow("Cohort count mismatch");
    expect(() => deriveCohort([...makeCases(), { question_id: "ans0", is_abstention: false }], ABS, ANS)).toThrow("Duplicate");
    // Pinned hash order for the real 30/70 rule: a known ID set sorts by SHA256(seed NUL id).
    expect(deriveCohort([{ question_id: "a", is_abstention: true }, { question_id: "b", is_abstention: true }], 2, 0).abstention_ids).toHaveLength(2);
  });

  it("preflight makes no calls, needs no credentials and records prompt hashes only", async () => {
    vi.stubEnv("DGX_BASE_URL", ""); vi.stubEnv("DGX_KEY_FILE", "");
    const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    const { options } = fixture();
    const report = await runTrial({ ...options, live: false });
    expect(report.status).toBe("preflight");
    expect(report.comparison_valid).toBe(false);
    expect(report.summary.gate).toBeNull();
    expect(report.rows).toHaveLength(ABS + ANS);
    expect(report.rows.every((row) => row.status === "preflight" && row.control_prompt_sha256 !== row.treatment_prompt_sha256)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(`${options.out}.jsonl`)).toBe(true);
  });

  it("makes exactly two fresh premise calls per case, counterbalanced, within three pipelines, with no answer or judge calls", async () => {
    const { options } = fixture();
    const log: { kind: string; id: string; union: boolean }[] = [];
    const gauge = { active: 0, max: 0 };
    const report = await runTrial(options, { call: stub(same, log, gauge) });
    expect(log).toHaveLength(2 * (ABS + ANS));
    expect(new Set(log.map((entry) => entry.kind))).toEqual(new Set(["premise"]));
    for (const id of report.cohort.selected_question_ids) expect(log.filter((entry) => entry.id === id).map((entry) => entry.union).sort()).toEqual([false, true]);
    expect(gauge.max).toBeLessThanOrEqual(3);
    const orders = report.rows.map((row) => row.order);
    expect(orders.filter((o) => o === "original_first").length).toBe(Math.ceil(orders.length / 2));
    expect(orders.filter((o) => o === "union_first").length).toBe(Math.floor(orders.length / 2));
    expect(report.status).toBe("complete");
    expect(report.summary.planned).toBe(ABS + ANS);
    expect(report.summary.scored).toBe(ABS + ANS);
    expect(report.judge_calls).toBe(0);
    expect(report.score_output).toBe(false);
    expect(report.comparison_valid).toBe(false);
    // No identical-flip means no recovery: gate cannot pass.
    expect(report.summary.gate).toMatchObject({ all_complete: true, no_abstention_flipped_to_true: true, no_newly_rejected_answerable: true, recovery_candidates_for_source_review: 0, numeric_screen_passed: false, passed: false });
    expect(report.summary.usage).toMatchObject({ calls: 2 * (ABS + ANS), attempts: 2 * (ABS + ANS), http_retries: 0, unknown_usage_calls: 2 * (ABS + ANS), call_errors: 0, fallbacks: 0 });
    for (const row of report.rows) {
      expect(sha256(row.control_prompt)).toBe(row.control_prompt_sha256);
      expect(sha256(row.treatment_prompt)).toBe(row.treatment_prompt_sha256);
      expect(row.treatment_prompt).toContain(CATEGORY_UNION_SENTENCE);
      expect(row.control_prompt).not.toContain(CATEGORY_UNION_SENTENCE);
    }
    const lines = readFileSync(`${options.out}.jsonl`, "utf8").trim().split("\n");
    expect(lines).toHaveLength(ABS + ANS);
    for (const line of lines) {
      const row = JSON.parse(line) as { control: { prompt_sha256: string }; treatment: { prompt_sha256: string }; control_prompt_sha256: string; treatment_prompt_sha256: string };
      expect(row.control.prompt_sha256).toBe(row.control_prompt_sha256);
      expect(row.treatment.prompt_sha256).toBe(row.treatment_prompt_sha256);
    }
  });

  it("passes the numerical gate only for a clean recovery with no abstention or answerable regressions", async () => {
    const pickAnswerable = (report: Awaited<ReturnType<typeof runTrial>>) => report.cohort.answerable_ids[0]!;
    const first = fixture();
    const probe = await runTrial({ ...first.options, live: false });
    const target = pickAnswerable(probe);
    // Control rejects the target; treatment accepts it.
    const recovery: Verdicts = (id, union) => id === target ? union : same(id, union);
    const ok = await runTrial(fixture().options, { call: stub(recovery) });
    expect(ok.summary.answerable_false_to_true).toEqual([target]);
    // Injected calls and overridden inputs are never comparison-valid, so the numeric screen can pass but the gate cannot.
    expect(ok.summary.gate).toMatchObject({ numeric_screen_passed: true, comparison_valid: false, passed: false, source_review_pending: true, recovery_candidates_for_source_review: 1 });
    expect(ok.summary.drafts_retained_diagnostic).toBeGreaterThan(0);

    const absId = ok.cohort.abstention_ids[0]!;
    const absFlip = await runTrial(fixture().options, { call: stub((id, union) => id === absId ? union : recovery(id, union)) });
    expect(absFlip.summary.abstention_false_to_true).toEqual([absId]);
    expect(absFlip.summary.gate).toMatchObject({ no_abstention_flipped_to_true: false, numeric_screen_passed: false, passed: false });

    const other = ok.cohort.answerable_ids[1]!;
    const newlyRejected = await runTrial(fixture().options, { call: stub((id, union) => id === other ? !union ? true : false : recovery(id, union)) });
    expect(newlyRejected.summary.answerable_true_to_false).toEqual([other]);
    expect(newlyRejected.summary.gate).toMatchObject({ no_newly_rejected_answerable: false, numeric_screen_passed: false, passed: false });
  });

  it("fails closed on malformed or errored checks and never calls a judge", async () => {
    for (const bad of ["malformed", "error"] as const) {
      const { options } = fixture();
      const log: { kind: string; id: string; union: boolean }[] = [];
      const target = (await runTrial({ ...fixture().options, live: false })).cohort.answerable_ids[0]!;
      const report = await runTrial(options, { call: stub((id, union) => id === target && union ? bad : same(id, union), log) });
      expect(report.status).toBe("failed");
      expect(report.summary.errors).toBe(1);
      expect(report.summary.scored).toBe(ABS + ANS - 1);
      expect(report.summary.planned).toBe(ABS + ANS);
      expect(report.summary.gate).toMatchObject({ all_complete: false, passed: false });
      expect(log.every((entry) => entry.kind === "premise")).toBe(true);
    }
  });

  it("rejects wrong pinned hashes, bad concurrency and existing outputs before any call", async () => {
    let calls = 0;
    const counting: ModelCall = async () => { calls++; return call("{}"); };
    const { options } = fixture();
    await expect(runTrial({ ...options, baselineSha: "0".repeat(64) }, { call: counting })).rejects.toThrow("not the pinned baseline");
    await expect(runTrial({ ...options, inputSha: "0".repeat(64) }, { call: counting })).rejects.toThrow("not the pinned input");
    await expect(runTrial({ ...options, concurrency: 4 }, { call: counting })).rejects.toThrow("Concurrency");
    await expect(runTrial({ ...options, concurrency: 0 }, { call: counting })).rejects.toThrow("Concurrency");
    writeFileSync(options.out, "x");
    await expect(runTrial(options, { call: counting })).rejects.toThrow("Output already exists");
    expect(calls).toBe(0);
    // The default pinned hashes reject a synthetic fixture.
    await expect(runTrial({ ...options, out: `${options.out}.2`, baselineSha: undefined }, { call: counting })).rejects.toThrow("not the pinned baseline");
  });

  it("sends the unchanged native premise request for both policies", async () => {
    const keyFile = join(makeTemp("/tmp/recall-lme-union-key-"), "key");
    writeFileSync(keyFile, "test-token\n");
    vi.stubEnv("DGX_BASE_URL", "http://127.0.0.1:9/v1");
    vi.stubEnv("DGX_KEY_FILE", keyFile);
    const bodies: { reasoning: { effort: string }; max_output_tokens: number; input: { content: string }[]; text: { format: { name: string; strict: boolean } } }[] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ status: "completed", output_text: '{"correct":true,"reason":"ok"}' }));
    });
    const { options } = fixture();
    const report = await runTrial({ ...options, concurrency: 1 }, { fetcher });
    expect(report.status).toBe("complete");
    expect(report.comparison_valid).toBe(false);
    expect(bodies).toHaveLength(2 * (ABS + ANS));
    expect(new Set(bodies.map((b) => `${b.reasoning.effort}|${b.max_output_tokens}|${b.text.format.name}|${b.text.format.strict}`))).toEqual(new Set(["low|4096|benchmark_premise|true"]));
    expect(bodies.filter((b) => b.input[1]!.content.includes(CATEGORY_UNION_SENTENCE))).toHaveLength(ABS + ANS);
    for (const body of bodies) expect(body.input[1]!.content).not.toMatch(/REFERENCE_SENTINEL|DRAFT|gold/);
  });

  it("parses trial arguments", () => {
    expect(parseTrialArgs(["--report", "r", "--input", "i", "--out", "o"])).toMatchObject({ live: false, concurrency: 3 });
    expect(parseTrialArgs(["--report", "r", "--input", "i", "--out", "o", "--live", "--concurrency", "2"])).toMatchObject({ live: true, concurrency: 2 });
    expect(() => parseTrialArgs(["--report", "r"])).toThrow("required");
    expect(() => parseTrialArgs(["--bogus", "x"])).toThrow("Unknown");
  });
  it("journals every logical call at start and finish, keeps the first call when the second throws, and records thrown calls", async () => {
    const probe = await runTrial({ ...fixture().options, live: false });
    const target = probe.cohort.answerable_ids[0]!;
    const { options } = fixture();
    const thrower: ModelCall = async (kind, prompt) => {
      const id = /QID-(\w+)-END/.exec(prompt)![1]!;
      if (id === target && prompt.includes(CATEGORY_UNION_SENTENCE)) throw new Error("socket exploded");
      return call(JSON.stringify({ correct: !id.endsWith("_abs"), reason: "r" }), null);
    };
    const report = await runTrial({ ...options, concurrency: 1 }, { call: thrower });
    const entries = readFileSync(`${options.out}.calls.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    expect(entries.filter((e) => e.event === "start")).toHaveLength(2 * (ABS + ANS));
    expect(entries.filter((e) => e.event === "finish")).toHaveLength(2 * (ABS + ANS));
    for (const e of entries.filter((x) => x.event === "start")) expect(sha256(e.prompt)).toBe(e.prompt_sha256);
    const mine = entries.filter((e) => e.question_id === target && e.event === "finish");
    expect(mine).toHaveLength(2);
    expect(mine.map((e) => e.call.error).filter(Boolean)).toEqual([expect.stringMatching(/^call_threw:/)]);
    expect(mine.some((e) => e.recorded !== null)).toBe(true);
    // Each start precedes its own finish in the journal.
    for (const e of entries.filter((x) => x.event === "finish")) {
      const startAt = entries.findIndex((x) => x.event === "start" && x.index === e.index && x.position === e.position);
      expect(startAt).toBeGreaterThanOrEqual(0);
      expect(startAt).toBeLessThan(entries.indexOf(e));
    }
    expect(report.status).toBe("failed");
    expect(report.summary.usage).toMatchObject({ calls: 2 * (ABS + ANS), thrown_calls: 1, call_errors: 1, malformed_checks: 0 });
    expect(report.summary.errored_rows).toBe(1);
    expect(report.summary.scored).toBe(ABS + ANS - 1);
    expect(trialExitCode(report)).toBe(1);
  });

  it("exits zero for a completed screen even when its numeric gate fails, and nonzero only for failed", async () => {
    const complete = await runTrial(fixture().options, { call: stub(same) });
    expect(complete.summary.gate?.numeric_screen_passed).toBe(false);
    expect(trialExitCode(complete)).toBe(0);
    expect(trialExitCode({ status: "preflight" })).toBe(0);
    expect(trialExitCode({ status: "failed" })).toBe(1);
  });

  it("reads credentials only after every output path is reserved, and records the failure", async () => {
    vi.stubEnv("DGX_BASE_URL", ""); vi.stubEnv("DGX_KEY_FILE", "");
    const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    const { options } = fixture();
    await expect(runTrial(options)).rejects.toThrow();
    for (const suffix of ["", ".jsonl", ".calls.jsonl"]) expect(existsSync(`${options.out}${suffix}`)).toBe(true);
    expect(JSON.parse(readFileSync(options.out, "utf8"))).toMatchObject({ status: "failed", rows: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
    // A pinned-hash failure happens before any output is reserved.
    const early = fixture().options;
    await expect(runTrial({ ...early, baselineSha: "0".repeat(64) })).rejects.toThrow("not the pinned baseline");
    expect(existsSync(early.out)).toBe(false);
  });

  it("requires the canonical 500-question schema before any call when no cohort override is given", async () => {
    let calls = 0;
    const { options } = fixture();
    const canonicalOptions: TrialOptions = { ...options, abstentions: undefined, answerable: undefined };
    await expect(runTrial(canonicalOptions, { call: async () => { calls++; return call("{}"); } })).rejects.toThrow(/same 500 questions/);
    expect(calls).toBe(0);
    expect(existsSync(options.out)).toBe(false);
  });

  it("hashes the imported transport, support and inference files and never marks overrides comparison-valid", async () => {
    const report = await runTrial(fixture().options, { call: stub(same) });
    const paths = Object.keys(report.hashes.code);
    for (const name of ["longmemeval-qa-support.ts", "longmemeval-qa-transport.ts", "longmemeval-inference-policy.ts", "longmemeval-premise-check.ts"]) {
      expect(paths.some((path) => path.endsWith(name))).toBe(true);
    }
    for (const [path, hash] of Object.entries(report.hashes.code)) expect(hash).toBe(sha256(readFileSync(path)));
    expect(report.comparison_valid).toBe(false);
    expect(report.selection_note).toMatch(/abstention-flag safety stratum/);
  });
  it("classifies usage per final call and counts unknown prior HTTP attempts", async () => {
    const { options } = fixture((cases) => { cases.splice(0, cases.length, ...cases.filter((c) => c.question_id === "abs0_abs" || c.question_id === "ans0")); });
    const usages: (Call["usage"] | undefined)[] = [
      { input_tokens: 100, output_tokens: 20 }, { input_tokens: 100 }, undefined, null,
    ];
    let n = 0;
    const sequence: ModelCall = async () => {
      const i = n++;
      return { ...call(JSON.stringify({ correct: true, reason: "r" })), attempts: i === 0 ? 2 : 1, usage: usages[i] as Call["usage"] };
    };
    const report = await runTrial({ ...options, abstentions: 1, answerable: 1, concurrency: 1 }, { call: sequence });
    expect(report.summary.usage).toMatchObject({
      calls: 4, attempts: 5, unknown_usage_calls: 3, prior_http_attempts_unknown_usage: 1,
      usage_complete: false, observed_totals_are_lower_bounds: true, input_tokens_known: 200, output_tokens_known: 20,
    });
    // Original call fields are preserved on the rows.
    expect(report.rows[0].control.call.usage ?? report.rows[0].treatment.call.usage).toBeDefined();
    const complete = await runTrial({ ...fixture((cases) => { cases.splice(0, cases.length, ...cases.filter((c) => c.question_id === "abs0_abs" || c.question_id === "ans0")); }).options, abstentions: 1, answerable: 1 },
      { call: async () => ({ ...call(JSON.stringify({ correct: true, reason: "r" })), usage: { input_tokens: 5, output_tokens: 1 } }) });
    expect(complete.summary.usage).toMatchObject({ unknown_usage_calls: 0, prior_http_attempts_unknown_usage: 0, usage_complete: true, observed_totals_are_lower_bounds: false });
  });

  it("counts malformed checks per call, not per errored row, and never labels HTTP failures malformed", async () => {
    const { options } = fixture((cases) => { cases.splice(0, cases.length, ...cases.filter((c) => c.question_id === "abs0_abs" || c.question_id === "ans0")); });
    const outcomes = [call("not json"), call("{}"), call(null, "request_failed"), call(JSON.stringify({ correct: true, reason: "r" }))];
    let n = 0;
    const report = await runTrial({ ...options, abstentions: 1, answerable: 1, concurrency: 1 }, { call: async () => outcomes[n++]! });
    expect(report.summary.usage).toMatchObject({ calls: 4, malformed_checks: 2, call_errors: 1, thrown_calls: 0 });
    expect(report.summary.errored_rows).toBe(2);
    expect(report.summary.errors).toBe(2);
    expect(report.status).toBe("failed");
  });
});

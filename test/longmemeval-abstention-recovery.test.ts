import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildModelCall, parseArgs, runReplay, summarizeReplay, usageSummary, validateBaseline, ANSWER_INSTRUCTIONS, REPLAY,
  type BaselineReport, type JournalEntry, type ReplayRow,
} from "../benchmark/longmemeval-abstention-recovery.js";
import { HISTORY_EVIDENCE_POLICY } from "../src/history/evidence-policy.js";
import { SCOPE_REVIEW_INSTRUCTION, SCOPE_REVIEW_INSTRUCTION_SHA256 } from "../benchmark/longmemeval-recovery-scope.js";
import { buildSupplementalEvidence } from "../benchmark/longmemeval-supplemental-evidence.js";
import { MINIMAL_ANSWER_POLICY } from "../benchmark/longmemeval-minimal-answer-policy.js";
import { questionSourcesHash } from "../benchmark/longmemeval-source-identity.js";
import { cachedRank, sha256, type Call, type Case, type ModelCall } from "../benchmark/longmemeval-qa-support.js";

const question = "Which pottery glaze does Nila prefer?";
// [override, abstention, baseline correct]. Selection must depend only on the override flag.
const CONFIG: [boolean, boolean, boolean][] = [[true, true, true], [true, false, false], [false, false, true], [true, false, true], [false, true, true]];
const SELECTED = ["case-0", "case-1", "case-3"];
const SAVED_ENV = { key: process.env.DGX_KEY_FILE, base: process.env.DGX_BASE_URL };

afterEach(() => {
  for (const [name, value] of [["DGX_KEY_FILE", SAVED_ENV.key], ["DGX_BASE_URL", SAVED_ENV.base]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

function fixture(matching: number[] = [20, 21]) {
  const dir = mkdtempSync(join(tmpdir(), "recall-lme-abstention-"));
  const cases: Case[] = CONFIG.map(([, abstention], i) => ({
    question_id: `case-${i}`, question_type: "single-session-user", is_abstention: abstention, question, question_date: "2026/10/20",
    reference: `REFSENTINEL-${i}`, gold_session_ids: [`answer_GOLD_${i}`],
    answer_prompt_prefix: `Task rules.\n\nQuestion: ${question}\nQuestion Date: 2026/10/20\n\nRetrieved Context:\n__RECALL_CONTEXT__`,
    judge_prompt_template: `Reference: REFSENTINEL-${i}\nCandidate: __RECALL_CANDIDATE__`,
    sessions: Array.from({ length: 24 }, (_, n) => ({
      id: n === 20 ? `answer_GOLD_${i}` : `opaque-source-${i}-${n}`, date: `2026/10/${String(n + 1).padStart(2, "0")} (Mon) 09:30`,
      text: n < 18 ? `user: Nila prefers pottery glaze option ${n}.`
        : matching.includes(n) ? `user: Nila chose a pottery glaze ${n}.` : `assistant: zebra quartz lantern ${n}.`,
    })),
  }));
  const ids = (c: Case) => c.sessions.slice(0, 20).map((s) => s.id);
  const input = join(dir, "input.json"), rankings = join(dir, "rankings.json"), baselinePath = join(dir, "baseline.json");
  writeFileSync(input, JSON.stringify({ provenance: { dataset_sha256: "d" }, cases }));
  writeFileSync(rankings, JSON.stringify({ status: "complete", dataset_sha256: "d", results: cases.map((c) => ({
    question_id: c.question_id, retrieved_session_ids: ids(c), retrieved_session_occurrences: Array.from({ length: 20 }, (_, n) => n),
    source_sha256: questionSourcesHash(c.question, c.sessions),
  })) }));
  const baseline: BaselineReport = {
    status: "complete", comparison_valid: true,
    hashes: { input: sha256(readFileSync(input)), rankings: sha256(readFileSync(rankings)) },
    invocation: { retrieval: "cached", topK: 20, contextChars: 180000, evidence: "supplemental", evidencePolicy: "system", answerPolicy: "minimal",
      answerCheck: "premise", answerRecovery: "longer-timeout-transport", provider: "qwen-local", requestMode: "robust", reasoningEffort: "adaptive" },
    generation_blinding: "neutral labels", summary: { planned: 5, recorded: 5, errors: 0 },
    results: cases.map((c, i) => ({
      question_id: c.question_id, is_abstention: c.is_abstention, correct: CONFIG[i]![2], error: null, premise_override: CONFIG[i]![0],
      draft_answer: `Draft answer ${i}`, answer: CONFIG[i]![0] ? "Not recorded in the conversation." : `Answer ${i}`,
      evidence: { text: buildSupplementalEvidence(cachedRank(c.sessions, ids(c), 20, Array.from({ length: 20 }, (_, n) => n)), question, REPLAY.contextChars, false).text },
    })),
  };
  writeFileSync(baselinePath, JSON.stringify(baseline));
  let n = 0;
  const opts = () => ({ baseline: baselinePath, input, rankings, out: join(dir, `report-${n++}.json`), live: false, concurrency: 3, expectedQuestions: 5 });
  return { dir, cases, baseline, opts };
}

const reply = (text: string, error: string | null = null): Call => ({ text, error, attempts: 1, elapsed_ms: 1, model: "stub", usage: { input_tokens: 3, output_tokens: 2 }, prompt_sha256: "stub" });
const ok = (judge = true): ModelCall => async (kind) => reply(kind === "judge" ? JSON.stringify({ correct: judge, reason: "r" }) : JSON.stringify({ reasoning: "r", answer: "Reviewed answer" }));

describe("review policy", () => {
  const capture = async (reviewPolicy?: "original" | "scope") => {
    const prompts: string[] = [];
    const o = { ...fixture().opts(), live: true, reviewPolicy };
    const report = await runReplay(o, async (kind, prompt, meta) => {
      if (kind === "answer") prompts.push(prompt);
      return ok()(kind, prompt, meta);
    });
    return { prompts, report: report as unknown as { review_policy: unknown; results: ReplayRow[]; comparison_valid: boolean } };
  };

  it("default and explicit original policy send identical review prompts and record no instruction", async () => {
    const implicit = await capture(), explicit = await capture("original");
    expect([...implicit.prompts].sort()).toEqual([...explicit.prompts].sort());
    expect(implicit.report.review_policy).toEqual({ name: "original", instruction_sha256: null });
    for (const row of implicit.report.results) {
      expect(row).toMatchObject({ review_policy: "original", review_instruction_sha256: null });
      expect(implicit.prompts.map(sha256)).toContain(row.review_prompt_sha256);
    }
    for (const prompt of implicit.prompts) expect(prompt).not.toContain(SCOPE_REVIEW_INSTRUCTION);
  });

  it("scope policy changes the generation prompt that is actually sent and records policy and instruction hash", async () => {
    const base = await capture("original"), scope = await capture("scope");
    expect(scope.report.review_policy).toEqual({ name: "scope", instruction_sha256: SCOPE_REVIEW_INSTRUCTION_SHA256 });
    expect(scope.report.comparison_valid).toBe(false);
    expect(scope.prompts).toHaveLength(base.prompts.length);
    for (const prompt of scope.prompts) expect(prompt.split(SCOPE_REVIEW_INSTRUCTION)).toHaveLength(2);
    for (const row of scope.report.results) {
      expect(row).toMatchObject({ review_policy: "scope", review_instruction_sha256: SCOPE_REVIEW_INSTRUCTION_SHA256 });
      expect(scope.prompts.map(sha256)).toContain(row.review_prompt_sha256);
      expect(base.prompts.map(sha256)).not.toContain(row.review_prompt_sha256);
    }
    // Source refresh, drafts and evidence are identical between policies; only the review prompt differs.
    base.report.results.forEach((row, i) => {
      const other = scope.report.results[i]!;
      expect(other.evidence!.text).toBe(row.evidence!.text);
      expect(other.draft_answer).toBe(row.draft_answer);
      expect(other.source_changes).toEqual(row.source_changes);
    });
  });

  it("keeps native model configuration identical across policies and rejects unknown policies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-lme-policy-key-"));
    writeFileSync(join(dir, "token"), "t\n");
    process.env.DGX_KEY_FILE = join(dir, "token");
    process.env.DGX_BASE_URL = "http://127.0.0.1:9/v1";
    const call = buildModelCall(async () => Response.json({ status: "completed", output_text: "{}", usage: { input_tokens: 1, output_tokens: 1 } }));
    expect((await call("answer", "p")).request_config).toEqual({ reasoning_effort: "medium", max_output_tokens: 8192 });
    const args = ["--baseline", "b", "--input", "i", "--rankings", "r", "--out", "o"];
    expect(parseArgs(args).reviewPolicy).toBe("original");
    expect(parseArgs([...args, "--review-policy", "scope"]).reviewPolicy).toBe("scope");
    expect(() => parseArgs([...args, "--review-policy", "creative"])).toThrow(/Invalid review policy/);
    await expect(runReplay({ ...fixture().opts(), reviewPolicy: "creative" as never })).rejects.toThrow(/Invalid review policy/);
  });
});

describe("abstention recovery replay", () => {
  it("prepares offline without credentials and selects every override row regardless of correctness", async () => {
    process.env.DGX_KEY_FILE = join(tmpdir(), "does-not-exist-token");
    delete process.env.DGX_BASE_URL;
    const o = fixture().opts();
    const report = await runReplay(o);
    expect(report.status).toBe("prepared");
    expect(report.comparison_valid).toBe(false);
    expect(report.results.map((r) => r.question_id)).toEqual(SELECTED);
    expect(report.results.map((r) => r.baseline_correct)).toEqual([true, false, true]);
    expect(existsSync(`${o.out}.jsonl`) || existsSync(`${o.out}.journal.jsonl`)).toBe(false);
  });

  it("keeps the first 18 exact occurrences, adds two lexical sources and records scorer-side diagnostics", async () => {
    const report = await runReplay(fixture().opts());
    for (const row of report.results as ReplayRow[]) {
      expect(row.source_changes!.retained_occurrences).toEqual(Array.from({ length: 18 }, (_, n) => n));
      expect([...row.source_changes!.lexical_tail_selections].sort()).toEqual([20, 21]);
      expect([...row.source_changes!.added_occurrences].sort()).toEqual([20, 21]);
      expect(row.source_changes!.dropped_occurrences).toEqual([18, 19]);
      expect(row.gold_coverage).toEqual({ baseline: { any: false, all: false }, refreshed: { any: true, all: true } });
      expect(row.review_prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("fails closed before any call when the lexical reserve cannot supply two sources", async () => {
    const f = fixture([]);
    const prepared = await runReplay(f.opts());
    expect(prepared.status).toBe("prepare_failed");
    expect(prepared.results.every((r) => r.error === "lexical_reserve_insufficient")).toBe(true);
    let calls = 0;
    const o = { ...f.opts(), live: true };
    await expect(runReplay(o, async (...a) => { calls++; return ok()(...a); })).rejects.toThrow(/Preparation failed/);
    expect(calls).toBe(0);
    expect(existsSync(o.out)).toBe(false);
  });

  it("never shows gold, reference, IDs or abstention text to the reviewer; only the judge sees the reference", async () => {
    const prompts: { kind: string; prompt: string }[] = [];
    const o = { ...fixture().opts(), live: true };
    const report = await runReplay(o, async (kind, prompt, meta) => { prompts.push({ kind, prompt }); return ok()(kind, prompt, meta); });
    const review = prompts.filter((p) => p.kind === "answer"), judge = prompts.filter((p) => p.kind === "judge");
    expect([review.length, judge.length]).toEqual([3, 3]);
    for (const { prompt } of review) {
      for (const secret of ["REFSENTINEL", "answer_GOLD", "case-", "opaque-source", "Not recorded in the conversation", "is_abstention"]) expect(prompt).not.toContain(secret);
      expect(prompt).toMatch(/Draft answer \d/);
    }
    expect(judge.every((p) => p.prompt.includes("REFSENTINEL") && p.prompt.includes("Reviewed answer"))).toBe(true);
    expect(report.comparison_valid).toBe(false); // injected calls are never benchmark evidence
    expect(report.mode).toBe("injected_test");
    const journal = readFileSync(`${o.out}.journal.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line) as JournalEntry);
    expect(journal).toHaveLength(12);
    expect(journal.filter((e) => e.event === "start")).toHaveLength(6);
    for (const e of journal) if (e.event === "finish") expect(journal[e.start_seq]).toMatchObject({ event: "start", kind: e.kind });
    expect((report as unknown as { usage: Record<string, unknown> }).usage).toMatchObject({
      logical_calls_started: 6, logical_calls_finished: 6, logical_calls_unfinished: 0, http_attempts: 6, usage_complete: true,
    });
    expect(readFileSync(`${o.out}.jsonl`, "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("does not credit malformed or failed reviews and judges, and keeps the denominator", async () => {
    const call: ModelCall = async (kind, prompt) => {
      if (kind === "answer") return prompt.includes("Draft answer 0") ? reply("not json") : reply(JSON.stringify({ reasoning: "r", answer: "A" }));
      if (prompt.includes("Candidate: A")) return reply(null as unknown as string, "timeout");
      return reply(JSON.stringify({ correct: true, reason: "r" }));
    };
    const o = { ...fixture().opts(), live: true };
    const report = await runReplay(o, call);
    if (!("summary" in report) || !("trial_status" in report)) throw new Error("expected live report");
    const byId = Object.fromEntries((report.results as ReplayRow[]).map((r) => [r.question_id, r]));
    expect(byId["case-0"]!.error).toBe("malformed_review");
    expect(byId["case-1"]!.error).toBe("judge_timeout");
    expect(byId["case-0"]!.replay_correct).toBeNull();
    expect(byId["case-1"]!.replay_correct).toBeNull();
    expect(report.summary).toMatchObject({ status: "incomplete", advancement_screen_passed: false, errors: 3, planned: 5 });
    expect(report.summary.failed_replay_ids).toEqual(SELECTED);
    expect(report.summary.selected_without_correct_verdict).toEqual(SELECTED);
    // Failed selected rows count incorrect: the two historically correct ones are not credited.
    expect(report.summary.mixed_correct).toBe(report.summary.baseline_correct - 2);
    expect(report.comparison_valid).toBe(false);
  });

  it("refuses to reuse or overwrite an output path and bounds concurrency", async () => {
    const f = fixture();
    const o = { ...f.opts(), live: true };
    await runReplay(o, ok());
    const before = readFileSync(o.out, "utf8");
    await expect(runReplay(o, ok())).rejects.toThrow(/Output already exists/);
    expect(readFileSync(o.out, "utf8")).toBe(before);
    await expect(runReplay({ ...f.opts(), concurrency: 4 })).rejects.toThrow(/Concurrency/);
    writeFileSync(`${f.opts().out}.journal.jsonl`.replace(/report-\d+/, "report-9"), "");
    await expect(runReplay({ ...f.opts(), out: join(f.dir, "report-9.json") })).rejects.toThrow(/Output already exists/);
    // The progress sidecar is reserved too, so a stray progress file blocks a run before any call.
    writeFileSync(join(f.dir, "report-8.json.progress.json"), "");
    let calls = 0;
    await expect(runReplay({ ...f.opts(), out: join(f.dir, "report-8.json"), live: true }, async (...a) => { calls++; return ok()(...a); })).rejects.toThrow(/Output already exists/);
    expect(calls).toBe(0);
    expect(existsSync(join(f.dir, "report-8.json"))).toBe(false);
  });

  it("rejects non-protocol baseline pins, question counts and targets for real live runs", async () => {
    const f = fixture();
    for (const override of [{ expectedQuestions: 5 }, { target: 3 }, { baselineSha256: "0".repeat(64) }]) {
      const o = { ...f.opts(), live: true, ...override };
      await expect(runReplay(o)).rejects.toThrow(/protocol baseline/);
      expect(existsSync(o.out)).toBe(false);
    }
    // Without an override the pinned protocol baseline hash cannot match the test fixture, so it fails before any output exists.
    const o = { ...f.opts(), live: true, expectedQuestions: undefined };
    await expect(runReplay(o)).rejects.toThrow(/fingerprint/);
    expect(existsSync(o.out)).toBe(false);
  });

  it("rejects incomplete, mismatched or malformed baselines", () => {
    const f = fixture();
    const sha = { baseline: "b", input: f.baseline.hashes.input!, rankings: f.baseline.hashes.rankings! };
    const ids = f.cases.map((c) => c.question_id);
    const check = (r: BaselineReport, s = sha, e: { sha256?: string; questions: number } = { questions: 5 }) => validateBaseline(r, s, ids, e);
    expect(() => check(f.baseline)).not.toThrow();
    expect(() => check({ ...f.baseline, status: "partial" })).toThrow();
    expect(() => check(f.baseline, sha, { sha256: "other", questions: 5 })).toThrow(/fingerprint/);
    expect(() => check(f.baseline, { ...sha, input: "x" })).toThrow(/match baseline hashes/);
    expect(() => check({ ...f.baseline, summary: { planned: 5, recorded: 5, errors: 1 } })).toThrow();
    expect(() => check({ ...f.baseline, results: f.baseline.results.slice(1) })).toThrow();
    expect(() => check({ ...f.baseline, results: f.baseline.results.map((r, i) => i ? r : { ...r, premise_override: undefined as unknown as boolean }) })).toThrow(/malformed/);
    expect(() => check({ ...f.baseline, invocation: { ...f.baseline.invocation, topK: 10 } })).toThrow(/invocation/);
  });

  it("scores the 500-row mixed replay with reused rows and screens on numeric gain and paired abstention loss", () => {
    const base = Array.from({ length: 500 }, (_, i) => ({ question_id: `q${i}`, correct: i < 24 || (i >= 29 && i < 477), premise_override: i < 29, is_abstention: i < 24 }));
    expect(base.filter((b) => b.correct).length).toBe(472);
    const row = (i: number, replay: boolean | null, error: string | null = null) => ({
      question_id: `q${i}`, is_abstention: i < 24, baseline_correct: base[i]!.correct, replay_correct: replay, error,
    }) as unknown as ReplayRow;
    const rows = (over: Record<number, boolean | null>) => Array.from({ length: 29 }, (_, i) => row(i, i in over ? over[i]! : base[i]!.correct));
    const gains = { 24: true, 25: true, 26: true, 27: true };
    const pass = summarizeReplay(base, rows(gains), 29);
    expect(pass).toMatchObject({ planned: 500, reused: 471, mixed_correct: 476, delta_vs_baseline: 4, net: 4, advancement_screen_passed: true, status: "pending_source_review" });
    expect(pass.gains).toEqual(["q24", "q25", "q26", "q27"]);
    const short = summarizeReplay(base, rows({ 24: true, 25: true, 26: true }), 29);
    expect(short).toMatchObject({ mixed_correct: 475, advancement_screen_passed: false, status: "screen_not_passed" });
    // 476 overall can still fail: an unanswerable case lost while five answerable cases were gained elsewhere.
    const lost = summarizeReplay(base, rows({ ...gains, 28: true, 0: false }), 29);
    expect(lost).toMatchObject({ mixed_correct: 476, abstention_losses: ["q0"], advancement_screen_passed: false });
    const errored = summarizeReplay(base, rows({ ...gains, 28: null }).map((r, i) => i === 28 ? row(28, null, "judge_timeout") : r), 29);
    expect(errored).toMatchObject({ planned: 500, errors: 1, status: "incomplete", advancement_screen_passed: false, failed_replay_ids: ["q28"], mixed_correct: 476 });
    // A historically correct unanswerable row whose replay errors is counted incorrect, not silently reused.
    const absError = summarizeReplay(base, rows(gains).map((r, i) => i === 0 ? row(0, null, "review_timeout") : r), 29);
    expect(absError).toMatchObject({ mixed_correct: 475, errors: 1, status: "incomplete", advancement_screen_passed: false });
    expect(absError.selected_without_correct_verdict).toContain("q0");
    const missing = summarizeReplay(base, rows(gains).slice(1), 29);
    expect(missing).toMatchObject({ status: "incomplete", mixed_correct: 475, reused: 471 });
    // Failure-inclusive pairing: a historically correct unanswerable row that errors or is missing is a paired loss.
    const absTimeout = summarizeReplay(base, rows({}).map((r, i) => i === 0 ? row(0, null, "review_timeout") : r), 29);
    expect(absTimeout).toMatchObject({ mixed_correct: 471, delta_vs_baseline: -1, net: -1, losses: ["q0"], abstention_losses: ["q0"], status: "incomplete", advancement_screen_passed: false });
    const absMissing = summarizeReplay(base, rows({}).slice(1), 29);
    expect(absMissing).toMatchObject({ mixed_correct: 471, delta_vs_baseline: -1, net: -1, losses: ["q0"], abstention_losses: ["q0"], missing_ids: ["q0"], status: "incomplete" });
    expect(summarizeReplay(base, rows(gains).map((r, i) => i === 0 ? row(0, null, "judge_timeout") : r), 29).net).toBe(3);
    // Equal row counts must not hide duplicate, unknown or missing IDs, even when the score would otherwise clear the target.
    const dup = summarizeReplay(base, rows(gains).map((r, i) => i === 28 ? row(1, true) : r), 29, 400);
    expect(dup).toMatchObject({ duplicate_ids: ["q1"], missing_ids: ["q28"], status: "incomplete", advancement_screen_passed: false });
    const unknown = summarizeReplay(base, rows(gains).map((r, i) => i === 28 ? { ...row(28, true), question_id: "unknown" } : r), 29, 400);
    expect(unknown).toMatchObject({ unknown_ids: ["unknown"], missing_ids: ["q28"], status: "incomplete", advancement_screen_passed: false });
    for (const s of [absTimeout, absMissing, dup, unknown, pass, short, lost]) expect(s.net).toBe(s.delta_vs_baseline);
  });

  it("uses the declared native Qwen configuration for review and judge calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-lme-abstention-key-"));
    writeFileSync(join(dir, "token"), "test-token\n");
    process.env.DGX_KEY_FILE = join(dir, "token");
    process.env.DGX_BASE_URL = "http://127.0.0.1:9/v1";
    const bodies: any[] = [];
    const call = buildModelCall(async (_url, init) => {
      bodies.push(JSON.parse(init.body as string));
      return Response.json({ status: "completed", model: "qwen3.8-flash-next", output_text: JSON.stringify({ reasoning: "r", answer: "a", correct: true, reason: "r" }), usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const review = await call("answer", "review prompt");
    const judge = await call("judge", "judge prompt");
    const [a, j] = bodies;
    expect(a.reasoning.effort).toBe("medium");
    expect(a.max_output_tokens).toBe(8192);
    expect(a.input[0].content).toContain(HISTORY_EVIDENCE_POLICY);
    expect(a.input[0].content).toContain(MINIMAL_ANSWER_POLICY);
    expect(a.text.format).toMatchObject({ type: "json_schema", name: "benchmark_answer", strict: true });
    expect(j.reasoning.effort).toBe("none");
    expect(j.max_output_tokens).toBe(4096);
    expect(j.input[0].content).not.toContain(HISTORY_EVIDENCE_POLICY);
    expect(review.request_config).toEqual({ reasoning_effort: "medium", max_output_tokens: 8192 });
    expect(judge.request_config).toEqual({ reasoning_effort: "none", max_output_tokens: 4096 });
    expect(sha256(ANSWER_INSTRUCTIONS)).toMatch(/^[0-9a-f]{64}$/);
  });
});
  it("reports logical calls, HTTP attempts, unfinished calls and unknown usage separately", () => {
    const start = (seq: number): JournalEntry => ({ seq, event: "start", at: "t", question_id: "q", kind: "answer", prompt_sha256: "p" });
    const finish = (seq: number, start_seq: number, attempts: number, usage: Record<string, unknown> | null): JournalEntry => ({
      seq, event: "finish", start_seq, at: "t", question_id: "q", kind: "answer", prompt_sha256: "p", model: "m", error: null, attempts,
      elapsed_ms: 10, usage_known: usage !== null, usage, request_config: null,
    });
    const u = usageSummary([start(0), finish(1, 0, 3, { input_tokens: 5, output_tokens: 2 }), start(2), start(3), finish(4, 3, 1, null)]);
    expect(u).toMatchObject({
      logical_calls_started: 3, logical_calls_finished: 2, logical_calls_unfinished: 1, http_attempts: 4, calls_with_internal_retries: 1,
      prior_attempts_with_unknown_usage: 2, final_attempts_with_unknown_usage: 1, usage_complete: false,
      known_tokens_lower_bound: { input: 5, output: 2 },
    });
  });

  it("rejects live runs that do not select exactly the protocol's 29 override rows", async () => {
    const f = fixture();
    // The fixture cohort has 3 rows; a non-injected live run must refuse it even before credentials are considered.
    await expect(runReplay({ ...f.opts(), live: true, expectedQuestions: undefined })).rejects.toThrow();
  });

  it("native live runs cannot weaken protocol pins", async () => {
    const f = fixture();
    await expect(runReplay({ ...f.opts(), live: true, baselineSha256: undefined, expectedQuestions: 5 })).rejects.toThrow(/protocol baseline/);
  });

  it("reserves all four output paths and journals the start before the first callback awaits", async () => {
    const o = { ...fixture().opts(), live: true };
    let first: { exists: boolean[]; journal: { event: string; kind: string }[] } | undefined;
    await runReplay(o, async (kind, prompt, meta) => {
      first ??= {
        exists: [o.out, `${o.out}.jsonl`, `${o.out}.journal.jsonl`, `${o.out}.progress.json`].map((path) => existsSync(path)),
        journal: readFileSync(`${o.out}.journal.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
      };
      return ok()(kind, prompt, meta);
    });
    expect(first!.exists).toEqual([true, true, true, true]);
    expect(first!.journal).toHaveLength(1);
    expect(first!.journal[0]).toMatchObject({ event: "start", kind: "answer" });
  });

  it("counts extra HTTP attempts as unknown prior usage rather than zero", async () => {
    const o = { ...fixture().opts(), live: true };
    const report = await runReplay(o, async (...a) => ({ ...(await ok()(...a)), attempts: 3 }));
    expect((report as unknown as { usage: Record<string, unknown> }).usage).toMatchObject({
      logical_calls_started: 6, logical_calls_finished: 6, http_attempts: 18, calls_with_internal_retries: 6,
      prior_attempts_with_unknown_usage: 12, usage_complete: false, known_tokens_lower_bound: { input: 18, output: 12 },
    });
  });

  it("reports lexical tail reselection separately from true additions and drops", async () => {
    const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
    const reselected = (await runReplay(fixture([18, 19]).opts())).results as ReplayRow[];
    for (const row of reselected) {
      expect(sorted(row.source_changes!.lexical_tail_selections)).toEqual([18, 19]);
      expect(row.source_changes!.added_occurrences).toEqual([]);
      expect(row.source_changes!.dropped_occurrences).toEqual([]);
    }
    const mixed = (await runReplay(fixture([19, 20]).opts())).results as ReplayRow[];
    for (const row of mixed) {
      expect(sorted(row.source_changes!.lexical_tail_selections)).toEqual([19, 20]);
      expect(row.source_changes!.added_occurrences).toEqual([20]);
      expect(row.source_changes!.dropped_occurrences).toEqual([18]);
    }
  });

import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { answerPrompt, sha256, type Case, type Call, type ModelCall } from "../benchmark/longmemeval-qa-support.js";
import { buildContextReplayInput, CONTEXT_REPLAY_CAP, sanitizeContext } from "../benchmark/longmemeval-context-replay-input.js";
import { CONTEXT_REPLAY_MODEL_CONFIG, parseContextReplayArgs, runContextReplay, summarizeContextReplay } from "../benchmark/longmemeval-context-replay.js";

const call = (text: string | null, error: string | null = null): Call => ({
  text, error, attempts: 1, elapsed_ms: 1, model: "stub", usage: { total_tokens: 1 }, prompt_sha256: "stub",
});
const temp = () => mkdtempSync(join(tmpdir(), "recall-context-replay-"));
function fixture(context = "published answer_source_59 then answer_source_0; q59; answer_keep") {
  const cases: Case[] = Array.from({ length: 60 }, (_, index) => {
    const id = `q${String(index).padStart(2, "0")}`, source = `answer_source_${index}`;
    return {
      question_id: id, question_type: index % 2 ? "multi-session" : "single-session", is_abstention: false,
      question: `Question ${index}?`, question_date: "2026/01/01", reference: `GOLD-${id}`,
      gold_session_ids: [source], answer_prompt_prefix: `Pinned question ${index}: __RECALL_CONTEXT__`,
      judge_prompt_template: `Reference: GOLD-${id}\nCandidate: __RECALL_CANDIDATE__`,
      sessions: [{ id: source, date: "2025/12/31", text: `source ${index}` }],
    };
  });
  const results = cases.map((item, index) => {
    const evidence = { text: `Recall context ${index} $& preserves exactly.`, sources: [{ id: item.sessions[0]!.id, date: "2025/12/31", occurrence: 0 }] };
    return { question_id: item.question_id, evidence, answer_call: { prompt_sha256: sha256(answerPrompt(item, evidence.text)) }, correct: true };
  });
  return {
    prepared: { provenance: { fixture: true }, cases },
    recall: { status: "complete", comparison_valid: true, selected_question_ids: cases.map((item) => item.question_id), results },
    published: { results: cases.map((item, index) => ({ query_id: item.question_id, query: item.question, context: index === 59 ? context : `Memo answer_source_${index}; ${item.question_id}`, answer: "HISTORICAL OUTCOME", correct: true })) },
    raw: cases.map((item) => ({ question_id: item.question_id, question: item.question, haystack_session_ids: item.sessions.map((session) => session.id) })),
    expectedIds: { selected_ids: cases.map((item) => item.question_id) },
  };
}
function bundle() { return buildContextReplayInput(fixture()); }

describe("LongMemEval context replay", () => {
  it("validates the exact 60-case cohort, Recall prompt parity, source identity, and complete cap", () => {
    const input = fixture();
    const built = buildContextReplayInput(input);
    expect(built.selected_question_ids).toHaveLength(60);
    expect(built.cases[0]!.sides.recall.context).toBe(input.recall.results[0]!.evidence.text);
    expect(built.cases[0]!.sides.recall.context_utf16_chars).toBe(input.recall.results[0]!.evidence.text.length);
    expect(built.cases[0]!.sides.hindsight.context).not.toContain("answer_source_0");
    expect(built.cases[0]!.sides.hindsight.context).not.toContain("q00");
    expect(() => buildContextReplayInput({ ...input, expectedIds: { selected_ids: [...input.expectedIds.selected_ids].reverse() } })).toThrow("identity/order");
    const badHash = structuredClone(input); badHash.recall.results[0]!.answer_call.prompt_sha256 = "bad";
    expect(() => buildContextReplayInput(badHash)).toThrow("prompt hash");
    const badSource = structuredClone(input); badSource.recall.results[0]!.evidence.sources[0]!.occurrence = 1;
    expect(() => buildContextReplayInput(badSource)).toThrow("source identity");
    const missingSources = structuredClone(input); delete (missingSources.recall.results[0]!.evidence as { sources?: unknown }).sources;
    expect(() => buildContextReplayInput(missingSources)).toThrow("source metadata");
    const duplicateRows = structuredClone(input); duplicateRows.recall.results.push(duplicateRows.recall.results[0]!);
    expect(() => buildContextReplayInput(duplicateRows)).toThrow("Duplicate Recall result");
    const missingRows = structuredClone(input); missingRows.recall.results.pop();
    expect(() => buildContextReplayInput(missingRows)).toThrow("identity/order");
    const abstention = structuredClone(input); abstention.prepared.cases[0]!.is_abstention = true;
    expect(() => buildContextReplayInput(abstention)).toThrow("no abstentions");
    const allowed = fixture("x".repeat(180_001));
    expect(buildContextReplayInput(allowed).cases[59]!.sides.hindsight.context_utf16_chars).toBe(180_001);
    expect(() => buildContextReplayInput(fixture("x".repeat(CONTEXT_REPLAY_CAP + 1)))).toThrow("exceeds");
  });

  it("sanitizes known IDs by longest first appearance while preserving all other text", () => {
    const result = sanitizeContext("answer_xyz answer_xy answer_xyz answer_keep q1 q1", ["answer_xy", "answer_xyz"], ["q1"]);
    expect(result.text).toBe("source-neutral-1 source-neutral-2 source-neutral-1 answer_keep question-neutral-3 question-neutral-3");
    expect(result.replacements.map((row) => row.alias)).toEqual(["source-neutral-1", "source-neutral-2", "question-neutral-3"]);
    expect(result.replacements.map((row) => row.occurrences)).toEqual([2, 1, 2]);
    expect(result.text).toContain("answer_keep");
    expect(sanitizeContext("answer_xyz answer_xy", ["answer_xy", "answer_xyz"], ["q1"]).text)
      .toBe(sanitizeContext("answer_xyz answer_xy", ["answer_xyz", "answer_xy"], ["q1"]).text);
  });

  it("keeps references, gold IDs, categories, outcomes and source order out of generation prompts", async () => {
    const input = fixture(), first = input.prepared.cases[0]!;
    first.gold_session_ids = ["GOLD-SOURCE"]; first.reference = "SECRET REFERENCE";
    input.published.results[0]!.answer = "OLD ANSWER"; input.published.results[0]!.correct = false;
    const built = buildContextReplayInput(input), seen: string[] = [];
    const out = join(temp(), "prepared.json");
    await runContextReplay({ input: built, out, concurrency: 3 }, async (kind, prompt) => {
      seen.push(prompt);
      return kind === "answer" ? call('{"answer":"unused"}') : call('{"correct":true}');
    });
    expect(seen).toEqual([]);
    const prompts: string[] = [];
    const liveOut = join(temp(), "live.json");
    await runContextReplay({ input: built, out: liveOut, live: true }, async (kind, prompt) => {
      if (kind === "answer") prompts.push(prompt);
      return kind === "answer" ? call('{"answer":"fresh"}') : call('{"correct":true}');
    });
    expect(prompts.join("\n")).not.toContain("SECRET REFERENCE");
    expect(prompts.join("\n")).not.toContain("GOLD-SOURCE");
    expect(prompts.join("\n")).not.toContain("OLD ANSWER");
    expect(prompts[0]).not.toContain("single-session");
  });

  it("uses pinned settings, runs exactly 120 counterbalanced tasks, isolates judges, and limits calls to three", async () => {
    const out = join(temp(), "report.json"), seen: Array<{ kind: string; prompt: string }> = [];
    let active = 0, max = 0;
    const report = await runContextReplay({ input: bundle(), out, live: true, concurrency: 3 }, async (kind, prompt) => {
      active++; max = Math.max(max, active); await new Promise((resolve) => setTimeout(resolve, 1)); active--;
      seen.push({ kind, prompt });
      return kind === "answer" ? call('{"answer":"new final"}') : call('{"correct":true}');
    });
    expect(report.settings).toMatchObject({ model: "qwen3.8-flash-next", answer_reasoning: "adaptive", answer_max_output_tokens: 16384, judge_reasoning: "none", judge_max_output_tokens: 4096 });
    expect(report.results).toHaveLength(120);
    expect(report.results.map((row) => [row.case_index, row.side]).slice(0, 4)).toEqual([[0, "recall"], [0, "hindsight"], [1, "hindsight"], [1, "recall"]]);
    expect(report.summary.by_side.recall).toMatchObject({ planned: 60, correct: 60 });
    expect(max).toBeLessThanOrEqual(3);
    expect(seen.filter((row) => row.kind === "judge")).toHaveLength(120);
    expect(seen.filter((row) => row.kind === "judge").every((row) => row.prompt.includes("new final") && !row.prompt.includes("Recall context"))).toBe(true);
    expect(readFileSync(`${out}.jsonl`, "utf8").split("\n").filter(Boolean)).toHaveLength(120);
  });

  it("uses the fixed factory settings and fixed subgroup denominators before and during scoring", async () => {
    let captured: typeof CONTEXT_REPLAY_MODEL_CONFIG | undefined;
    const kinds: string[] = [];
    const report = await runContextReplay({ input: bundle(), out: join(temp(), "factory.json"), live: true }, undefined, (config) => {
      captured = config;
      return async (kind) => {
        kinds.push(kind);
        return kind === "answer" ? call('{"answer":"fresh"}') : call('{"correct":true}');
      };
    });
    expect(captured).toBe(CONTEXT_REPLAY_MODEL_CONFIG);
    expect(captured?.options).toMatchObject({ structuredOutput: true, reasoningEffort: "adaptive", maxOutputTokens: 16_384 });
    expect(captured?.options.answerInstructions).toContain("source evidence");
    expect(kinds).toContain("answer");
    expect(kinds).toContain("judge");
    const partial = summarizeContextReplay([], { by_type: { "single-session": 30, "multi-session": 30 }, abstention: 0 });
    expect(partial.categories["single-session"].recall).toMatchObject({ planned: 30, recorded: 0, accuracy: null });
    expect(partial.abstention.recall).toMatchObject({ planned: 0, recorded: 0, accuracy: null });
    expect(report.summary.categories["single-session"].hindsight.planned).toBe(30);
  });

  it("counts thrown and malformed answers as failures without judging or retrying", async () => {
    let calls = 0;
    const report = await runContextReplay({ input: bundle(), out: join(temp(), "failures.json"), live: true }, async (kind) => {
      calls++;
      if (kind === "judge") throw new Error("judges must not be reached");
      if (calls === 1) throw new Error("HTTP 503");
      return call("{malformed");
    });
    expect(calls).toBe(120);
    expect(report.results.every((row) => row.correct === false && row.judge_call === null)).toBe(true);
    expect(report.summary.errors_by_kind).toMatchObject({ "answer_HTTP 503": 1, malformed_answer: 119 });
    expect(report.results[0]!.answer_call).toMatchObject({ model: "unknown_after_thrown_call", attempts: 0, usage: { attempts_known: false } });
  });

  it("reserves artifacts before factories, preserves collisions, and makes no calls in default preparation", async () => {
    const directory = temp(), collision = join(directory, "collision.json");
    writeFileSync(collision, "keep");
    let factories = 0;
    await expect(runContextReplay({ input: bundle(), out: collision, live: true }, undefined, () => {
      factories++; throw new Error("factory");
    })).rejects.toThrow("Output already exists");
    expect(readFileSync(collision, "utf8")).toBe("keep");
    expect(factories).toBe(0);
    const report = await runContextReplay({ input: bundle(), out: join(directory, "prepared.json") }, undefined, () => {
      factories++; throw new Error("factory");
    });
    expect(factories).toBe(0);
    expect(report.status).toBe("prepared");
    expect(report.results).toHaveLength(120);
    expect(report.results.every((row) => row.correct === null && row.answer_call === null)).toBe(true);
    expect(report.summary.by_side.recall.accuracy).toBeNull();
    expect(report.summary.abstention.recall.accuracy).toBeNull();
    expect(parseContextReplayArgs(["--input", "bundle.json", "--out", "out.json", "--live", "--concurrency", "3"])).toMatchObject({ input: "bundle.json", out: "out.json", live: true, concurrency: 3 });
  });

  it("rejects malformed generation or judge templates before reserving or creating a call", async () => {
    const bad = bundle();
    bad.cases[0]!.judge_case.judge_prompt_template = "no candidate marker";
    let factories = 0;
    const out = join(temp(), "invalid.json");
    await expect(runContextReplay({ input: bad, out, live: true }, undefined, () => {
      factories++; return async () => call('{"answer":"unused"}');
    })).rejects.toThrow("Invalid judge prompt marker");
    expect(factories).toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  it("runs the offline CLI through an absolute symlink path and writes all prepared tasks", () => {
    const directory = temp(), input = join(directory, "bundle.json"), out = join(directory, "report.json");
    const runner = fileURLToPath(new URL("../benchmark/longmemeval-context-replay.ts", import.meta.url));
    const alias = join(directory, "context-replay.ts");
    writeFileSync(input, JSON.stringify(bundle()));
    symlinkSync(runner, alias);
    const result = spawnSync(process.execPath, ["--import", "tsx", alias, "--input", input, "--out", out], {
      cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(existsSync(out)).toBe(true);
    const report = JSON.parse(readFileSync(out, "utf8")) as { status: string; results: unknown[] };
    expect(report).toMatchObject({ status: "prepared" });
    expect(report.results).toHaveLength(120);
    expect(readFileSync(`${out}.jsonl`, "utf8").split("\n").filter(Boolean)).toHaveLength(120);
  });
});

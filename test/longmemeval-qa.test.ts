import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerPrompt, buildEvidence, cachedRank, createModelCall, lexicalRank, parseJudge, selectCases, sha256, type Call, type Case } from "../benchmark/longmemeval-qa-support.js";
import { evaluateCase, parseArgs, runEvaluation, summarize } from "../benchmark/longmemeval-qa.js";
import { withTransportRetry } from "../benchmark/longmemeval-answer-sampling.js";
import { HISTORY_EVIDENCE_POLICY } from "../src/history/evidence-policy.js";
import { MINIMAL_ANSWER_POLICY, MINIMAL_ANSWER_POLICY_V2 } from "../benchmark/longmemeval-minimal-answer-policy.js";
import { PREMISE_CHECK_POLICY } from "../benchmark/longmemeval-premise-policy.js";

const item: Case = {
  question_id: "q", question_type: "single-session-user", is_abstention: false,
  question: "Which bicycle?", question_date: "2024/01/03", reference: "GOLD_SENTINEL",
  gold_session_ids: ["duplicate"], answer_prompt_prefix: "Question: Which bicycle?\n__RECALL_CONTEXT__",
  judge_prompt_template: "Gold: GOLD_SENTINEL\nCandidate: __RECALL_CANDIDATE__",
  sessions: [{ id: "duplicate", date: "2024/01/01", text: "user: bicycle blue" }, { id: "duplicate", date: "2024/01/02", text: "user: bicycle red" }, { id: "irrelevant", date: "2024/01/01", text: "user: pizza" }],
};
const response = (text: string | null, error: string | null = null): Call => ({ text, error, attempts: 1, elapsed_ms: 1, model: "mock", usage: null, prompt_sha256: "mock" });
const options = { retrieval: "lexical" as const, topK: 10, contextChars: 1000 };

describe("LongMemEval QA", () => {
  it("uses the production lexical index in isolation and preserves source occurrences", () => {
    const ranked = lexicalRank(item.question, item.sessions, 10);
    expect(ranked.map((row) => row.occurrence).sort()).toEqual([0, 1]);
    expect(lexicalRank("bicycle", [{ id: "new", date: "d", text: "pizza" }], 10)).toEqual([]);
    expect(ranked.every((row) => !row.text.includes(item.reference))).toBe(true);
  });
  it("keeps cached duplicates distinct and refuses stale source IDs", () => {
    expect(cachedRank(item.sessions, ["duplicate", "duplicate"], 10).map((row) => row.occurrence)).toEqual([0, 1]);
    expect(() => cachedRank(item.sessions, ["missing"], 10)).toThrow("missing session");
  });
  it("exposes ambiguous historical IDs instead of claiming an exact ranking replay", async () => {
    const row = await evaluateCase(item, { ...options, retrieval: "cached", topK: 2 }, ["duplicate", "irrelevant"]);
    expect(row.cached_ambiguous_session_ids).toEqual(["duplicate"]);
    expect(row.evidence?.sources.map((source) => source.id)).toEqual(["duplicate", "duplicate"]);
    expect(summarize([row], 1).cached_ambiguous_questions).toBe(1);
  });
  it("shares a bounded context budget and keeps literal dollar sequences", () => {
    const ranked = cachedRank(item.sessions, ["duplicate", "irrelevant"], 10).map((row) => ({ ...row, text: "x".repeat(500) }));
    const evidence = buildEvidence(ranked, 400);
    expect(evidence.text.length).toBeLessThanOrEqual(400);
    expect(evidence.sources.every((source) => source.truncated && source.used_chars > 0)).toBe(true);
    expect(answerPrompt(item, "$& $` $'")).toContain("$& $` $'");
    expect(() => buildEvidence(ranked, 10)).toThrow("labels");
  });
  it("never inserts references into generation; judging happens afterwards", async () => {
    const kinds: string[] = [];
    const row = await evaluateCase(item, options, undefined, async (kind, prompt) => {
      kinds.push(kind);
      if (kind === "answer") { expect(prompt).not.toContain("GOLD_SENTINEL"); expect(prompt).not.toContain("gold_session"); return response('{"answer":"blue and red","reasoning":"source"}'); }
      expect(prompt).toContain("GOLD_SENTINEL"); expect(prompt).toContain("blue and red");
      return response('{"correct":true,"reason":"matches"}');
    });
    expect(kinds).toEqual(["answer", "judge"]); expect(row.correct).toBe(true);
  });
  it("hides gold-derived source IDs and original positions from the answerer", async () => {
    const labelled: Case = {
      ...item, gold_session_ids: ["answer_GOLD_LABEL_SENTINEL"],
      sessions: [
        { id: "ordinary_source", date: "2024/01/01", text: "user: bicycle blue" },
        { id: "answer_GOLD_LABEL_SENTINEL", date: "2024/01/02", text: "user: bicycle red" },
      ],
    };
    const row = await evaluateCase(labelled, options, undefined, async (kind, prompt) => {
      if (kind === "answer") {
        expect(prompt).not.toContain("answer_GOLD_LABEL_SENTINEL");
        expect(prompt).not.toContain("ordinary_source");
        expect(prompt).not.toContain("occurrence");
        expect(prompt).toContain("user: bicycle red");
        return response('{"answer":"red"}');
      }
      return response('{"correct":true}');
    });
    expect(row.correct).toBe(true);
    expect(row.evidence?.sources.map((source) => source.id)).toContain("answer_GOLD_LABEL_SENTINEL");
    expect(row.gold_any).toBe(true);
  });
  it("counts malformed judges and transport errors in the fixed denominator", async () => {
    const malformed = await evaluateCase(item, options, undefined, async (kind) => response(kind === "answer" ? '{"answer":"red"}' : '{"correct":"false"}'));
    const failure = await evaluateCase(item, options, undefined, async () => response(null, "HTTP 503"));
    expect(malformed.error).toBe("malformed_judge"); expect(failure.error).toBe("answer_HTTP 503");
    const summary = summarize([malformed, failure], 3);
    expect(summary.accuracy).toBe(0); expect(summary.planned).toBe(3); expect(summary.errors).toBe(2);
    expect(parseJudge('{"correct":"false"}')).toBeNull();
  });
  it("selects only cached questions and rejects invalid cache identities", () => {
    const other = { ...item, question_id: "other" };
    expect(selectCases([item, other], [{ question_id: "other", retrieved_session_ids: [] }]).map((row) => row.question_id)).toEqual(["other"]);
    expect(() => selectCases([item], [{ question_id: "missing", retrieved_session_ids: [] }])).toThrow("unknown question");
    expect(() => selectCases([item, item])).toThrow("Duplicate question");
  });
  it("records Moonshot usage and rejects output stopped by the token limit", async () => {
    vi.stubEnv("MOONSHOT_API_KEY", "test-only-token");
    try {
      const mockFetch = vi.fn<typeof fetch>(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.thinking).toEqual({ type: "enabled" });
        expect(body.max_tokens).toBe(8192);
        expect(body.temperature).toBeUndefined();
        expect(init?.redirect).toBe("error");
        return new Response(JSON.stringify({ model: "kimi-k2.7-code-highspeed", choices: [{ finish_reason: "stop", message: { content: '{"answer":"red"}' } }], usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 } }));
      });
      const result = await createModelCall("moonshot", mockFetch)("answer", "question");
      expect(result.error).toBeNull(); expect(result.usage?.total_tokens).toBe(168);
      const incomplete = await createModelCall("moonshot", async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '{"answer":"red"}' } }], usage: { total_tokens: 8192 } })))("answer", "question");
      expect(incomplete.text).toBeNull(); expect(incomplete.error).toBe("response_not_completed");
      expect(incomplete.usage?.total_tokens).toBe(8192);
    } finally { vi.unstubAllEnvs(); }
  });
  it("redacts provider error bodies from output", async () => {
    vi.stubEnv("MOONSHOT_API_KEY", "test-only-token");
    try {
      const result = await createModelCall("moonshot", async () => new Response("private provider detail test-only-token", { status: 401 }))("judge", "question");
      expect(result.error).toBe("HTTP 401"); expect(JSON.stringify(result)).not.toContain("test-only-token");
    } finally { vi.unstubAllEnvs(); }
  });
  it("backs off on rate limits without retrying an unfavorable model answer", async () => {
    vi.stubEnv("MOONSHOT_API_KEY", "test-only-token");
    vi.useFakeTimers();
    try {
      const mockFetch = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "7" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"correct":false}' } }] })));
      const pending = createModelCall("moonshot", mockFetch)("judge", "question");
      await vi.advanceTimersByTimeAsync(6999);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.attempts).toBe(2); expect(parseJudge(result.text)).toBe(false);
    } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
  });
  it("respects a server cooldown longer than the exponential-backoff cap", async () => {
    vi.stubEnv("MOONSHOT_API_KEY", "test-only-token");
    vi.useFakeTimers();
    try {
      const mockFetch = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "120" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"answer":"red"}' } }] })));
      const pending = createModelCall("moonshot", mockFetch)("answer", "question");
      await vi.advanceTimersByTimeAsync(119999);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).attempts).toBe(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
  });
  it("allows the local model to finish queued long-context work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-lme-qa-token-"));
    const keyFile = join(dir, "token");
    writeFileSync(keyFile, "test-only-local-token");
    vi.stubEnv("DGX_BASE_URL", "http://127.0.0.1:45678/v1");
    vi.stubEnv("DGX_KEY_FILE", keyFile);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const result = await createModelCall("qwen-local", async () => new Response(JSON.stringify({ status: "completed", model: "qwen3.8-flash-next", output_text: '{"answer":"red"}', usage: { total_tokens: 12 } })))("answer", "question");
      expect(timeout).toHaveBeenCalledWith(600000);
      expect(result.error).toBeNull();
      expect(result.model).toBe("qwen3.8-flash-next");
    } finally { timeout.mockRestore(); vi.unstubAllEnvs(); }
  });
  it("uses a strict native schema only when requested for the local provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-lme-qa-schema-"));
    const keyFile = join(dir, "token");
    writeFileSync(keyFile, "test-only-local-token");
    vi.stubEnv("DGX_BASE_URL", "http://127.0.0.1:45678/v1");
    vi.stubEnv("DGX_KEY_FILE", keyFile);
    try {
      const strictFetch = vi.fn<typeof fetch>(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.text.format.name === "benchmark_answer") {
          expect(body.text.format).toEqual({
            type: "json_schema", name: "benchmark_answer", strict: true,
            schema: {
              type: "object", properties: { reasoning: { type: "string" }, answer: { type: "string" } },
              required: ["reasoning", "answer"], additionalProperties: false,
            },
          });
          expect(body.input[0].content).toBe("Return only JSON with reasoning and answer string fields.");
          return new Response(JSON.stringify({ status: "completed", output_text: '{"answer":"red","reasoning":"source"}' }));
        }
        expect(body.text.format).toEqual({
          type: "json_schema", name: "benchmark_judge", strict: true,
          schema: {
            type: "object", properties: { correct: { type: "boolean" }, reason: { type: "string" } },
            required: ["correct", "reason"], additionalProperties: false,
          },
        });
        expect(body.input[0].content).toBe("Return only JSON with correct:boolean and reason:string fields.");
        return new Response(JSON.stringify({ status: "completed", output_text: '{"correct":true,"reason":"matches"}' }));
      });
      const strictCall = createModelCall("qwen-local", strictFetch, { structuredOutput: true });
      expect((await strictCall("answer", "question")).error).toBeNull();
      expect((await strictCall("judge", "question")).error).toBeNull();
      const standardFetch = vi.fn<typeof fetch>(async (_url, init) => {
        expect(JSON.parse(String(init?.body)).text).toBeUndefined();
        return new Response(JSON.stringify({ status: "completed", output_text: '{"answer":"red"}' }));
      });
      await createModelCall("qwen-local", standardFetch)("answer", "question");
    } finally { vi.unstubAllEnvs(); }
  });
  it("protects existing outputs and writes a complete mock report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-lme-qa-test-"));
    const input = join(dir, "input.json"), out = join(dir, "report.json");
    writeFileSync(input, JSON.stringify({ provenance: {}, cases: [item] }));
    const runOptions = { ...options, input, out, concurrency: 1 };
    const report = await runEvaluation(runOptions, async (kind) => response(kind === "answer" ? '{"answer":"red"}' : '{"correct":true}'));
    expect(report.status).toBe("complete"); expect(report.summary.accuracy).toBe(1);
    const before = readFileSync(out, "utf8");
    await expect(runEvaluation(runOptions)).rejects.toThrow("already exists");
    expect(readFileSync(out, "utf8")).toBe(before);
  });
  it("validates the opt-in minimal answer policy and records its instruction hash", async () => {
    expect(parseArgs(["--out", "x.json", "--answer-policy", "minimal"]).answerPolicy).toBe("minimal");
    expect(() => parseArgs(["--out", "x.json", "--answer-policy", "terse"])).toThrow("Invalid answer policy");
    const dir = mkdtempSync(join(tmpdir(), "recall-lme-qa-policy-"));
    const input = join(dir, "input.json");
    writeFileSync(input, JSON.stringify({ provenance: {}, cases: [item] }));
    const mock = async (kind: string) => response(kind === "answer" ? '{"answer":"red"}' : '{"correct":true}');
    await expect(runEvaluation({ ...options, input, out: join(dir, "inline.json"), concurrency: 1, answerPolicy: "minimal" }, mock))
      .rejects.toThrow("requires system evidence policy");
    const minimal = await runEvaluation({ ...options, input, out: join(dir, "minimal.json"), concurrency: 1, evidencePolicy: "system", answerPolicy: "minimal" }, mock);
    expect(minimal.answer_instructions).toEqual({
      policy: "minimal",
      sha256: sha256(`${HISTORY_EVIDENCE_POLICY}\n\n${MINIMAL_ANSWER_POLICY}`),
      history_sha256: sha256(HISTORY_EVIDENCE_POLICY),
      minimal_sha256: sha256(MINIMAL_ANSWER_POLICY),
      premise_sha256: null,
    });
    const history = await runEvaluation({ ...options, input, out: join(dir, "history.json"), concurrency: 1, evidencePolicy: "system" }, mock);
    expect(history.answer_instructions?.sha256).toBe(sha256(HISTORY_EVIDENCE_POLICY));
    expect(parseArgs(["--out", "x.json", "--answer-policy", "minimal-premise"]).answerPolicy).toBe("minimal-premise");
    await expect(runEvaluation({ ...options, input, out: join(dir, "premise-inline.json"), concurrency: 1, answerPolicy: "premise" }, mock))
      .rejects.toThrow("requires system evidence policy");
    const premise = await runEvaluation({ ...options, input, out: join(dir, "premise.json"), concurrency: 1, evidencePolicy: "system", answerPolicy: "premise" }, mock);
    expect(premise.answer_instructions).toMatchObject({
      policy: "premise", sha256: sha256(`${HISTORY_EVIDENCE_POLICY}\n\n${PREMISE_CHECK_POLICY}`),
      minimal_sha256: null, premise_sha256: sha256(PREMISE_CHECK_POLICY),
    });
    const both = await runEvaluation({ ...options, input, out: join(dir, "both.json"), concurrency: 1, evidencePolicy: "system", answerPolicy: "minimal-premise" }, mock);
    expect(both.answer_instructions?.sha256).toBe(sha256(`${HISTORY_EVIDENCE_POLICY}\n\n${MINIMAL_ANSWER_POLICY}\n\n${PREMISE_CHECK_POLICY}`));
    expect(MINIMAL_ANSWER_POLICY_V2.split("\n")).toHaveLength(MINIMAL_ANSWER_POLICY.split("\n").length - 1);
    expect(MINIMAL_ANSWER_POLICY_V2).not.toContain("negative preference");
    const v2 = await runEvaluation({ ...options, input, out: join(dir, "v2.json"), concurrency: 1, evidencePolicy: "system", answerPolicy: "minimal-v2" }, mock);
    expect(v2.answer_instructions).toMatchObject({ policy: "minimal-v2", sha256: sha256(`${HISTORY_EVIDENCE_POLICY}\n\n${MINIMAL_ANSWER_POLICY_V2}`), minimal_sha256: sha256(MINIMAL_ANSWER_POLICY_V2), premise_sha256: null });
  });
  it("runs a separate premise check that sees no draft and overrides only on an explicit false", async () => {
    expect(parseArgs(["--out", "x.json", "--answer-check", "premise"]).answerCheck).toBe("premise");
    const run = async (premise: Call) => {
      const seen: string[] = [];
      const dated: Case = { ...item, answer_prompt_prefix: "Answer from history.\n\nQuestion: Which bicycle?\nQuestion Date: 2024/01/03\n\nRetrieved Context:\n__RECALL_CONTEXT__\n\nAnswer:\n" };
      const row = await evaluateCase(dated, { ...options, answerCheck: "premise" }, undefined, async (kind, prompt) => {
        seen.push(kind);
        if (kind === "answer") return response('{"answer":"DRAFT_SENTINEL red","reasoning":"r"}');
        if (kind === "premise") { expect(prompt).not.toContain("DRAFT_SENTINEL"); expect(prompt).not.toContain("GOLD_SENTINEL"); expect(prompt).toContain("Which bicycle?"); return premise; }
        return response('{"correct":true,"reason":"ok"}');
      });
      expect(seen).toEqual(["answer", "premise", "judge"]);
      return row;
    };
    const kept = await run(response('{"correct":true,"reason":"bicycle is mentioned"}'));
    expect(kept.answer).toBe("DRAFT_SENTINEL red"); expect(kept.premise_override).toBe(false); expect(kept.premise_recorded).toBe(true);
    const failed = await run(response(null, "timeout"));
    expect(failed.answer).toBe("DRAFT_SENTINEL red"); expect(failed.premise_recorded).toBeNull(); expect(failed.error).toBeNull();
    const replaced = await run(response('{"correct":false,"reason":"You mentioned a car, but not a bicycle."}'));
    expect(replaced.premise_override).toBe(true); expect(replaced.draft_answer).toBe("DRAFT_SENTINEL red");
    expect(replaced.answer).toBe("The conversation history does not contain the information this question asks about. You mentioned a car, but not a bicycle.");
  });
  it("retries an unfinished answer once at the next lower effort, only for timeout or incomplete output", async () => {
    expect(parseArgs(["--out", "x.json", "--answer-recovery", "lower-effort"]).answerRecovery).toBe("lower-effort");
    expect(() => parseArgs(["--out", "x.json", "--answer-recovery", "retry"])).toThrow("Invalid answer recovery");
    const failed = (error: string, effort: "high" | "low" | "none"): Call => ({ ...response(null, error), request_config: { reasoning_effort: effort, max_output_tokens: 16384 } });
    const run = async (first: Call, recovery: "none" | "lower-effort" = "lower-effort") => {
      const efforts: (string | undefined)[] = [];
      const row = await evaluateCase(item, { ...options, answerRecovery: recovery }, undefined, async (kind, _prompt, meta) => {
        if (kind === "answer") { efforts.push(meta?.effort); return efforts.length === 1 ? first : response('{"answer":"red","reasoning":"r"}'); }
        return response('{"correct":true,"reason":"ok"}');
      });
      return { row, efforts };
    };
    const high = await run(failed("timeout", "high"));
    expect(high.efforts).toEqual([undefined, "low"]); expect(high.row.answer_recovered).toBe(true);
    expect(high.row.failed_answer_call?.error).toBe("timeout"); expect(high.row.answer).toBe("red"); expect(high.row.error).toBeNull();
    const low = await run(failed("response_not_completed", "low"));
    expect(low.efforts).toEqual([undefined, "none"]);
    const none = await run(failed("timeout", "none"));
    expect(none.efforts).toEqual([undefined]); expect(none.row.answer_recovered).toBe(false); expect(none.row.error).toBe("answer_timeout");
    const other = await run(failed("request_failed", "high"));
    expect(other.efforts).toEqual([undefined]); expect(other.row.error).toBe("answer_request_failed");
    const off = await run(failed("timeout", "high"), "none");
    expect(off.efforts).toEqual([undefined]); expect(off.row.error).toBe("answer_timeout");
  });
  it("votes among sampled answers with checks that see only the question and two answers", async () => {
    expect(parseArgs(["--out", "x.json", "--answer-samples", "3"]).answerSamples).toBe(3);
    expect(() => parseArgs(["--out", "x.json", "--answer-samples", "9"])).toThrow("Invalid answer samples");
    const vote = async (texts: string[]) => {
      let n = 0; const agreePrompts: string[] = [];
      const row = await evaluateCase(item, { ...options, answerSamples: texts.length }, undefined, async (kind, prompt) => {
        if (kind === "answer") return response(`{"answer":${JSON.stringify(texts[n++])},"reasoning":"r"}`);
        if (kind === "agree") {
          agreePrompts.push(prompt);
          const [a, b] = [...prompt.matchAll(/ANSWER_[AB]_JSON_STRING\n(".*")/g)].map((m) => JSON.parse(m[1]!) as string);
          return response(JSON.stringify({ correct: a!.split(" ")[0] === b!.split(" ")[0], reason: "r" }));
        }
        return response('{"correct":true,"reason":"ok"}');
      });
      return { row, agreePrompts };
    };
    const majority = await vote(["blue first", "red one", "red two"]);
    expect(majority.row.answer).toBe("red one");
    expect(majority.row.answer_samples?.votes).toEqual([0, 1, 1]);
    expect(majority.agreePrompts).toHaveLength(3);
    for (const prompt of majority.agreePrompts) { expect(prompt).not.toContain("GOLD_SENTINEL"); expect(prompt).not.toContain("bicycle blue"); expect(prompt).toContain("Which bicycle?"); }
    const same = await vote(["red", "red", "red"]);
    expect(same.row.answer).toBe("red"); expect(same.agreePrompts).toHaveLength(0);
    const split = await vote(["blue", "red", "green"]);
    expect(split.row.answer).toBe("blue");
  });
  it("repeats only request_failed calls at the same settings, at most three times", async () => {
    expect(parseArgs(["--out", "x.json", "--answer-recovery", "lower-effort-transport"]).answerRecovery).toBe("lower-effort-transport");
    const scripted = (errors: (string | null)[]) => {
      let n = 0; const metas: unknown[] = [];
      const call = async (_kind: string, _prompt: string, meta?: unknown) => { metas.push(meta); const e = errors[Math.min(n++, errors.length - 1)]!; return e ? response(null, e) : response('{"answer":"red"}'); };
      return { wrapped: withTransportRetry(call, 3, 0), metas, count: () => n };
    };
    const recovered = scripted(["request_failed", "request_failed", null]);
    const ok = await recovered.wrapped("judge", "p", { question: "q" });
    expect(ok.error).toBeNull(); expect(recovered.count()).toBe(3);
    expect((ok as Call & { transport_failures?: Call[] }).transport_failures).toHaveLength(2);
    expect(recovered.metas.every((m) => JSON.stringify(m) === '{"question":"q"}')).toBe(true);
    const exhausted = scripted(["request_failed"]);
    expect((await exhausted.wrapped("answer", "p")).error).toBe("request_failed"); expect(exhausted.count()).toBe(4);
    const timeout = scripted(["timeout"]);
    expect((await timeout.wrapped("answer", "p")).error).toBe("timeout"); expect(timeout.count()).toBe(1);
  });
  it("retries a timed-out answer at the same effort with a longer deadline, and drops effort only for unfinished answers", async () => {
    expect(parseArgs(["--out", "x.json", "--answer-recovery", "longer-timeout-transport"]).answerRecovery).toBe("longer-timeout-transport");
    const failed = (error: string, effort: "high" | "low"): Call => ({ ...response(null, error), request_config: { reasoning_effort: effort, max_output_tokens: 16384 } });
    const run = async (first: Call) => {
      const metas: ({ effort?: string; timeoutMs?: number } | undefined)[] = [];
      const row = await evaluateCase(item, { ...options, answerRecovery: "longer-timeout-transport" }, undefined, async (kind, _prompt, meta) => {
        if (kind === "answer") { metas.push(meta); return metas.length === 1 ? first : response('{"answer":"red","reasoning":"r"}'); }
        return response('{"correct":true,"reason":"ok"}');
      });
      return { row, metas };
    };
    const timeout = await run(failed("timeout", "high"));
    expect(timeout.metas[1]).toMatchObject({ effort: "high", timeoutMs: 1_200_000 });
    expect(timeout.row.answer_recovered).toBe(true); expect(timeout.row.failed_answer_call?.error).toBe("timeout");
    const unfinished = await run(failed("response_not_completed", "high"));
    expect(unfinished.metas[1]?.effort).toBe("low"); expect(unfinished.metas[1]?.timeoutMs).toBeUndefined();
  });
});

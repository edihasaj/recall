import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateCase, parseArgs, runEvaluation, type Options } from "../benchmark/longmemeval-qa.js";
import { CATEGORY_UNION_SENTENCE, PREMISE_POLICIES, premiseCheckPrompt } from "../benchmark/longmemeval-premise-check.js";
import { createModelCall, sha256, type Call, type Case, type ModelCall } from "../benchmark/longmemeval-qa-support.js";

const question = "How many days did I attend workshops, lectures and conferences?";
const sessions = Array.from({ length: 22 }, (_, index) => ({
  id: `opaque-${index}`, date: `2026/10/${String((index % 27) + 1).padStart(2, "0")} (Mon) 09:30`,
  text: `user: Archive note ${index} about a lecture I attended.`,
}));
const ids = sessions.slice(0, 20).map((session) => session.id);
const occurrences = ids.map((_, index) => index);
const item: Case = {
  question_id: "premise-policy", question_type: "multi-session", is_abstention: false, question, question_date: "2026/10/20",
  reference: "REFERENCE_SENTINEL", gold_session_ids: ["opaque-3"],
  answer_prompt_prefix: `Rules.\nQuestion: ${question}\nQuestion Date: 2026/10/20\n\nRetrieved Context:\n__RECALL_CONTEXT__`,
  judge_prompt_template: "Reference: REFERENCE_SENTINEL\nCandidate: __RECALL_CANDIDATE__", sessions,
};
const call = (text: string): Call => ({ text, error: null, attempts: 1, elapsed_ms: 1, model: "stub", usage: null, prompt_sha256: "stub" });
const evalOptions = {
  retrieval: "cached" as const, topK: 20, contextChars: 180_000, evidence: "supplemental" as const, evidencePolicy: "system" as const,
  answerCheck: "premise" as const,
};

function files() {
  const dir = makeTemp("/tmp/recall-lme-premise-policy-");
  const input = join(dir, "input.json"), rankings = join(dir, "rankings.json");
  writeFileSync(input, JSON.stringify({ provenance: {}, cases: [item] }));
  writeFileSync(rankings, JSON.stringify({ status: "complete", results: [{ question_id: item.question_id, retrieved_session_ids: ids, retrieved_session_occurrences: occurrences }] }));
  return { input, rankings, out: join(dir, "report.json") };
}
const baseOptions = (overrides: Partial<Options> = {}): Options => ({
  ...files(), provider: "qwen-local", retrieval: "cached", concurrency: 3, contextChars: 180_000, topK: 20,
  evidence: "supplemental", requestMode: "robust", answerCheck: "premise", reasoningEffort: "adaptive", maxOutputTokens: 16_384,
  evidencePolicy: "system", answerPolicy: "minimal", answerRecovery: "longer-timeout-transport", ...overrides,
});

async function run(policy: "original" | "category-union" | undefined) {
  const prompts: Record<string, string> = {};
  const stub: ModelCall = async (kind, prompt) => {
    prompts[kind] = prompt;
    if (kind === "answer") return call('{"reasoning":"r","answer":"3 days"}');
    if (kind === "premise") return call('{"correct":true,"reason":"ok"}');
    return call('{"correct":true,"reason":"ok"}');
  };
  const row = await evaluateCase(item, { ...evalOptions, premisePolicy: policy }, ids, stub, occurrences);
  return { row, prompts };
}

const tempRoots: string[] = [];
const makeTemp = (prefix: string): string => { const dir = mkdtempSync(prefix); tempRoots.push(dir); return dir; };
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("premise policy", () => {
  it("keeps the default prompt bytes identical to the pre-change prompt", () => {
    const fixed = premiseCheckPrompt("How many days did I attend workshops, lectures and conferences?", "2026-10-01T00:00:00+00:00", "## Memory 1\nuser: I attended a lecture.");
    expect(sha256(fixed)).toBe("4068f488acb88bc49de14e2f183ac95324a5c896851349e69e830b98a160482d");
    expect(premiseCheckPrompt("q", "d", "e", "original")).toBe(premiseCheckPrompt("q", "d", "e"));
    expect(premiseCheckPrompt("q", "d", "e")).not.toContain(CATEGORY_UNION_SENTENCE);
    expect([...PREMISE_POLICIES]).toEqual(["original", "category-union"]);
  });

  it("adds exactly one sentence for category-union, leaves the original prompt otherwise byte-identical, and carries no benchmark wording", () => {
    const original = premiseCheckPrompt("q", "d", "e");
    const union = premiseCheckPrompt("q", "d", "e", "category-union");
    expect(union.replace(`\n${CATEGORY_UNION_SENTENCE}`, "")).toBe(original);
    expect(union.split(CATEGORY_UNION_SENTENCE).length).toBe(2);
    expect(CATEGORY_UNION_SENTENCE).not.toMatch(/workshop|lecture|conference|smoker|hybrid|gravel/i);
    expect(original).toContain("set false if either one is never mentioned");
    expect(() => premiseCheckPrompt("q", "d", "e", "other" as never)).toThrow("Invalid premise policy");
  });

  it("changes only the premise prompt: answer and judge prompts and call kinds are identical across policies", async () => {
    const control = await run(undefined), explicit = await run("original"), union = await run("category-union");
    expect(explicit.prompts).toEqual(control.prompts);
    expect(union.prompts.answer).toBe(control.prompts.answer);
    expect(union.prompts.judge).toBe(control.prompts.judge);
    expect(union.prompts.premise).not.toBe(control.prompts.premise);
    expect(union.prompts.premise).toContain(CATEGORY_UNION_SENTENCE);
    expect(control.prompts.premise).not.toContain(CATEGORY_UNION_SENTENCE);
    for (const forbidden of ["REFERENCE_SENTINEL", "opaque-", "premise-policy", "multi-session"]) expect(union.prompts.premise).not.toContain(forbidden);
    expect(union.row.correct).toBe(control.row.correct);
  });

  it("parses --premise-policy and rejects invalid values", () => {
    expect("premisePolicy" in parseArgs(["--out", "r.json"])).toBe(false);
    expect(parseArgs(["--out", "r.json", "--premise-policy", "category-union"]).premisePolicy).toBe("category-union");
    expect(() => parseArgs(["--out", "r.json", "--premise-policy", "broad"])).toThrow("Invalid premise policy");
  });

  it("rejects unsupported premise-policy combinations before credentials, files or calls", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("fetch must not run"); });
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("DGX_BASE_URL", ""); vi.stubEnv("DGX_KEY_FILE", "");
    const invalid: Partial<Options>[] = [
      { answerCheck: "none" }, { answerCheck: undefined }, { answerCheck: "grounded" },
      { evidence: "additive" }, { evidence: "highlighted" }, { evidence: undefined },
    ];
    // Grounded checks are refused earlier by the answer-policy validator; both fire before credentials.
    const rejection = /--premise-policy requires|cannot use grounded answer checks/;
    for (const overrides of invalid) {
      let calls = 0;
      const options = baseOptions({ premisePolicy: "category-union", ...overrides });
      await expect(runEvaluation(options, async () => { calls++; return call("{}"); }), JSON.stringify(overrides)).rejects.toThrow(rejection);
      expect(calls).toBe(0);
      await expect(runEvaluation(options), JSON.stringify(overrides)).rejects.toThrow(rejection);
    }
    await expect(runEvaluation(baseOptions({ premisePolicy: "bogus" as never }))).rejects.toThrow(/--premise-policy requires/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records premise_policy metadata only for category-union and leaves default reports unchanged", async () => {
    const okCall: ModelCall = async (kind) => call(kind === "answer" ? '{"reasoning":"r","answer":"a"}' : '{"correct":true,"reason":"ok"}');
    const plain = baseOptions(), union = baseOptions({ premisePolicy: "category-union" }), original = baseOptions({ premisePolicy: "original" });
    for (const options of [plain, union, original]) await runEvaluation(options, okCall);
    const read = (options: Options) => JSON.parse(readFileSync(options.out, "utf8")) as { premise_policy?: { policy: string; prompt_source_sha256: string }; hashes: { code: Record<string, string> }; invocation: Options };
    expect("premise_policy" in read(plain)).toBe(false);
    expect("premise_policy" in read(original)).toBe(false);
    expect(read(union).premise_policy?.policy).toBe("category-union");
    expect(read(union).invocation.premisePolicy).toBe("category-union");
    const premisePath = Object.keys(read(union).hashes.code).find((path) => path.endsWith("longmemeval-premise-check.ts"))!;
    expect(read(union).premise_policy?.prompt_source_sha256).toBe(read(union).hashes.code[premisePath]);
    expect("premisePolicy" in read(plain).invocation).toBe(false);
  });

  it("sends unchanged native request settings for answer, premise and judge", async () => {
    const keyFile = join(makeTemp("/tmp/recall-lme-premise-key-"), "key");
    writeFileSync(keyFile, "test-token\n");
    vi.stubEnv("DGX_BASE_URL", "http://127.0.0.1:9/v1");
    vi.stubEnv("DGX_KEY_FILE", keyFile);
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ status: "completed", output_text: '{"reasoning":"r","answer":"a","correct":true,"reason":"ok"}' })));
    vi.stubGlobal("fetch", fetchSpy);
    const model = createModelCall("qwen-local", undefined, { structuredOutput: true, reasoningEffort: "adaptive", maxOutputTokens: 16_384 });
    const unionPrompt = premiseCheckPrompt("q", "d", "e", "category-union");
    await model("answer", "answer prompt", { question });
    await model("premise", unionPrompt);
    await model("judge", "judge prompt");
    type Body = { reasoning: { effort: string }; max_output_tokens: number; input: { role: string; content: string }[]; text: { format: { name: string } } };
    const bodies = fetchSpy.mock.calls.map((args) => JSON.parse((args as unknown as [string, { body: string }])[1].body) as Body);
    expect(bodies.map((body) => [body.reasoning.effort, body.max_output_tokens, body.text.format.name]))
      .toEqual([["high", 16_384, "benchmark_answer"], ["low", 4_096, "benchmark_premise"], ["none", 4_096, "benchmark_judge"]]);
    expect(bodies[1]!.input[1]!.content).toBe(unionPrompt);
  });
});

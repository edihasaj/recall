import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateCase, runEvaluation, parseArgs, type Options } from "../benchmark/longmemeval-qa.js";
import { createModelCall, sha256, type Call, type Case, type ModelCall } from "../benchmark/longmemeval-qa-support.js";
import { buildSourceTurns, flattenTurns } from "../benchmark/longmemeval-source-turns.js";
import { questionSourcesHash } from "../benchmark/longmemeval-source-identity.js";
import { statementCodePaths } from "../benchmark/longmemeval-statement-qa.js";

const question = "Which pottery activity does Nila prefer?";
const date = (index: number) => `2026/10/${String((index % 27) + 1).padStart(2, "0")} (Mon) 09:30`;
const turnsFor = (index: number): { role: string; content: string; has_answer?: boolean }[] => index === 25
  ? [
    { role: "user", content: "Nila prefers the kiln pottery activity EXTRA_FACT_SENTINEL.", has_answer: true },
    { role: "assistant", content: "Noted.\nuser: INNER_FAKE_LINE" },
  ]
  : [{ role: "user", content: index < 20 ? `Archive note ${index} about gardening.` : `Unrelated groceries ${index}.` }];
const rawTurns = Array.from({ length: 30 }, (_, index) => turnsFor(index));
const sessions = rawTurns.map((turns, index) => ({
  id: index === 25 ? "answer_GOLD_SOURCE_ID" : `opaque-source-${index}`,
  date: date(index),
  text: turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n"),
}));
const ids = sessions.slice(0, 20).map((session) => session.id);
const occurrences = ids.map((_, index) => index);
const item: Case = {
  question_id: "statement-case", question_type: "single-session-user", is_abstention: false,
  question, question_date: "2026/10/20", reference: "REFERENCE_SENTINEL",
  gold_session_ids: ["answer_GOLD_SOURCE_ID"],
  answer_prompt_prefix: `Task rules.\nQuestion: ${question}\nQuestion Date: 2026/10/20\n\nRetrieved Context:\n__RECALL_CONTEXT__`,
  judge_prompt_template: "Reference: REFERENCE_SENTINEL\nCandidate: __RECALL_CANDIDATE__",
  sessions,
};
const spannedItem: Case = { ...item, sessions: sessions.map((session, index) => ({ ...session, speaker_spans: flattenTurns(rawTurns[index]).spans })) };
const evalOptions = { retrieval: "cached" as const, topK: 20, contextChars: 180_000, evidence: "statements" as const, evidencePolicy: "system" as const };

const call = (text: string): Call => ({ text, error: null, attempts: 1, elapsed_ms: 1, model: "stub", usage: null, prompt_sha256: "stub" });

function files(ranking: Record<string, unknown> = { retrieved_session_occurrences: occurrences }) {
  const dir = mkdtempSync("/tmp/recall-lme-statement-qa-");
  const input = join(dir, "input.json"), rankings = join(dir, "rankings.json"), raw = join(dir, "raw.json"), sourceTurns = join(dir, "turns.json");
  const rawBytes = Buffer.from(JSON.stringify([{
    question_id: item.question_id, question_type: item.question_type, question, answer: "REFERENCE_SENTINEL",
    answer_session_ids: item.gold_session_ids, haystack_session_ids: sessions.map((session) => session.id),
    haystack_dates: sessions.map((session) => session.date), haystack_sessions: rawTurns,
  }]));
  const inputBytes = Buffer.from(JSON.stringify({ provenance: { dataset_sha256: sha256(rawBytes) }, cases: [item] }));
  writeFileSync(raw, rawBytes);
  writeFileSync(input, inputBytes);
  writeFileSync(sourceTurns, JSON.stringify(buildSourceTurns(rawBytes, inputBytes)));
  writeFileSync(rankings, JSON.stringify({
    status: "complete",
    results: [{ question_id: item.question_id, retrieved_session_ids: ids, source_sha256: questionSourcesHash(question, sessions), ...ranking }],
  }));
  return { input, rankings, out: join(dir, "report.json"), sourceTurns };
}

function statementOptions(overrides: Partial<Options> = {}, ranking?: Record<string, unknown>): Options {
  return {
    ...files(ranking), provider: "qwen-local", retrieval: "cached", concurrency: 3, contextChars: 180_000, topK: 20,
    evidence: "statements", requestMode: "robust", answerCheck: "premise", reasoningEffort: "adaptive",
    maxOutputTokens: 16_384, evidencePolicy: "system", answerPolicy: "minimal",
    answerRecovery: "longer-timeout-transport", ...overrides,
  };
}

const prepOptions = (overrides: Partial<Options> = {}): Options => statementOptions({
  provider: undefined, requestMode: undefined, answerCheck: undefined, reasoningEffort: undefined,
  maxOutputTokens: undefined, evidencePolicy: undefined, answerPolicy: undefined, answerRecovery: undefined, ...overrides,
});

const okStub = (kinds: string[] = [], prompts: string[] = []): ModelCall => async (kind, prompt) => {
  kinds.push(kind);
  if (kind === "answer") { prompts.push(prompt); return call('{"reasoning":"quoted","answer":"kiln pottery"}'); }
  if (kind === "premise") return call('{"correct":true,"reason":"supported"}');
  expect(prompt).toContain("REFERENCE_SENTINEL");
  return call('{"correct":true,"reason":"matches"}');
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("LongMemEval statement QA", () => {
  it("is opt-in and leaves the default evidence mode unset", () => {
    expect(parseArgs(["--out", "r.json", "--evidence", "statements"]).evidence).toBe("statements");
    expect("evidence" in parseArgs(["--out", "r.json"])).toBe(false);
    expect(() => parseArgs(["--out", "r.json", "--evidence", "statement"])).toThrow("Invalid evidence mode");
  });

  it("delivers the extra user fact to the injected answer prompt without identifiers, with cap and provenance recorded", async () => {
    const options = statementOptions();
    const kinds: string[] = [], prompts: string[] = [];
    const report = await runEvaluation(options, okStub(kinds, prompts));
    const row = report.results[0]!;

    expect(row.error).toBeNull();
    expect(kinds).toEqual(["answer", "premise", "judge"]);
    expect(row.correct).toBe(true);
    const prompt = prompts[0]!;
    expect(prompt).toContain("EXTRA_FACT_SENTINEL");
    expect(prompt).toMatch(/## Memory \d+/);
    for (const forbidden of [
      "answer_GOLD_SOURCE_ID", "opaque-source", "REFERENCE_SENTINEL", "has_answer", "occurrence",
      item.question_id, item.question_type, "Lexical",
    ]) expect(prompt).not.toContain(forbidden);
    expect(prompt).toContain(row.evidence!.text);
    expect(row.evidence!.chars).toBeLessThanOrEqual(180_000);
    expect(row.evidence!.sources.length).toBeLessThanOrEqual(40);
    expect(row.evidence!.sources.slice(0, 20).map((source) => [source.id, source.occurrence])).toEqual(ids.map((id, index) => [id, index]));
    expect(row.evidence!.sources.filter((source) => source.used_chars > 0).map((source) => source.occurrence)).toContain(25);
    expect(row.statements_diagnostics).toMatchObject({
      selected_occurrences: [...occurrences, 25], lexical_pool: 80, lexical_limit: 20, per_source_raw_chars: 4_000,
      max_chars: 180_000, omitted_occurrences: [],
      gold_source_coverage: {
        original_any: false, original_all: false, appended_selected_any: true,
        appended_included_any: true, combined_any: true, combined_all: true,
      },
    });
    expect(row.statements_diagnostics).toHaveProperty("preferred_speaker");
    expect(row.additive_diagnostics).toBeUndefined();
    expect([row.gold_any, row.gold_all]).toEqual([true, true]);

    const written = JSON.parse(readFileSync(options.out, "utf8")) as {
      invocation: Options; hashes: { code: Record<string, string> }; limitations: string[];
      source_verification: string; comparison_valid: boolean; statement_evidence: Record<string, unknown>;
      results: { statements_diagnostics: unknown }[];
    };
    expect(written.source_verification).toBe("per_question_hash");
    expect(written.invocation).toMatchObject({
      evidence: "statements", topK: 20, contextChars: 180_000, provider: "qwen-local", requestMode: "robust",
      evidencePolicy: "system", reasoningEffort: "adaptive", maxOutputTokens: 16_384, answerPolicy: "minimal",
      answerCheck: "premise", answerRecovery: "longer-timeout-transport", concurrency: 3,
    });
    expect(written.statement_evidence).toMatchObject({
      original_sources: 20, lexical_pool: 80, lexical_limit: 20, per_source_raw_chars: 4_000, max_chars: 180_000,
    });
    expect((written as unknown as { source_turns_manifest: Record<string, unknown> }).source_turns_manifest).toMatchObject({
      path: options.sourceTurns, sha256: sha256(readFileSync(options.sourceTurns!)), verified_cases: 1,
    });
    expect("additive_evidence" in written).toBe(false);
    const [qaPath, helperPath, turnsPath, rendererPath] = statementCodePaths();
    for (const path of [qaPath!, helperPath!, turnsPath!, rendererPath!]) expect(written.hashes.code[path]).toBe(sha256(readFileSync(path)));
    expect(written.statement_evidence.helper_source_sha256).toBe(written.hashes.code[helperPath!]);
    expect(written.statement_evidence.renderer_source_sha256).toBe(written.hashes.code[rendererPath!]);
    expect(Object.keys(written.hashes.code).some((path) => path.includes("longmemeval-additive-evidence"))).toBe(false);
    expect(written.comparison_valid).toBe(false);
    expect(written.limitations.some((line) => line.includes("Statement evidence") && line.includes("gold IDs"))).toBe(true);
    expect(written.results[0]!.statements_diagnostics).toEqual(row.statements_diagnostics);
  });

  it("never lets gold labels, reference or question metadata change the selected evidence", async () => {
    const base = await evaluateCase(spannedItem, evalOptions, ids, undefined, occurrences);
    const altered = await evaluateCase(
      { ...spannedItem, gold_session_ids: ["opaque-source-3"], reference: "OTHER", question_id: "x", question_type: "temporal-reasoning" },
      evalOptions, ids, undefined, occurrences,
    );
    expect(altered.evidence).toEqual(base.evidence);
    expect(altered.statements_diagnostics?.selected_occurrences).toEqual(base.statements_diagnostics?.selected_occurrences);
    expect(altered.statements_diagnostics?.gold_source_coverage).toMatchObject({ original_any: true, appended_selected_any: false });
  });

  it("counts only sources that rendered text toward gold coverage", async () => {
    const row = await evaluateCase(spannedItem, evalOptions, ids, undefined, occurrences);
    const used = new Set(row.evidence!.sources.filter((source) => source.used_chars > 0).map((source) => source.id));
    expect(row.gold_any).toBe(used.has("answer_GOLD_SOURCE_ID"));
    expect(row.statements_diagnostics?.rendered_sources).toBe(used.size);
  });

  it("prepares offline without a provider or fetch", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("fetch must not run"); });
    vi.stubGlobal("fetch", fetchSpy);
    const options = prepOptions();
    const prepared = await runEvaluation(options);
    const row = prepared.results[0]!;
    expect(prepared.status).toBe("complete");
    expect(row.error).toBeNull();
    expect(row.answer_call).toBeNull();
    expect(row.evidence?.text).toContain("EXTRA_FACT_SENTINEL");
    expect((JSON.parse(readFileSync(options.out, "utf8")) as { comparison_valid: boolean }).comparison_valid).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects invalid configurations before any call or fetch", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("fetch must not run"); });
    vi.stubGlobal("fetch", fetchSpy);
    const invalid: Partial<Options>[] = [
      { topK: 10 }, { contextChars: 20_000 }, { contextChars: 260_000 }, { evidenceLedger: "quoted" },
      { answerSamples: 3 }, { answerProvider: "azure" }, { answerCheck: "grounded" }, { answerCheck: "none" },
      { answerCheck: undefined }, { answerPolicy: undefined }, { answerPolicy: "minimal-v2" },
      { answerRecovery: "lower-effort-transport" }, { answerRecovery: undefined },
      { reasoningEffort: "high" }, { maxOutputTokens: 4_096 }, { requestMode: "standard" },
      { evidencePolicy: "inline" }, { concurrency: 4 }, { provider: "gemini" }, { retrieval: "lexical", rankings: undefined },
    ];
    for (const overrides of invalid) {
      let calls = 0;
      await expect(runEvaluation(statementOptions(overrides), async () => { calls++; return call('{"answer":"unused"}'); }), JSON.stringify(overrides)).rejects.toThrow();
      expect(calls).toBe(0);
    }
    for (const overrides of [{ topK: 10 }, { answerSamples: 2 }, { concurrency: 5 }]) {
      await expect(runEvaluation(prepOptions(overrides)), JSON.stringify(overrides)).rejects.toThrow();
    }
    await expect(runEvaluation(statementOptions({ answerSamples: 2 }))).rejects.toThrow(/Statement evidence requires a single answer sample/);
    await expect(runEvaluation(statementOptions({ topK: 10 }))).rejects.toThrow(/Statement evidence requires --top-k 20/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires exact ranking occurrences before invoking the call", async () => {
    let calls = 0;
    const options = statementOptions({}, { retrieved_session_occurrences: undefined });
    await expect(runEvaluation(options, async () => { calls++; return call("{}"); })).rejects.toThrow(/Statement evidence requires exact ranking occurrences/);
    expect(calls).toBe(0);
  });

  it("rejects a ranking whose source fingerprint does not match before any call", async () => {
    let calls = 0;
    const options = statementOptions({}, { source_sha256: "0".repeat(64) });
    await expect(runEvaluation(options, async () => { calls++; return call("{}"); })).rejects.toThrow("Ranking source fingerprint mismatch");
    expect(calls).toBe(0);
  });

  it("includes the fresh lexical search and rendering in retrieval_ms", async () => {
    let tick = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (tick += 1_000));
    const row = await evaluateCase(spannedItem, evalOptions, ids, undefined, occurrences);
    expect(row.error).toBeNull();
    // start, the stop after cached ranking, then a second stop after lexical search and rendering.
    expect(row.retrieval_ms).toBeGreaterThan(1_000);
    expect(row.statements_diagnostics?.selected_occurrences).toEqual([...occurrences, 25]);
  });

  it("records an incomplete ranking as an error row without evidence", async () => {
    const row = await evaluateCase(spannedItem, { ...evalOptions, evidencePolicy: undefined }, ids, undefined, undefined);
    expect(row.error).toBe("statement_ranking_incomplete");
    expect(row.evidence).toBeNull();
  });

  it("leaves additive and supplemental reports unaffected", async () => {
    for (const overrides of [{ evidence: "additive" as const, sourceTurns: undefined }, { evidence: "supplemental" as const, evidencePolicy: "system" as const, sourceTurns: undefined }]) {
      const options = prepOptions(overrides);
      const prepared = await runEvaluation(options);
      expect(prepared.results[0]!.statements_diagnostics).toBeUndefined();
      const written = JSON.parse(readFileSync(options.out, "utf8")) as { hashes: { code: Record<string, string> }; comparison_valid: boolean };
      expect("statement_evidence" in written).toBe(false);
      expect(Object.keys(written.hashes.code).some((path) => path.includes("longmemeval-statement"))).toBe(false);
      expect(written.comparison_valid).toBe(true);
    }
    const supplemental = statementOptions({ evidence: "supplemental", sourceTurns: undefined });
    await runEvaluation(supplemental, okStub());
    expect((JSON.parse(readFileSync(supplemental.out, "utf8")) as { comparison_valid: boolean }).comparison_valid).toBe(true);
  });
  it("requires --source-turns for statements and rejects it for every other mode before any call", async () => {
    let calls = 0;
    const counting: ModelCall = async () => { calls++; return call("{}"); };
    await expect(runEvaluation(statementOptions({ sourceTurns: undefined }), counting)).rejects.toThrow("Statement evidence requires --source-turns");
    for (const evidence of ["additive", "supplemental", undefined] as const) {
      await expect(runEvaluation(statementOptions({ evidence }), counting), String(evidence)).rejects.toThrow("--source-turns is only valid with --evidence statements");
    }
    expect(calls).toBe(0);
    expect(parseArgs(["--out", "r.json", "--source-turns", "m.json"]).sourceTurns).toBe("m.json");
  });

  it("rejects a tampered manifest before credentials, createModelCall or any fetch", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("fetch must not run"); });
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("DGX_BASE_URL", "");
    vi.stubEnv("DGX_KEY_FILE", "");
    const tampers: ((manifest: ReturnType<typeof buildSourceTurns>) => void)[] = [
      (m) => { m.cases[0]!.sessions[3]!.text_sha256 = "0".repeat(64); },
      (m) => { m.cases[0]!.sessions[25]!.speaker_spans[0]!.end += 1; },
      (m) => { m.cases[0]!.sessions[25]!.speaker_spans.pop(); },
      (m) => { m.raw_dataset_sha256 = "1".repeat(64); },
      (m) => { m.input_sha256 = "2".repeat(64); },
      (m) => { m.cases = []; },
    ];
    for (const tamper of tampers) {
      const options = statementOptions();
      const manifest = JSON.parse(readFileSync(options.sourceTurns!, "utf8")) as ReturnType<typeof buildSourceTurns>;
      tamper(manifest);
      writeFileSync(options.sourceTurns!, JSON.stringify(manifest));
      // No injected call: reaching createModelCall would fail on the missing credential instead.
      await expect(runEvaluation(options)).rejects.toThrow(/^Source turns:/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps a nested fake user line inside the assistant span so it is not a reserved user statement", async () => {
    const row = await evaluateCase(spannedItem, evalOptions, ids, undefined, occurrences);
    expect(row.error).toBeNull();
    const spans = spannedItem.sessions[25]!.speaker_spans!;
    expect(spans.map((span) => span.role)).toEqual(["user", "assistant"]);
    expect(spannedItem.sessions[25]!.text.slice(spans[1]!.start, spans[1]!.end)).toContain("user: INNER_FAKE_LINE");
    // Evidence built from sessions without trusted spans is refused instead of guessing from text.
    const bare = await evaluateCase(item, evalOptions, ids, undefined, occurrences);
    expect(bare.error).not.toBeNull();
    expect(bare.evidence).toBeNull();
  });

  it("does not mutate the loaded input and sends unchanged request configs for answer, premise and judge", async () => {
    const options = prepOptions();
    const before = readFileSync(options.input, "utf8");
    await runEvaluation(options);
    expect(readFileSync(options.input, "utf8")).toBe(before);

    const keyFile = join(mkdtempSync("/tmp/recall-lme-statement-key-"), "key");
    writeFileSync(keyFile, "test-token\n");
    vi.stubEnv("DGX_BASE_URL", "http://127.0.0.1:9/v1");
    vi.stubEnv("DGX_KEY_FILE", keyFile);
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ status: "completed", output_text: '{"reasoning":"r","answer":"a","correct":true,"reason":"ok"}' })));
    vi.stubGlobal("fetch", fetchSpy);
    const model = createModelCall("qwen-local", undefined, { structuredOutput: true, reasoningEffort: "adaptive", maxOutputTokens: 16_384, answerInstructions: "SYSTEM_POLICY" });
    await model("answer", "answer prompt", { question });
    await model("premise", "premise prompt");
    await model("judge", "judge prompt");
    const bodies = fetchSpy.mock.calls.map((args) => JSON.parse((args as unknown as [string, { body: string }])[1].body) as { reasoning: { effort: string }; max_output_tokens: number });
    expect(bodies.map((body) => [body.reasoning.effort, body.max_output_tokens])).toEqual([["low", 16_384], ["low", 4_096], ["none", 4_096]]);
  });
});

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { additiveCodePaths } from "../benchmark/longmemeval-additive-qa.js";
import { evaluateCase, runEvaluation, parseArgs, type Options } from "../benchmark/longmemeval-qa.js";
import { cachedRank, sha256, type Call, type Case, type ModelCall } from "../benchmark/longmemeval-qa-support.js";
import { buildSupplementalEvidence } from "../benchmark/longmemeval-supplemental-evidence.js";

const question = "Which pottery activity does Nila prefer?";
const date = (index: number) => `2026/10/${String((index % 27) + 1).padStart(2, "0")} (Mon) 09:30`;
const sessions = Array.from({ length: 30 }, (_, index) => ({
  id: index === 25 ? "answer_GOLD_SOURCE_ID" : `opaque-source-${index}`,
  date: date(index),
  text: index === 25
    ? "user: Nila prefers the kiln pottery activity EXTRA_FACT_SENTINEL."
    : index < 20 ? `user: Archive note ${index} about gardening.` : `user: Unrelated groceries ${index}.`,
}));
const ids = sessions.slice(0, 20).map((session) => session.id);
const occurrences = ids.map((_, index) => index);
const item: Case = {
  question_id: "additive-case", question_type: "single-session-user", is_abstention: false,
  question, question_date: "2026/10/20", reference: "REFERENCE_SENTINEL",
  gold_session_ids: ["answer_GOLD_SOURCE_ID"],
  answer_prompt_prefix: `Task rules.\nQuestion: ${question}\nQuestion Date: 2026/10/20\n\nRetrieved Context:\n__RECALL_CONTEXT__`,
  judge_prompt_template: "Reference: REFERENCE_SENTINEL\nCandidate: __RECALL_CANDIDATE__",
  sessions,
};

const call = (text: string): Call => ({ text, error: null, attempts: 1, elapsed_ms: 1, model: "stub", usage: null, prompt_sha256: "stub" });

function files(ranking: Record<string, unknown> = { retrieved_session_occurrences: occurrences }) {
  const dir = mkdtempSync(join(tmpdir(), "recall-lme-additive-qa-"));
  const input = join(dir, "input.json"), rankings = join(dir, "rankings.json");
  writeFileSync(input, JSON.stringify({ provenance: {}, cases: [item] }));
  writeFileSync(rankings, JSON.stringify({ status: "complete", results: [{ question_id: item.question_id, retrieved_session_ids: ids, ...ranking }] }));
  return { input, rankings, out: join(dir, "report.json") };
}

function additiveOptions(overrides: Partial<Options> = {}, ranking?: Record<string, unknown>): Options {
  return {
    ...files(ranking), provider: "qwen-local", retrieval: "cached", concurrency: 3, contextChars: 180_000, topK: 20,
    evidence: "additive", requestMode: "robust", answerCheck: "premise", reasoningEffort: "adaptive",
    maxOutputTokens: 16_384, evidencePolicy: "system", answerPolicy: "minimal",
    answerRecovery: "longer-timeout-transport", ...overrides,
  };
}

const prepOptions = (overrides: Partial<Options> = {}): Options => additiveOptions({
  provider: undefined, requestMode: undefined, answerCheck: undefined, reasoningEffort: undefined,
  maxOutputTokens: undefined, evidencePolicy: undefined, answerPolicy: undefined, answerRecovery: undefined, ...overrides,
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("LongMemEval additive QA", () => {
  it("is opt-in and leaves the default evidence mode unset", () => {
    expect(parseArgs(["--out", "r.json", "--evidence", "additive"]).evidence).toBe("additive");
    const defaults = parseArgs(["--out", "r.json"]);
    expect("evidence" in defaults).toBe(false);
    expect(defaults.topK).toBe(10);
    expect(defaults.contextChars).toBe(180_000);
    expect(() => parseArgs(["--out", "r.json", "--evidence", "additive-x"])).toThrow("Invalid evidence mode");
  });

  it("delivers the appended lexical fact without identifiers, keeping the original twenty as an exact prefix", async () => {
    const options = additiveOptions();
    const kinds: string[] = [];
    const prompts: string[] = [];
    const stub: ModelCall = async (kind, prompt) => {
      kinds.push(kind);
      if (kind === "answer") {
        prompts.push(prompt);
        return call('{"reasoning":"quoted","answer":"kiln pottery"}');
      }
      if (kind === "premise") return call('{"correct":true,"reason":"supported"}');
      expect(prompt).toContain("REFERENCE_SENTINEL");
      return call('{"correct":true,"reason":"matches"}');
    };
    const report = await runEvaluation(options, stub);
    const row = report.results[0]!;

    expect(row.error).toBeNull();
    expect(kinds).toEqual(["answer", "premise", "judge"]);
    expect(row.correct).toBe(true);
    const prompt = prompts[0]!;
    expect(prompt).toContain("EXTRA_FACT_SENTINEL");
    expect(prompt).toContain("## Lexical Memory 21");
    for (const forbidden of ["answer_GOLD_SOURCE_ID", "opaque-source", "REFERENCE_SENTINEL", "occurrence", "has_answer"]) {
      expect(prompt).not.toContain(forbidden);
    }
    const base = buildSupplementalEvidence(cachedRank(sessions, ids, 20, occurrences), question, 180_000, false);
    expect(prompt).toContain(base.text);
    expect(row.evidence?.text.startsWith(base.text)).toBe(true);
    expect(row.evidence?.sources.slice(0, 20)).toEqual(base.sources);
    expect(row.evidence?.sources.slice(0, 20).every((source) => source.used_chars > 0)).toBe(true);
    expect(row.evidence?.sources.slice(0, 20).map((source) => [source.id, source.occurrence]))
      .toEqual(ids.map((id, index) => [id, index]));
    expect(row.evidence?.chars).toBeLessThanOrEqual(260_000);
    expect(row.supplemental_diagnostics).toEqual((base as { supplemental: unknown }).supplemental);
    expect(row.additive_diagnostics).toMatchObject({
      base_chars: base.text.length, selected_occurrences: [25], included_ranks: [21], omitted: [],
      lexical_pool: 80, appended_sources: 1,
      gold_source_coverage: {
        original_any: false, original_all: false, appended_selected_any: true,
        appended_included_any: true, combined_any: true, combined_all: true,
      },
    });
    expect([row.gold_any, row.gold_all]).toEqual([true, true]);

    const written = JSON.parse(readFileSync(options.out, "utf8")) as {
      invocation: Options; hashes: { code: Record<string, string> }; limitations: string[];
      additive_evidence: Record<string, unknown>;
      results: { additive_diagnostics: unknown; supplemental_diagnostics: unknown }[];
    };
    expect(written.invocation).toMatchObject({
      evidence: "additive", topK: 20, contextChars: 180_000, provider: "qwen-local", requestMode: "robust",
      evidencePolicy: "system", reasoningEffort: "adaptive", maxOutputTokens: 16_384, answerPolicy: "minimal",
      answerCheck: "premise", answerRecovery: "longer-timeout-transport", concurrency: 3,
    });
    expect(written.additive_evidence).toMatchObject({
      base_chars: 180_000, extra_chars: 80_000, total_chars_cap: 260_000, source_limit: 40,
      original_sources: 20, lexical_pool: 80, lexical_limit: 20, per_source_chars: 4_000, raw_unit_chars: 3_800,
    });
    for (const path of additiveCodePaths()) expect(written.hashes.code[path]).toBe(sha256(readFileSync(path)));
    expect(Object.keys(written.hashes.code).some((path) => path.endsWith("/src/history/evidence.ts"))).toBe(true);
    expect(written.additive_evidence.helper_source_sha256)
      .toBe(written.hashes.code[additiveCodePaths()[1]!]);
    expect(written.limitations.some((line) =>
      line.includes("combined treatment") && line.includes("260,000") && line.includes("gold IDs"),
    )).toBe(true);
    expect(written.results[0]!.additive_diagnostics).toEqual(row.additive_diagnostics);
  });

  it("prepares offline without a provider and matches supplemental evidence for the original twenty", async () => {
    const prepared = await runEvaluation(prepOptions());
    const row = prepared.results[0]!;
    expect(prepared.status).toBe("complete");
    expect(row.answer_call).toBeNull();
    expect(row.additive_diagnostics?.included_ranks).toEqual([21]);

    const supplementalOptions = prepOptions({ evidence: "supplemental", evidencePolicy: "system" });
    const supplemental = await runEvaluation(supplementalOptions);
    const reference = supplemental.results[0]!;
    expect(row.evidence?.text.startsWith(reference.evidence!.text)).toBe(true);
    expect(row.evidence?.sources.slice(0, 20)).toEqual(reference.evidence?.sources);
    expect(row.supplemental_diagnostics).toEqual(reference.supplemental_diagnostics);

    const written = JSON.parse(readFileSync(supplementalOptions.out, "utf8")) as { hashes: { code: Record<string, string> } };
    expect("additive_evidence" in written).toBe(false);
    expect(Object.keys(written.hashes.code).some((path) => path.includes("longmemeval-additive"))).toBe(false);
    expect(reference.additive_diagnostics).toBeUndefined();
  });

  it("rejects invalid configurations before any call or fetch", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("fetch must not run"); });
    vi.stubGlobal("fetch", fetchSpy);
    const invalid: Partial<Options>[] = [
      { topK: 10 }, { contextChars: 20_000 }, { contextChars: 260_000 }, { evidenceLedger: "quoted" },
      { answerSamples: 3 }, { answerProvider: "azure" }, { answerCheck: "grounded" }, { answerCheck: "none" },
      { answerCheck: undefined }, { answerPolicy: undefined }, { answerPolicy: "minimal-v2" },
      { answerRecovery: "lower-effort-transport" }, { answerRecovery: undefined },
      { reasoningEffort: "high" }, { reasoningEffort: "low" }, { maxOutputTokens: 4_096 },
      { requestMode: "standard" }, { evidencePolicy: "inline" }, { concurrency: 4 }, { provider: "gemini" },
    ];
    for (const overrides of invalid) {
      let calls = 0;
      await expect(runEvaluation(additiveOptions(overrides), async () => {
        calls++;
        return call('{"answer":"unused"}');
      }), JSON.stringify(overrides)).rejects.toThrow();
      expect(calls).toBe(0);
    }
    for (const overrides of [{ retrieval: "lexical" as const, rankings: undefined }, { topK: 10 }, { answerSamples: 2 }, { concurrency: 5 }]) {
      await expect(runEvaluation(prepOptions(overrides)), JSON.stringify(overrides)).rejects.toThrow();
    }
    // Without an injected call the real transport must not be reached for a rejected configuration.
    await expect(runEvaluation(additiveOptions({ answerSamples: 2 }))).rejects.toThrow(/single answer sample/);
    await expect(runEvaluation(additiveOptions({ topK: 10 }))).rejects.toThrow(/--top-k 20/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires exact ranking occurrences before invoking the call", async () => {
    let calls = 0;
    const options = additiveOptions({}, { retrieved_session_occurrences: undefined });
    await expect(runEvaluation(options, async () => { calls++; return call("{}"); }))
      .rejects.toThrow("exact ranking occurrences");
    expect(calls).toBe(0);
  });

  it("marks injected-call additive reports as not comparable, leaving offline preparation and prior modes valid", async () => {
    const injected = additiveOptions();
    await runEvaluation(injected, async (kind) => call(
      kind === "answer" ? '{"reasoning":"r","answer":"kiln pottery"}' : '{"correct":true,"reason":"ok"}'));
    expect((JSON.parse(readFileSync(injected.out, "utf8")) as { comparison_valid: boolean }).comparison_valid).toBe(false);

    const prepared = prepOptions();
    await runEvaluation(prepared);
    expect((JSON.parse(readFileSync(prepared.out, "utf8")) as { comparison_valid: boolean }).comparison_valid).toBe(true);

    const supplemental = additiveOptions({ evidence: "supplemental" });
    await runEvaluation(supplemental, async (kind) => call(
      kind === "answer" ? '{"reasoning":"r","answer":"x"}' : '{"correct":true,"reason":"ok"}'));
    expect((JSON.parse(readFileSync(supplemental.out, "utf8")) as { comparison_valid: boolean }).comparison_valid).toBe(true);
  });

  it("includes the fresh lexical search and rendering in additive retrieval_ms", async () => {
    let tick = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (tick += 1_000));
    const row = await evaluateCase(
      item,
      { retrieval: "cached", topK: 20, contextChars: 180_000, evidence: "additive", evidencePolicy: "system" },
      ids, undefined, occurrences,
    );
    expect(row.error).toBeNull();
    // start, the stop after cached ranking, then a second stop after lexical search and rendering.
    expect(row.retrieval_ms).toBeGreaterThan(1_000);
    expect(row.additive_diagnostics?.included_ranks).toEqual([21]);
  });
});

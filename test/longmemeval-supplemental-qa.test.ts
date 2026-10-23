import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHighlightedEvidence } from "../benchmark/longmemeval-highlighted-evidence.js";
import { evaluateCase, parseArgs, runEvaluation, type Options } from "../benchmark/longmemeval-qa.js";
import { cachedRank, sha256, type Call, type Case, type ModelCall } from "../benchmark/longmemeval-qa-support.js";

const question = "Which pottery activity does Nila prefer?";
const ids = Array.from({ length: 20 }, (_, index) =>
  index === 11 ? "answer_GOLD_SOURCE_ID" : `opaque-source-${index}`);
const occurrences = Array.from({ length: 20 }, (_, index) => index);
const case20: Case = {
  question_id: "supplemental-case",
  question_type: "single-session-user",
  is_abstention: false,
  question,
  question_date: "2026/10/20",
  reference: "REFERENCE_SENTINEL",
  gold_session_ids: ["answer_GOLD_SOURCE_ID"],
  answer_prompt_prefix: `Question: ${question}\n__RECALL_CONTEXT__`,
  judge_prompt_template: "Reference: REFERENCE_SENTINEL\nCandidate: __RECALL_CANDIDATE__",
  sessions: ids.map((id, index) => ({
    id,
    date: `2026/10/${String(index + 1).padStart(2, "0")} (Mon) 09:30`,
    text: `user: Nila prefers pottery activity option ${index}.`,
  })),
};

const call = (text: string | null, error: string | null = null): Call => ({
  text, error, attempts: 1, elapsed_ms: 1, model: "stub", usage: null, prompt_sha256: "stub",
});

function files() {
  const dir = mkdtempSync(join(tmpdir(), "recall-lme-supplemental-qa-"));
  const input = join(dir, "input.json");
  const rankings = join(dir, "rankings.json");
  writeFileSync(input, JSON.stringify({ provenance: {}, cases: [case20] }));
  writeFileSync(rankings, JSON.stringify({
    status: "complete",
    results: [{
      question_id: case20.question_id,
      retrieved_session_ids: ids,
      retrieved_session_occurrences: occurrences,
    }],
  }));
  return { input, rankings, out: join(dir, "report.json") };
}

function supplementalOptions(overrides: Partial<Options> = {}): Options {
  const paths = files();
  return {
    ...paths,
    provider: "qwen-local",
    retrieval: "cached",
    concurrency: 3,
    contextChars: 20_000,
    topK: 20,
    evidence: "supplemental",
    requestMode: "robust",
    answerCheck: "none",
    reasoningEffort: "adaptive",
    maxOutputTokens: 16_384,
    evidencePolicy: "system",
    evidenceLedger: "none",
    ...overrides,
  };
}

describe("LongMemEval supplemental QA", () => {
  it("accepts the supplemental CLI choice", () => {
    expect(parseArgs(["--out", "result.json", "--evidence", "supplemental"]).evidence)
      .toBe("supplemental");
    const defaults = parseArgs(["--out", "result.json"]);
    expect(defaults.topK).toBe(10);
    expect("evidence" in defaults).toBe(false);
  });

  it("renders exactly twenty neutral ranked sources, records diagnostics and only calls answer then judge", async () => {
    const options = supplementalOptions();
    const kinds: string[] = [];
    const stub: ModelCall = async (kind, prompt) => {
      kinds.push(kind);
      if (kind === "answer") {
        expect(prompt).toContain("## Memory 1");
        expect(prompt).toContain("## Additional Memory 11");
        expect(prompt).not.toContain("answer_GOLD_SOURCE_ID");
        expect(prompt).not.toContain("REFERENCE_SENTINEL");
        expect(prompt).not.toContain("occurrence");
        for (let rank = 1; rank <= 10; rank++) expect(prompt).toContain(`## Memory ${rank}`);
        for (let rank = 11; rank <= 20; rank++) expect(prompt).toContain(`## Additional Memory ${rank}`);
        return call('{"reasoning":"quoted evidence","answer":"pottery"}');
      }
      expect(prompt).toContain("REFERENCE_SENTINEL");
      expect(prompt).toContain("pottery");
      return call('{"correct":true,"reason":"matches"}');
    };

    const report = await runEvaluation(options, stub);
    const row = report.results[0]!;
    const evidence = row.evidence;
    expect(kinds).toEqual(["answer", "judge"]);
    expect(row.ledger_call).toBeUndefined();
    expect(row.review_call).toBeUndefined();
    expect(row.correct).toBe(true);
    expect(evidence?.sources).toHaveLength(20);
    expect(evidence?.sources.map((source) => [source.id, source.occurrence]))
      .toEqual(ids.map((id, index) => [id, index]));
    expect(evidence?.chars).toBeLessThanOrEqual(options.contextChars);
    expect(row.supplemental_diagnostics).toEqual({
      included_ranks: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
      omitted: [],
    });

    const written = JSON.parse(readFileSync(options.out, "utf8")) as {
      hashes: { code: Record<string, string> };
      supplemental_evidence: {
        primary_source_limit: number;
        supplemental_source_ranks: number[];
        per_source_chars: number;
        renderer_source_sha256: string;
      };
      limitations: string[];
      results: { supplemental_diagnostics: unknown }[];
      invocation: Options;
    };
    const supplementalPath = Object.keys(written.hashes.code)
      .find((path) => path.endsWith("/benchmark/longmemeval-supplemental-evidence.ts"));
    expect(supplementalPath).toBeDefined();
    expect(written.hashes.code[supplementalPath!])
      .toBe(sha256(readFileSync(supplementalPath!)));
    expect(written.supplemental_evidence).toMatchObject({
      primary_source_limit: 10,
      supplemental_source_ranks: [11, 20],
      per_source_chars: 4_000,
    });
    expect(written.supplemental_evidence.renderer_source_sha256)
      .toBe(sha256(readFileSync(supplementalPath!)));
    expect(written.results[0]!.supplemental_diagnostics).toEqual(row.supplemental_diagnostics);
    expect(written.limitations.some((line) =>
      line.includes("first ten ranked sources unchanged")
      && line.includes("ranks 11 through 20")
      && line.includes("4000-character per-source ceiling"),
    )).toBe(true);
    expect(written.invocation).toMatchObject({
      provider: "qwen-local",
      requestMode: "robust",
      evidencePolicy: "system",
      reasoningEffort: "adaptive",
      maxOutputTokens: 16_384,
      concurrency: 3,
    });
  });

  it("retains all source metadata and budget omissions at the primary boundary", async () => {
    const ranked = cachedRank(case20.sessions, ids, 20, occurrences);
    const unrestricted = buildHighlightedEvidence(ranked.slice(0, 10), question, 20_000, false);
    const row = await evaluateCase(
      case20,
      {
        retrieval: "cached",
        topK: 20,
        contextChars: unrestricted.chars,
        evidence: "supplemental",
        answerCheck: "none",
        evidencePolicy: "system",
        evidenceLedger: "none",
      },
      ids,
      undefined,
      occurrences,
    );

    expect(row.error).toBeNull();
    expect(row.evidence?.text).toBe(unrestricted.text);
    expect(row.evidence?.sources.slice(0, 10)).toEqual(unrestricted.sources);
    expect(row.evidence?.sources).toHaveLength(20);
    expect(row.evidence?.sources.slice(10)).toEqual(ranked.slice(10).map((source) => ({
      id: source.id,
      occurrence: source.occurrence,
      date: source.date,
      full_chars: source.text.length,
      used_chars: 0,
      truncated: true,
      ranges: [],
    })));
    expect(row.supplemental_diagnostics).toEqual({
      included_ranks: [],
      omitted: Array.from({ length: 10 }, (_, index) => ({
        source_rank: index + 11,
        reason: "budget",
      })),
    });
  });

  it("fails closed for incomplete rankings before invoking the supplied call", async () => {
    const options = supplementalOptions();
    writeFileSync(options.rankings!, JSON.stringify({
      status: "complete",
      results: [{
        question_id: case20.question_id,
        retrieved_session_ids: ids.slice(0, 19),
        retrieved_session_occurrences: occurrences.slice(0, 19),
      }],
    }));
    let calls = 0;
    await expect(runEvaluation(options, async () => {
      calls++;
      return call('{"answer":"unused"}');
    })).rejects.toThrow("exactly 20 ranked sources");
    expect(calls).toBe(0);
  });

  it("allows no-provider preparation but rejects invalid live configurations before calls", async () => {
    const preparation = supplementalOptions({
      provider: undefined,
      requestMode: undefined,
      evidencePolicy: undefined,
      reasoningEffort: undefined,
      maxOutputTokens: undefined,
    });
    const prepared = await runEvaluation(preparation);
    expect(prepared.status).toBe("complete");
    expect(prepared.results[0]!.answer_call).toBeNull();
    expect(prepared.results[0]!.supplemental_diagnostics?.included_ranks).toContain(11);

    const invalid = [
      supplementalOptions({ topK: 10 }),
      supplementalOptions({ evidenceLedger: "quoted" }),
      supplementalOptions({ answerCheck: "grounded" }),
      supplementalOptions({ concurrency: 4 }),
      supplementalOptions({ provider: "gemini" }),
      supplementalOptions({ provider: undefined }),
      supplementalOptions({ requestMode: "standard" }),
      supplementalOptions({ evidencePolicy: "inline" }),
      supplementalOptions({ reasoningEffort: "high" }),
      supplementalOptions({ maxOutputTokens: 4_096 }),
    ];
    for (const options of invalid) {
      let calls = 0;
      await expect(runEvaluation(options, async () => {
        calls++;
        return call('{"answer":"unused"}');
      })).rejects.toThrow();
      expect(calls).toBe(0);
    }
  });

  it("does not add supplemental report fields or source hashes to prior modes", async () => {
    const paths = files();
    const options: Options = {
      ...paths,
      retrieval: "cached",
      concurrency: 1,
      contextChars: 20_000,
      topK: 10,
      evidence: "highlighted",
    };
    const report = await runEvaluation(options);
    const written = JSON.parse(readFileSync(options.out, "utf8")) as {
      hashes: { code: Record<string, string> };
      supplemental_evidence?: unknown;
    };
    expect(report.results[0]!.supplemental_diagnostics).toBeUndefined();
    expect("supplemental_evidence" in written).toBe(false);
    expect(Object.keys(written.hashes.code).some((path) =>
      path.endsWith("/benchmark/longmemeval-supplemental-evidence.ts"),
    )).toBe(false);
  });
});

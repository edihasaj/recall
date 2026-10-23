import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as azureAnswerAdapter from "../benchmark/longmemeval-azure-answer.js";
import { composeAzureAnswerCall, prepareAzureAnswer } from "../benchmark/longmemeval-azure-qa.js";
import { evaluateCase, parseArgs, runEvaluation, type Options } from "../benchmark/longmemeval-qa.js";
import { answerPrompt, cachedRank, sha256, type Call, type Case, type ModelCall } from "../benchmark/longmemeval-qa-support.js";

const endpoint = "https://recall-benchmark.openai.azure.com/";
const deployment = "azure-deployment";
const secret = "azure-test-secret-never-persist";
const question = "Which pottery activity does Nila prefer?";
const ids = Array.from({ length: 20 }, (_, index) =>
  index === 11 ? "answer_GOLD_SOURCE_ID" : `opaque-source-${index}`);
const occurrences = Array.from({ length: 20 }, (_, index) => index);
const item: Case = {
  question_id: "azure-case",
  question_type: "single-session-user",
  is_abstention: false,
  question,
  question_date: "2026/10/21",
  reference: "REFERENCE_SENTINEL",
  gold_session_ids: ["answer_GOLD_SOURCE_ID"],
  answer_prompt_prefix: `Question: ${question}\n__RECALL_CONTEXT__`,
  judge_prompt_template: "Reference: REFERENCE_SENTINEL\nCandidate: __RECALL_CANDIDATE__",
  sessions: ids.map((id, index) => ({
    id,
    date: `2026/10/${String(index + 1).padStart(2, "0")} (Tue) 09:30`,
    text: `user: Nila prefers pottery activity option ${index}.`,
  })),
};

const response = (
  text: string | null,
  error: string | null = null,
  model = "stub",
  request_config?: Call["request_config"],
): Call => ({
  text, error, attempts: 1, elapsed_ms: 1, model, usage: null, prompt_sha256: "stub",
  ...(request_config ? { request_config } : {}),
});

function files() {
  const dir = mkdtempSync(join(tmpdir(), "recall-lme-azure-qa-"));
  const input = join(dir, "input.json");
  const rankings = join(dir, "rankings.json");
  writeFileSync(input, JSON.stringify({ provenance: {}, cases: [item] }));
  writeFileSync(rankings, JSON.stringify({
    status: "complete",
    results: [{
      question_id: item.question_id,
      retrieved_session_ids: ids,
      retrieved_session_occurrences: occurrences,
    }],
  }));
  return { input, rankings, out: join(dir, "report.json") };
}

function azureOptions(overrides: Partial<Options> = {}): Options {
  return {
    ...files(),
    provider: "qwen-local",
    retrieval: "cached",
    concurrency: 1,
    contextChars: 20_000,
    topK: 20,
    evidence: "supplemental",
    answerProvider: "azure",
    requestMode: "robust",
    answerCheck: "none",
    reasoningEffort: "adaptive",
    maxOutputTokens: 16_384,
    evidencePolicy: "system",
    evidenceLedger: "none",
    ...overrides,
  };
}

function stubAzureEnvironment() {
  vi.stubEnv("LONGMEMEVAL_AZURE_ENDPOINT", endpoint);
  vi.stubEnv("LONGMEMEVAL_AZURE_DEPLOYMENT", deployment);
  vi.stubEnv("LONGMEMEVAL_AZURE_API_KEY", secret);
}

describe("LongMemEval Azure answer routing", () => {
  it("accepts the explicit Azure answer-provider CLI value", () => {
    expect(parseArgs(["--out", "result.json", "--answer-provider", "azure"]).answerProvider)
      .toBe("azure");
  });

  it("validates canonical credential-free Azure preparation metadata", () => {
    const options = azureOptions({ provider: undefined });
    const preparation = prepareAzureAnswer(options, false, {
      LONGMEMEVAL_AZURE_ENDPOINT: endpoint,
      LONGMEMEVAL_AZURE_DEPLOYMENT: deployment,
    });
    expect(preparation).toMatchObject({
      endpoint: "https://recall-benchmark.openai.azure.com/openai/v1/responses",
      deployment,
      metadata: {
        answer_reasoning_effort: "medium",
        answer_max_output_tokens: 16_384,
        actual_model_recorded_in: "answer_call.model",
      },
    });
    expect(JSON.stringify(preparation)).not.toContain(secret);
    expect(() => prepareAzureAnswer(options, false, {
      LONGMEMEVAL_AZURE_ENDPOINT: "https://user:secret@recall-benchmark.openai.azure.com/",
      LONGMEMEVAL_AZURE_DEPLOYMENT: deployment,
    })).toThrow("credentials");
  });

  it("routes the unchanged supplemental answer prompt only to Azure and keeps the Qwen judge", async () => {
    const evidenceOptions = {
      retrieval: "cached" as const,
      topK: 20,
      contextChars: 20_000,
      evidence: "supplemental" as const,
      answerCheck: "none" as const,
      evidencePolicy: "system" as const,
      evidenceLedger: "none" as const,
    };
    const control = await evaluateCase(item, evidenceOptions, ids, undefined, occurrences);
    const expectedAnswerPrompt = answerPrompt(item, control.evidence!.text);
    const azurePrompts: string[] = [];
    const qwenKinds: string[] = [];
    const qwenPrompts: string[] = [];
    const composed = composeAzureAnswerCall(
      async (prompt) => {
        azurePrompts.push(prompt);
        return response(
          '{"reasoning":"quoted evidence","answer":"pottery"}',
          null,
          "actual-azure-response-model",
          { reasoning_effort: "medium", max_output_tokens: 16_384 },
        );
      },
      async (kind, prompt) => {
        qwenKinds.push(kind);
        qwenPrompts.push(prompt);
        return response(
          '{"correct":true,"reason":"matches"}',
          null,
          "qwen3.8-flash-next",
          { reasoning_effort: "none", max_output_tokens: 4_096 },
        );
      },
    );
    const row = await evaluateCase(item, evidenceOptions, ids, composed, occurrences);

    expect(azurePrompts).toEqual([expectedAnswerPrompt]);
    expect(azurePrompts[0]).toContain("## Additional Memory 11");
    expect(azurePrompts[0]).not.toContain("answer_GOLD_SOURCE_ID");
    expect(azurePrompts[0]).not.toContain("REFERENCE_SENTINEL");
    expect(qwenKinds).toEqual(["judge"]);
    expect(qwenPrompts[0]).toContain("REFERENCE_SENTINEL");
    expect(row.answer_call).toMatchObject({
      model: "actual-azure-response-model",
      request_config: { reasoning_effort: "medium", max_output_tokens: 16_384 },
    });
    expect(row.judge_call).toMatchObject({
      model: "qwen3.8-flash-next",
      request_config: { reasoning_effort: "none", max_output_tokens: 4_096 },
    });
  });

  it("retains malformed Azure output for the shared answer parser and never judges it", async () => {
    const evidenceOptions = {
      retrieval: "cached" as const,
      topK: 20,
      contextChars: 20_000,
      evidence: "supplemental" as const,
      answerCheck: "none" as const,
      evidencePolicy: "system" as const,
      evidenceLedger: "none" as const,
    };
    let judgeCalls = 0;
    const row = await evaluateCase(
      item,
      evidenceOptions,
      ids,
      composeAzureAnswerCall(
        async () => response("not valid answer JSON", null, "actual-azure-response-model"),
        async () => {
          judgeCalls++;
          return response('{"correct":true}');
        },
      ),
      occurrences,
    );

    expect(row.answer_call).toMatchObject({
      text: "not valid answer JSON",
      error: null,
      model: "actual-azure-response-model",
    });
    expect(row.error).toBe("malformed_answer");
    expect(row.judge_call).toBeNull();
    expect(judgeCalls).toBe(0);
  });

  it("accepts the same parser-compatible Azure answer forms as the Qwen control", async () => {
    const evidenceOptions = {
      retrieval: "cached" as const,
      topK: 20,
      contextChars: 20_000,
      evidence: "supplemental" as const,
      answerCheck: "none" as const,
      evidencePolicy: "system" as const,
      evidenceLedger: "none" as const,
    };
    for (const text of [
      '```json\n{"answer":"pottery"}\n```',
      '{"answer":"pottery","extra":"accepted"}',
      '{"answer":"pottery"}',
    ]) {
      let judgeCalls = 0;
      const row = await evaluateCase(
        item,
        evidenceOptions,
        ids,
        composeAzureAnswerCall(
          async () => response(text, null, "actual-azure-response-model"),
          async () => {
            judgeCalls++;
            return response('{"correct":true}');
          },
        ),
        occurrences,
      );
      expect(row.answer).toBe("pottery");
      expect(row.correct).toBe(true);
      expect(judgeCalls).toBe(1);
    }
  });

  it("writes safe Azure preparation metadata and source hashes without creating calls", async () => {
    stubAzureEnvironment();
    try {
      const options = azureOptions({ provider: undefined });
      const report = await runEvaluation(options);
      const written = JSON.parse(readFileSync(options.out, "utf8")) as {
        hashes: { code: Record<string, string> };
        azure_answer_provider: Record<string, unknown>;
        limitations: string[];
      };
      const adapterPath = Object.keys(written.hashes.code)
        .find((path) => path.endsWith("/benchmark/longmemeval-azure-answer.ts"));
      const helperPath = Object.keys(written.hashes.code)
        .find((path) => path.endsWith("/benchmark/longmemeval-azure-qa.ts"));

      expect(report.results[0]!.answer_call).toBeNull();
      expect(adapterPath).toBeDefined();
      expect(helperPath).toBeDefined();
      expect(written.hashes.code[adapterPath!]).toBe(sha256(readFileSync(adapterPath!)));
      expect(written.azure_answer_provider).toMatchObject({
        endpoint: "https://recall-benchmark.openai.azure.com/openai/v1/responses",
        deployment,
        answer_reasoning_effort: "medium",
        answer_max_output_tokens: 16_384,
        answer_temperature: "unset/providerdefault",
      });
      expect(JSON.stringify(written)).not.toContain(secret);
      expect(written.limitations.some((line) =>
        line.includes("Azure answers use fixed medium reasoning")
        && line.includes("not Azure answer calls"),
      )).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps injected ModelCall as the complete override without constructing Azure", async () => {
    stubAzureEnvironment();
    const factory = vi.spyOn(azureAnswerAdapter, "createAzureAnswerCall")
      .mockImplementation(() => { throw new Error("Azure factory must not run for injected calls"); });
    try {
      const kinds: string[] = [];
      const report = await runEvaluation(azureOptions(), async (kind) => {
        kinds.push(kind);
        return kind === "answer"
          ? response('{"reasoning":"stub","answer":"pottery"}')
          : response('{"correct":true}');
      });
      expect(kinds).toEqual(["answer", "judge"]);
      expect(report.results[0]!.correct).toBe(true);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      factory.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("rejects unsafe Azure modes and missing live keys before an injected Qwen call", async () => {
    stubAzureEnvironment();
    try {
      vi.stubEnv("LONGMEMEVAL_AZURE_API_KEY", "");
      let calls = 0;
      await expect(runEvaluation(azureOptions(), async () => {
        calls++;
        return response('{"correct":true}');
      })).rejects.toThrow("LONGMEMEVAL_AZURE_API_KEY");
      expect(calls).toBe(0);

      vi.stubEnv("LONGMEMEVAL_AZURE_API_KEY", secret);
      for (const options of [
        azureOptions({ concurrency: 2 }),
        azureOptions({ provider: "gemini" }),
        azureOptions({ evidenceLedger: "quoted" }),
        azureOptions({ answerCheck: "grounded" }),
        azureOptions({ requestMode: "standard" }),
        azureOptions({ evidencePolicy: "inline" }),
        azureOptions({ reasoningEffort: "high" }),
        azureOptions({ maxOutputTokens: 4_096 }),
      ]) {
        calls = 0;
        await expect(runEvaluation(options, async () => {
          calls++;
          return response('{"correct":true}');
        })).rejects.toThrow();
        expect(calls).toBe(0);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("leaves report Azure fields and source hashes absent without the opt-in", async () => {
    const options: Options = {
      ...files(),
      retrieval: "cached",
      concurrency: 1,
      contextChars: 20_000,
      topK: 20,
      evidence: "supplemental",
      answerCheck: "none",
      evidenceLedger: "none",
    };
    const report = await runEvaluation(options);
    const written = JSON.parse(readFileSync(options.out, "utf8")) as {
      hashes: { code: Record<string, string> };
      azure_answer_provider?: unknown;
    };

    expect(report.results[0]!.answer_call).toBeNull();
    expect("azure_answer_provider" in written).toBe(false);
    expect(Object.keys(written.hashes.code).some((path) =>
      path.includes("longmemeval-azure-"),
    )).toBe(false);
  });
});

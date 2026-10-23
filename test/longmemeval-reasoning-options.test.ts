import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelCall } from "../benchmark/longmemeval-qa-support.js";
import { parseArgs } from "../benchmark/longmemeval-qa.js";

describe("explicit local-model reasoning configuration", () => {
  it("sends the declared reasoning and token budgets and retains incomplete usage", async () => {
    const keyFile = join(mkdtempSync(join(tmpdir(), "recall-lme-reasoning-")), "token");
    writeFileSync(keyFile, "test-token");
    vi.stubEnv("DGX_BASE_URL", "http://127.0.0.1:45678/v1");
    vi.stubEnv("DGX_KEY_FILE", keyFile);
    try {
      const result = await createModelCall("qwen-local", async (_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(body.reasoning).toEqual({ effort: "low" });
        expect(body.max_output_tokens).toBe(8192);
        expect(body.text.format.type).toBe("json_schema");
        expect(body.input[0].content).toContain("ANSWER_ONLY_POLICY_SENTINEL");
        expect(body.input[1].content).not.toContain("ANSWER_ONLY_POLICY_SENTINEL");
        return new Response(JSON.stringify({
          status: "incomplete", model: "qwen3.8-flash-next",
          usage: { input_tokens: 123, output_tokens: 8192, total_tokens: 8315 },
        }));
      }, { structuredOutput: true, reasoningEffort: "low", maxOutputTokens: 8192, answerInstructions: "ANSWER_ONLY_POLICY_SENTINEL" })("answer", "question");
      expect(result.error).toBe("response_not_completed");
      expect(result.text).toBeNull();
      expect(result.attempts).toBe(1);
      expect(result.usage?.total_tokens).toBe(8315);
      expect(result.request_config).toEqual({ reasoning_effort: "low", max_output_tokens: 8192 });
      await createModelCall("qwen-local", async (_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(body.reasoning).toEqual({ effort: "none" });
        expect(body.max_output_tokens).toBe(4096);
        expect(body.input[0].content).not.toContain("ANSWER_ONLY_POLICY_SENTINEL");
        return new Response(JSON.stringify({
          status: "completed", output_text: '{"correct":true,"reason":"mock"}',
        }));
      }, { structuredOutput: true, reasoningEffort: "low", maxOutputTokens: 8192, answerInstructions: "ANSWER_ONLY_POLICY_SENTINEL" })("judge", "question");
    } finally { vi.unstubAllEnvs(); }
  });

  it("parses an explicit configuration without changing the baseline defaults", () => {
    expect(parseArgs(["--out", "fresh.json"])).not.toHaveProperty("reasoningEffort");
    expect(parseArgs([
      "--out", "fresh.json", "--reasoning-effort", "low", "--max-output-tokens", "8192",
    ])).toMatchObject({ reasoningEffort: "low", maxOutputTokens: 8192 });
    expect(() => parseArgs(["--out", "fresh.json", "--reasoning-effort", "invalid"])).toThrow("reasoning effort");
  });

  it("routes adaptive answers from only their standalone original question", async () => {
    const keyFile = join(mkdtempSync(join(tmpdir(), "recall-lme-adaptive-")), "token");
    writeFileSync(keyFile, "test-token");
    vi.stubEnv("DGX_BASE_URL", "http://127.0.0.1:45678/v1");
    vi.stubEnv("DGX_KEY_FILE", keyFile);
    try {
      const efforts: string[] = [];
      const call = createModelCall("qwen-local", async (_url, init) => {
        const body = JSON.parse(String(init.body));
        efforts.push(body.reasoning.effort);
        return new Response(JSON.stringify({ status: "completed", output_text: '{"answer":"ok","reasoning":"ok"}' }));
      }, { reasoningEffort: "adaptive", maxOutputTokens: 16384 });
      await call("answer", "prompt", { question: "How many items remain?" });
      await call("answer", "prompt", { question: "Recommend a calm book." });
      await call("judge", "prompt");
      expect(efforts).toEqual(["high", "low", "none"]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("rejects adaptive calls without a question before HTTP and keeps failure config", async () => {
    const keyFile = join(mkdtempSync(join(tmpdir(), "recall-lme-adaptive-missing-")), "token");
    writeFileSync(keyFile, "test-token");
    vi.stubEnv("DGX_BASE_URL", "http://127.0.0.1:45678/v1");
    vi.stubEnv("DGX_KEY_FILE", keyFile);
    try {
      let calls = 0;
      const call = createModelCall("qwen-local", async () => {
        calls++;
        return new Response("");
      }, { reasoningEffort: "adaptive", maxOutputTokens: 16384 });
      const result = await call("answer", "prompt");
      expect(calls).toBe(0);
      expect(result).toMatchObject({
        error: "adaptive_question_missing", attempts: 0,
        request_config: { reasoning_effort: null, max_output_tokens: 16384, requested_reasoning_effort: "adaptive" },
      });
      const malformed = await call("answer", "prompt", { question: "  " });
      expect(malformed.error).toBe("adaptive_question_missing");
      const nonString = await call("answer", "prompt", { question: 42 as unknown as string });
      expect(nonString.error).toBe("adaptive_question_missing");
      expect(calls).toBe(0);
    } finally { vi.unstubAllEnvs(); }
  });

  it("requires qwen and an explicit answer budget for adaptive mode", () => {
    for (const budget of [undefined, 0, -1, NaN, 1.5, Infinity]) {
      expect(() => createModelCall("qwen-local", fetch, {
        reasoningEffort: "adaptive", maxOutputTokens: budget,
      })).toThrow("positive integer");
    }
    expect(() => createModelCall("gemini", fetch, { reasoningEffort: "adaptive", maxOutputTokens: 16384 })).toThrow("qwen-local");
  });

  it("does not route from source text embedded in the full prompt", async () => {
    const keyFile = join(mkdtempSync(join(tmpdir(), "recall-lme-source-routing-")), "token");
    writeFileSync(keyFile, "test-token");
    vi.stubEnv("DGX_BASE_URL", "http://127.0.0.1:45678/v1");
    vi.stubEnv("DGX_KEY_FILE", keyFile);
    try {
      const call = createModelCall("qwen-local", async (_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(body.input[1].content).toContain("how many records appear in this source?");
        expect(body.reasoning).toEqual({ effort: "low" });
        return new Response(JSON.stringify({ status: "completed", output_text: '{"answer":"ok","reasoning":"ok"}' }));
      }, { reasoningEffort: "adaptive", maxOutputTokens: 16384 });
      await call("answer", "Source says: how many records appear in this source?", {
        question: "Recommend a quiet book.",
      });
    } finally { vi.unstubAllEnvs(); }
  });

  it("keeps the fixed default answer payload unchanged", async () => {
    const keyFile = join(mkdtempSync(join(tmpdir(), "recall-lme-default-")), "token");
    writeFileSync(keyFile, "test-token");
    vi.stubEnv("DGX_BASE_URL", "http://127.0.0.1:45678/v1");
    vi.stubEnv("DGX_KEY_FILE", keyFile);
    try {
      const call = createModelCall("qwen-local", async (_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(body.reasoning).toEqual({ effort: "none" });
        expect(body.max_output_tokens).toBe(4096);
        return new Response(JSON.stringify({ status: "completed", output_text: '{"answer":"ok","reasoning":"ok"}' }));
      });
      await call("answer", "question");
    } finally { vi.unstubAllEnvs(); }
  });
});

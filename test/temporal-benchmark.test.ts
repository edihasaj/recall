import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAnswerPrompt, runTemporalBenchmark, scoreOutcome } from "../benchmark/temporal.js";
import { TEMPORAL_QUESTIONS } from "../benchmark/temporal-fixtures.js";

describe("temporal benchmark evaluation", () => {
  const unknown = TEMPORAL_QUESTIONS.find((question) => question.expected_values.length === 0)!;
  const conflict = TEMPORAL_QUESTIONS.find((question) => question.expected_conflict)!;

  it("scores unknown, conflict, and proof ids as exact sets", () => {
    expect(scoreOutcome({ values: [], conflict: false, evidence_event_ids: [] }, unknown)).toEqual({ answer_exact_match: true, grounded_exact_match: true, malformed: false });
    expect(scoreOutcome({ values: ["unsupported"], conflict: false, evidence_event_ids: [] }, unknown).answer_exact_match).toBe(false);
    expect(scoreOutcome({ values: ["not supported"], conflict: false, evidence_event_ids: [] }, unknown).answer_exact_match).toBe(false);
    expect(scoreOutcome({ values: [" unsupported "], conflict: false, evidence_event_ids: [] }, { ...unknown, expected_values: ["unsupported"] }).answer_exact_match).toBe(false);
    expect(scoreOutcome({ values: ["unsupported"], conflict: false, evidence_event_ids: [] }, { ...unknown, expected_values: ["unsupported"] })).toEqual({ answer_exact_match: true, grounded_exact_match: true, malformed: false });
    expect(scoreOutcome({ values: conflict.expected_values, conflict: true, evidence_event_ids: [conflict.expected_event_ids[0]] }, conflict)).toEqual({ answer_exact_match: true, grounded_exact_match: false, malformed: false });
    expect(scoreOutcome({ values: ["invented"], conflict: false, evidence_event_ids: [] }, unknown).answer_exact_match).toBe(false);
  });

  it("counts malformed provider output as a failed outcome", () => {
    expect(scoreOutcome("not json", unknown)).toEqual({ answer_exact_match: false, grounded_exact_match: false, malformed: true });
    expect(scoreOutcome({ values: [], conflict: "false", evidence_event_ids: [] }, unknown).malformed).toBe(true);
  });

  it("does not leak gold fields into the answer prompt", () => {
    const question = TEMPORAL_QUESTIONS[0];
    const prompt = buildAnswerPrompt(question, '{"event_id":"hosting-azure"}');
    expect(prompt).not.toContain("expected_values");
    expect(prompt).not.toContain("expected_event_ids");
    expect(prompt).not.toContain(JSON.stringify(question.expected_values));
    expect(prompt).toContain(question.as_of);
    expect(prompt).toContain(question.observed_before);
  });

  it("skips QA without a provider and does not initialize the configured store", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "recall-temporal-production-sentinel-"));
    const prior = process.env.RECALL_DATA_DIR;
    process.env.RECALL_DATA_DIR = dataDir;
    try {
      const report = await runTemporalBenchmark({ limit: 1 });
      const compiler = (report.summary.arms as Record<string, Record<string, unknown>>).compiler;
      expect(report.invocation.provider).toBeNull();
      expect(compiler.answer_exact_match).toBeNull();
      expect(compiler.qa_skipped).toBe(true);
      expect(existsSync(join(dataDir, "recall.db"))).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.RECALL_DATA_DIR;
      else process.env.RECALL_DATA_DIR = prior;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("matches every temporal snapshot against the hand-authored fixture gold before QA", async () => {
    const report = await runTemporalBenchmark();
    for (const question of TEMPORAL_QUESTIONS) {
      const temporal = report.questions.find((row) => row.id === question.id)!.arms.find((arm) => arm.arm === "temporal")!;
      expect(temporal.temporal_values).toEqual(question.expected_values);
      expect(temporal.temporal_conflict).toBe(question.expected_conflict);
    }
  });

  it("gives every model arm only its representation evidence and shared temporal rules", async () => {
    const calls: Array<{ system: string; user: string }> = [];
    await runTemporalBenchmark({
      provider: "qwen-local",
      limit: 1,
      answerer: async ({ system, user }) => {
        calls.push({ system, user });
        return { text: '{"values":[],"conflict":false,"evidence_event_ids":[]}', provider: "mock", model: "mock", duration_ms: 1, usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cost_usd: null } };
      },
    });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.system).toContain("validity is [valid_from, valid_to)");
      expect(call.system).toContain("confidence never chooses a winner");
      expect(call.user).toContain("hosting-azure");
      expect(call.user).not.toContain("expected_values");
      expect(call.user).not.toContain("expected_event_ids");
      expect(call.user).not.toContain(JSON.stringify(TEMPORAL_QUESTIONS[0].expected_values));
    }
  });

  it("rejects invalid public runner limits", async () => {
    await expect(runTemporalBenchmark({ limit: 0 })).rejects.toThrow("limit must be an integer");
    await expect(runTemporalBenchmark({ limit: Number.NaN })).rejects.toThrow("limit must be an integer");
    await expect(runTemporalBenchmark({ limit: TEMPORAL_QUESTIONS.length + 1 })).rejects.toThrow("limit must be an integer");
  });

  it("keeps failed requests in the score denominator and records unknown usage", async () => {
    let calls = 0;
    const report = await runTemporalBenchmark({
      provider: "qwen-local", limit: 2,
      answerer: async () => {
        const call = calls++;
        if (call === 3) throw new Error("HTTP 503");
        const question = TEMPORAL_QUESTIONS[Math.floor(call / 3)];
        return {
          text: JSON.stringify({ values: question.expected_values, conflict: question.expected_conflict, evidence_event_ids: question.expected_event_ids }),
          provider: "qwen-local", model: "qwen3.8-flash-next", duration_ms: 1,
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost_usd: null },
        };
      },
    });
    const summary = (report.summary.arms as Record<string, Record<string, unknown>>).compiler;
    expect(summary.answer_exact_match).toBe(0.5);
    expect(summary.grounded_exact_match).toBe(0.5);
    expect(summary.failed_attempts).toBe(1);
    expect((summary.usage as Record<string, unknown>).total_tokens).toEqual({ value: 15, unknown_count: 1 });
    expect(report.questions[1].arms[0].model_attempt_ms).toBeGreaterThanOrEqual(0);
  });

  it("preserves missing hosted-adapter token measurements as unknown", async () => {
    for (const provider of ["openai", "azure-openai", "anthropic"] as const) {
      const report = await runTemporalBenchmark({
        provider, limit: 1,
        answerer: async () => ({
          text: '{"values":[],"conflict":false,"evidence_event_ids":[]}',
          provider, model: "mock", duration_ms: 1,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 },
        }),
      });
      const summary = (report.summary.arms as Record<string, Record<string, unknown>>).compiler;
      expect((summary.usage as Record<string, unknown>).total_tokens).toEqual({ value: null, unknown_count: 1 });
      expect((summary.usage as Record<string, unknown>).cost_usd).toEqual({ value: null, unknown_count: 1 });
    }
  });
});

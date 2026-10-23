import { describe, expect, it } from "vitest";
import { bootstrap, createModelSemaphore, runExpandedTemporalBenchmark, type ExpandedDataset } from "../benchmark/temporal-expanded.js";
import { runTemporalBenchmark, type BenchmarkAnswerer } from "../benchmark/temporal.js";

const dataset: ExpandedDataset = {
  version: "expanded-test-v1",
  events: [{ event_id: "event-1", repo: "test/repo", subject: "service", predicate: "owner", value: "Ada", valid_from: "2026-01-01", observed_at: "2026-01-01", evidence: "Ada owns the service." }],
  questions: [{ id: "unknown", category: "unknown", template_id: "template-a", world_id: "world-a", stratum: "clean", repo: "test/repo", subject: "service", predicate: "owner", as_of: "2025-12-01", observed_before: "2026-01-02", question: "Who owned it?", expected_values: [], expected_event_ids: [], expected_conflict: false }],
};
const correct: BenchmarkAnswerer = async () => ({ text: '{"values":[],"conflict":false,"evidence_event_ids":[]}', provider: "mock", model: "mock", duration_ms: 1, usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, cost_usd: null } });

describe("expanded temporal benchmark", () => {
  it("uses an explicit dataset for seeding, temporal queries, and source history", async () => {
    const question = { ...dataset.questions[0]!, id: "known", as_of: "2026-01-02", expected_values: ["Ada"], expected_event_ids: ["event-1"] };
    const report = await runTemporalBenchmark({ dataset: { ...dataset, version: "generic-dataset-test", questions: [question] } });
    expect(report.fixture_version).toBe("generic-dataset-test");
    expect(report.questions).toHaveLength(1);
    expect(report.questions[0]!.arms.find((arm) => arm.arm === "temporal")?.temporal_values).toEqual(["Ada"]);
    expect(report.questions[0]!.arms.find((arm) => arm.arm === "history")?.retrieved_event_ids).toEqual(["event-1"]);
    expect((await runTemporalBenchmark()).questions).toHaveLength(25);
  });

  it("skips QA and model callbacks without a provider", async () => {
    let calls = 0;
    const report = await runExpandedTemporalBenchmark({ dataset, repeats: 3, answerer: async (input) => { calls += 1; return correct(input); } });
    expect(calls).toBe(0);
    expect(report.status).toBe("complete");
    expect(report.progress).toEqual({ complete_trials: 3, planned_trials: 3 });
    expect(report.summary.paired).toBeNull();
    expect(report.summary.arms).toMatchObject({ temporal: null, "scoped-history": null });
    const generated = await runExpandedTemporalBenchmark({ repeats: 1, limit: 1 });
    expect(generated.dataset).toMatchObject({ distinct_questions: 1, distinct_worlds: 1, templates: 1 });
  });

  it("keeps malformed and request failures in every arm denominator", async () => {
    const report = await runExpandedTemporalBenchmark({ dataset, repeats: 1, provider: "qwen-local", answerer: async () => { throw new Error("HTTP 503"); } });
    const arms = report.summary.arms as Record<string, { trials: number; failures: number; grounded_exact_match: number }>;
    for (const arm of Object.values(arms)) {
      expect(arm.trials).toBe(1);
      expect(arm.failures).toBe(1);
      expect(arm.grounded_exact_match).toBe(0);
    }
  });

  it("uses a shared six-call semaphore even with two four-arm runs", async () => {
    let active = 0;
    let maxActive = 0;
    const answerer: BenchmarkAnswerer = async (input) => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return correct(input);
    };
    const report = await runExpandedTemporalBenchmark({ dataset, repeats: 3, provider: "qwen-local", answerer });
    expect(report.invocation.repeats_completed).toBe(3);
    expect(maxActive).toBeLessThanOrEqual(6);
  });

  it("shares model admission across overlapping expanded invocations", async () => {
    let active = 0;
    let maxActive = 0;
    const answerer: BenchmarkAnswerer = async (input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return correct(input);
    };
    await Promise.all([
      runExpandedTemporalBenchmark({ dataset, repeats: 2, provider: "qwen-local", answerer }),
      runExpandedTemporalBenchmark({ dataset, repeats: 2, provider: "qwen-local", answerer }),
    ]);
    expect(maxActive).toBeLessThanOrEqual(6);
  });

  it("restores the embedding setting after reordered overlapping base runs", async () => {
    const original = process.env.RECALL_EMBEDDINGS_DISABLED;
    try {
      for (const initial of [undefined, "true"] as const) {
        if (initial === undefined) delete process.env.RECALL_EMBEDDINGS_DISABLED;
        else process.env.RECALL_EMBEDDINGS_DISABLED = initial;
        let calls = 0;
        const completedPerRepeat = [0, 0, 0];
        const repeatCompletionOrder: number[] = [];
        const report = await runExpandedTemporalBenchmark({ dataset, repeats: 3, limit: 1, provider: "qwen-local", answerer: async (input) => {
          const group = Math.floor(calls++ / 4);
          await new Promise((resolve) => setTimeout(resolve, [60, 5, 100][group]!));
          completedPerRepeat[group] += 1;
          if (completedPerRepeat[group] === 4) repeatCompletionOrder.push(group + 1);
          expect(process.env.RECALL_EMBEDDINGS_DISABLED).toBe("true");
          return correct(input);
        } });
        expect(report.status).toBe("complete");
        expect(repeatCompletionOrder).toEqual([2, 1, 3]);
        expect(process.env.RECALL_EMBEDDINGS_DISABLED).toBe(initial);
      }
    } finally {
      if (original === undefined) delete process.env.RECALL_EMBEDDINGS_DISABLED;
      else process.env.RECALL_EMBEDDINGS_DISABLED = original;
    }
  });

  it("transfers permits to queued work before late arrivals and releases after errors", async () => {
    const gate = createModelSemaphore(1);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = gate(async () => { order.push("first"); await new Promise<void>((resolve) => { releaseFirst = resolve; }); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = gate(async () => { order.push("queued"); });
    releaseFirst();
    const late = gate(async () => { order.push("late"); });
    await Promise.all([first, queued, late]);
    expect(order).toEqual(["first", "queued", "late"]);

    await expect(gate(async () => { throw new Error("expected"); })).rejects.toThrow("expected");
    await expect(gate(async () => "released")).resolves.toBe("released");
  });

  it("reports trial and fully-correct question counts explicitly", async () => {
    const report = await runExpandedTemporalBenchmark({ dataset, repeats: 2, provider: "qwen-local", answerer: correct });
    const temporal = (report.summary.arms as Record<string, { trials: number; correct_trials: number; fully_correct_questions: number }>).temporal!;
    expect(temporal).toMatchObject({ trials: 2, correct_trials: 2, fully_correct_questions: 1 });
    expect(temporal).not.toHaveProperty("correct");
  });

  it("has deterministic clustered bootstrap intervals rather than repeat observations", () => {
    expect(bootstrap([0, 1, 1, 0], 42, 2_000)).toEqual(bootstrap([0, 1, 1, 0], 42, 2_000));
    expect(bootstrap([1, 1], 42, 2_000)).toEqual([1, 1]);
    expect(bootstrap([], 42)).toBeNull();
  });
});

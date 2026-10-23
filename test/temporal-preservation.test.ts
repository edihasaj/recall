import { describe, expect, it } from "vitest";
import { setLlmJudgeForTests } from "../src/embeddings/llm-judge.js";
import { setRerankScorerForTests } from "../src/embeddings/reranker.js";
import { runTemporalPreservation, withCompilerModelsDisabled } from "../benchmark/temporal-preservation.js";

const MODEL_ENV = ["RECALL_EMBEDDINGS_DISABLED", "RECALL_RELEVANCE_LLM", "RECALL_RERANK", "RECALL_HYDE"] as const;

function restoreEnvironment(original: Record<(typeof MODEL_ENV)[number], string | undefined>): void {
  for (const name of MODEL_ENV) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
}

describe("temporal assertion preservation", () => {
  it("keeps ordinary compiler selection unchanged across every category world", async () => {
    const report = await runTemporalPreservation();
    expect(report.counts).toMatchObject({ worlds: 125, ordinary_rows: 500, temporal_rows: 500, comparisons: 1500, differences: 0 });
    expect(report.coverage.types).toEqual({ rule: 25, command: 25, gotcha: 25, decision: 25, review_pattern: 25 });
    expect(report.coverage.sources).toEqual({ user_correction: 25, user_reported_review: 25, repo_scan: 25, config_parse: 25, tool_outcome: 25 });
    expect(report.coverage.scopes).toEqual({ session: 25, path: 25, repo: 25, team: 25, global: 25 });
    expect(report.coverage.statuses).toEqual({ active: 125, candidate: 125, transient: 125, rejected: 125 });
    expect(report.baseline_inclusion_controls).toHaveLength(375);
    expect(report.baseline_inclusion_controls.every((control) => control.active_included)).toBe(true);
    expect(report.passed).toMatchObject({ coexistence: true, baseline_inclusion: true, rejected_and_transient_excluded: true, false_temporal_evidence_not_emitted: true, temporal_repo_isolation: true, replay: true, conflicting_replay: true, backup_round_trip: true, history: true });
    expect(report.failures).toEqual([]);
  }, 120_000);

  it("disables inherited model opt-ins, blocks their sentinels, and restores them after failure", async () => {
    const original = Object.fromEntries(MODEL_ENV.map((name) => [name, process.env[name]])) as Record<(typeof MODEL_ENV)[number], string | undefined>;
    const inherited = {
      RECALL_EMBEDDINGS_DISABLED: "false",
      RECALL_RELEVANCE_LLM: "true",
      RECALL_RERANK: "true",
      RECALL_HYDE: "true",
    } as const;
    let relevanceCalls = 0;
    let rerankCalls = 0;
    Object.assign(process.env, inherited);
    setLlmJudgeForTests(async () => {
      relevanceCalls += 1;
      return new Map();
    });
    setRerankScorerForTests(async (_query, documents) => {
      rerankCalls += 1;
      return documents.map(() => 1);
    });
    try {
      const report = await runTemporalPreservation();
      expect(report.status).toBe("complete");
      expect(relevanceCalls).toBe(0);
      expect(rerankCalls).toBe(0);
      expect(Object.fromEntries(MODEL_ENV.map((name) => [name, process.env[name]]))).toEqual(inherited);

      await expect(withCompilerModelsDisabled(async () => {
        expect(process.env.RECALL_RELEVANCE_LLM).toBe("false");
        expect(process.env.RECALL_RERANK).toBe("false");
        throw new Error("restore compiler model settings");
      })).rejects.toThrow("restore compiler model settings");
      expect(Object.fromEntries(MODEL_ENV.map((name) => [name, process.env[name]]))).toEqual(inherited);
    } finally {
      setLlmJudgeForTests(null);
      setRerankScorerForTests(null);
      restoreEnvironment(original);
    }
  }, 120_000);
});

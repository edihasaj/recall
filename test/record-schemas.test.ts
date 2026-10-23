import { describe, expect, it } from "vitest";
import { MaintenanceEvalMetrics, PolicyRule } from "../src/types.js";

describe("record schemas", () => {
  it("preserves named maintenance counts and rejects nonnumeric counts", () => {
    const metrics = {
      total_completed: 3,
      total_abandoned: 0,
      abandon_rate: 0,
      mean_completion_ms: null,
      completed_by_kind: { summarize_history: 2, refine_candidate: 1 },
      merge_precision: null,
      merge_rollbacks: 0,
    };
    expect(MaintenanceEvalMetrics.parse(metrics)).toEqual(metrics);
    expect(MaintenanceEvalMetrics.safeParse({
      ...metrics, completed_by_kind: { summarize_history: "2" },
    }).success).toBe(false);
  });

  it("preserves heterogeneous policy configuration and rejects an array", () => {
    const rule = {
      id: "d9702057-0ed3-49ab-acf0-23a6b144bf4c",
      org_id: "test-org",
      rule_type: "allowed_sources",
      config: { sources: ["user_correction"], threshold: 0.8, nested: { enabled: true }, empty: null },
      enabled: true,
      created_at: "2026-10-24T00:00:00Z",
      updated_at: "2026-10-24T00:00:00Z",
    };
    expect(PolicyRule.parse(rule)).toEqual(rule);
    expect(PolicyRule.safeParse({ ...rule, config: [] }).success).toBe(false);
  });
});

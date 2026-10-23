import { describe, expect, it, vi } from "vitest";
import { buildCategoryPrompt, opaqueSourceId, runCategoryEvaluation, type CategoryAnswerer } from "../benchmark/temporal-categories.js";
import { CATEGORY_WORLDS, type CategorySource } from "../benchmark/temporal-category-fixtures.js";
vi.setConfig({ testTimeout: 30_000 });

function response(text: string) {
  return { text, provider: "qwen-local" as const, model: "fixture-router", duration_ms: 1, usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost_usd: null } };
}
function sourceForPrompt(user: string): CategorySource {
  const opaqueId = /Current raw source:\nsource_id: ([^\n]+)/.exec(user)?.[1];
  const source = CATEGORY_WORLDS.flatMap((world) => world.sources).find((item) => opaqueSourceId(item.id) === opaqueId);
  if (!source) throw new Error(`missing fixture source ${opaqueId}`);
  return source;
}
function goldAnswerer(): CategoryAnswerer {
  return async ({ user }) => {
    const source = sourceForPrompt(user);
    const fact = source.expected_fact && { ...source.expected_fact, supersedes_event_id: source.expected_fact.supersedes_event_id ? opaqueSourceId(source.expected_fact.supersedes_event_id) : null };
    return response(JSON.stringify({ route: source.expected_route, ...(source.expected_type ? { memory_type: source.expected_type } : {}), ...(fact ? { fact } : {}) }));
  };
}

describe("temporal category evaluation", () => {
  it("keeps evaluator gold and descriptive fixture identities out of every router prompt", () => {
    for (const world of CATEGORY_WORLDS) for (const [index, current] of world.sources.entries()) {
      const prior = world.sources.slice(0, index);
      const prompt = buildCategoryPrompt(world.repo, current, prior);
      const rawSources = prompt.slice(prompt.indexOf("\nRepository:"));
      expect(prompt).toContain("Current raw source:");
      expect(prompt).not.toContain("expected_");
      expect(prompt).not.toContain(world.repo);
      for (const source of world.sources) {
        expect(prompt).not.toContain(source.id);
        expect(rawSources).not.toContain(source.family);
      }
      for (const question of world.questions) {
        expect(prompt).not.toContain(question.text);
      }
    }
    const replacement = CATEGORY_WORLDS.find((world) => world.id === "replacement")!;
    const prompt = buildCategoryPrompt(replacement.repo, replacement.sources[1]!, replacement.sources.slice(0, 1));
    expect(prompt).toContain(opaqueSourceId("replace-1"));
    expect(prompt).not.toContain("replace-1");
    const gotcha = CATEGORY_WORLDS.find((world) => world.id === "ordinary-controls")!.sources.find((source) => source.expected_type === "gotcha")!;
    const gotchaPrompt = buildCategoryPrompt("synthetic/categories-ordinary-controls", gotcha, []);
    expect(gotchaPrompt).toContain(gotcha.text);
    expect(gotchaPrompt).not.toContain(gotcha.family);
  });

  it("runs ideal temporal queries without a provider or any answerer call", async () => {
    const calls: string[] = [];
    const report = await runCategoryEvaluation({ answerer: async ({ user }) => { calls.push(user); return response("{}"); } });
    expect(calls).toEqual([]);
    expect(report.status).toBe("complete");
    expect(report.counts.sources).toBeGreaterThanOrEqual(70);
    expect(report.counts.questions).toBeGreaterThanOrEqual(45);
    expect(report.worlds.flatMap((world) => world.questions).every((question) => question.ideal_exact)).toBe(true);
    expect(report.worlds.flatMap((world) => world.sources).every((source) => source.ingestion === "skipped")).toBe(true);
    expect(report.summary.route_exact).toBeNull();
    expect(report.summary.extracted_query_exact).toBeNull();
  });

  it("records deterministic gold extraction while keeping ignored and deferred sources out of the temporal store", async () => {
    const report = await runCategoryEvaluation({ provider: "qwen-local", answerer: goldAnswerer() });
    const boundary = report.worlds.find((world) => world.id === "boundaries")!;
    expect(boundary.sources.every((source) => source.ingestion === "not_applicable")).toBe(true);
    expect(boundary.questions.every((question) => question.extracted_exact)).toBe(true);
    expect(report.summary.route_exact).toBe(1);
    expect(report.summary.ordinary_type_exact).toBe(1);
    expect(report.summary.temporal_fact_exact).toBe(1);
  });

  it("uses source-observation cutoffs and exclusive validity boundaries in extracted stores", async () => {
    const report = await runCategoryEvaluation({ provider: "qwen-local", answerer: goldAnswerer() });
    const cutoff = report.worlds.find((world) => world.id === "cutoff")!;
    const edge = report.worlds.find((world) => world.id === "exclusive-boundary")!;
    expect(cutoff.questions.find((question) => question.id === "cutoff-q1")!).toMatchObject({ extracted_exact: true, values: ["v1"], event_ids: ["cutoff-1"] });
    expect(cutoff.questions.find((question) => question.id === "cutoff-q2")!).toMatchObject({ extracted_exact: true, values: ["v2"], event_ids: ["cutoff-2"] });
    expect(edge.questions.find((question) => question.id === "edge-q2")!).toMatchObject({ extracted_exact: true, values: [], event_ids: [] });
  });

  it("retains request and schema failures in source denominators", async () => {
    let attempts = 0;
    const report = await runCategoryEvaluation({ provider: "qwen-local", answerer: async (input) => {
      attempts += 1;
      if (attempts === 1) throw new Error("fixture request failure");
      if (attempts === 2) return response("not json");
      return goldAnswerer()(input);
    } });
    const sources = report.worlds.flatMap((world) => world.sources);
    expect(report.summary.source_attempts).toBe(report.counts.sources);
    expect(sources).toHaveLength(report.counts.sources);
    expect(sources.filter((source) => source.error).map((source) => source.error)).toEqual(expect.arrayContaining(["fixture request failure", "malformed model JSON"]));
    expect(report.failure_count).toBeGreaterThanOrEqual(2);
    expect(report.known_tokens.total_tokens.unknown_attempts).toBe(1);
  });

  it("covers every ordinary memory enum with at least six hand-authored controls", () => {
    const controls = CATEGORY_WORLDS.find((world) => world.id === "ordinary-controls")!.sources;
    for (const type of ["rule", "command", "gotcha", "decision", "review_pattern"] as const) {
      expect(controls.filter((source) => source.expected_type === type).length).toBeGreaterThanOrEqual(6);
    }
    expect(controls).toHaveLength(42);
  });

  it("normalizes equivalent valid dates and counts calendar/schema failures", async () => {
    const report = await runCategoryEvaluation({ provider: "qwen-local", answerer: async (input) => {
      const source = sourceForPrompt(input.user);
      if (source.id === "ambiguous-1") return response('{"unexpected":true}');
      if (source.expected_fact) {
        const fact = { ...source.expected_fact };
        fact.valid_from = fact.valid_from.replace("T00:00:00.000Z", "").replace(".000Z", "Z");
        if (source.id === "leap-1") fact.valid_from = "2024-02-30";
        return response(JSON.stringify({ route: "temporal", fact }));
      }
      return goldAnswerer()(input);
    } });
    const sources = report.worlds.flatMap((world) => world.sources);
    expect(sources.find((source) => source.id === "ambiguous-1")?.error).toBe("malformed model schema");
    expect(sources.find((source) => source.id === "leap-1")?.ingestion).toBe("failed");
    expect(sources.filter((source) => source.expected_route === "temporal" && source.id !== "leap-1").every((source) => source.fact_exact)).toBe(true);
    expect(report.summary.failed_source_attempts).toBe(2);
  });

  it("exposes unsafe temporal storage and keeps partial planned counts fixed", async () => {
    const partials: Array<{ planned: number; recorded: number }> = [];
    const report = await runCategoryEvaluation({ provider: "qwen-local", answerer: async (input) => {
      if (sourceForPrompt(input.user).id === "ambiguous-1") return response(JSON.stringify({
        route: "temporal",
        fact: { subject: "storefront", predicate: "mode", value: "dark", valid_from: "2026-04-05", valid_to: null, supersedes_event_id: null },
      }));
      return goldAnswerer()(input);
    }, onProgress: (progress) => {
      const families = Object.values(progress.summary.by_family as Record<string, { planned: number; recorded: number }>);
      partials.push({ planned: families.reduce((sum, item) => sum + item.planned, 0), recorded: families.reduce((sum, item) => sum + item.recorded, 0) });
    } });
    expect(report.summary.ignored_or_deferred_stored).toBe(1);
    expect(partials.every((item) => item.planned === report.counts.sources)).toBe(true);
    expect(partials.some((item) => item.recorded < item.planned)).toBe(true);
  });

  it("separates unsupported empty results from supported evidence and reports every temporal field", async () => {
    const report = await runCategoryEvaluation({ provider: "qwen-local", answerer: async () => response("{}") });
    const scores = report.summary.extracted_query_scores as Record<string, { denominator: number; accuracy: number }>;
    const fields = report.summary.temporal_field_exact as Record<string, { denominator: number; accuracy: number }>;
    expect(scores.aggregate).toEqual({ denominator: 45, accuracy: 24 / 45 });
    expect(scores.supported_evidence).toEqual({ denominator: 21, accuracy: 0 });
    expect(scores.empty_result).toEqual({ denominator: 24, accuracy: 1 });
    expect(Object.values(fields)).toEqual(Array.from({ length: 6 }, () => ({ denominator: 18, accuracy: 0 })));
    expect(report.worlds.flatMap((world) => world.questions).filter((question) => question.expected_nonempty)).toHaveLength(21);
  });
});

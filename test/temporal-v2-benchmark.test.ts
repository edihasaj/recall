import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { stableTemporalKey } from "../src/temporal/intake-contract.js";
import { opaqueSourceId } from "../benchmark/temporal-categories.js";
import { runTemporalV2Evaluation, validateV2Fixtures, type V2Answerer } from "../benchmark/temporal-v2.js";
import { V2_REFERENCE_NOW, V2_WORLDS, type V2Question, type V2Source } from "../benchmark/temporal-v2-fixtures.js";

vi.setConfig({ testTimeout: 30_000 });
const answer = (text: string) => ({ text, provider: "qwen-local" as const, model: "fixture-router", duration_ms: 1, usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost_usd: null } });
const sources = V2_WORLDS.flatMap((world) => world.sources.map((source) => ({ world, source })));
const questions = V2_WORLDS.flatMap((world) => world.questions.map((question) => ({ world, question })));
const modelRepo = (repo: string) => `repository_${createHash("sha256").update(repo).digest("hex").slice(0, 16)}`;
function sourceFor(user: string): { world: typeof V2_WORLDS[number]; source: V2Source } {
  const event = [...user.matchAll(/(?:event_id|source_id):\s*(source_[a-f0-9]+)/g)].at(-1)?.[1];
  const found = event ? sources.find((item) => opaqueSourceId(item.source.id) === event) : sources.find((item) => user.includes(item.source.text));
  if (!found) throw new Error("fixture_source_missing");
  return found;
}
function questionFor(user: string): { world: typeof V2_WORLDS[number]; question: V2Question } {
  const found = questions.find((item) => user.includes(item.question.text));
  if (!found) throw new Error("fixture_question_missing");
  return found;
}
function gold(): V2Answerer {
  return async ({ arm, kind, user }) => {
    if (kind === "query") {
      const { world, question } = questionFor(user);
      return answer(JSON.stringify({ route: "temporal", key_id: stableTemporalKey(modelRepo(world.repo), question.subject, question.predicate), as_of: question.as_of, observed_before: question.observed_before }));
    }
    const { world, source } = sourceFor(user);
    if (source.expected_route !== "temporal") return answer(JSON.stringify({ route: source.expected_route, ...(source.expected_type ? { memory_type: source.expected_type } : {}) }));
    const fact = source.expected_facts[0]!;
    if (arm === "v1") return answer(JSON.stringify({ route: "temporal", fact: { ...fact, supersedes_event_id: fact.supersedes_source_id ? opaqueSourceId(fact.supersedes_source_id) : null } }));
    return answer(JSON.stringify({ route: "temporal", facts: source.expected_facts.map((entry) => {
      const key = stableTemporalKey(modelRepo(world.repo), entry.subject, entry.predicate);
      return {
        ...(user.includes(`"key_id":"${key}"`) ? { key_id: key } : {}),
        subject: entry.subject, predicate: entry.predicate, value: entry.value,
        valid_from: entry.valid_from, valid_to: entry.valid_to,
        time_basis: entry.valid_from === null ? "observed" : "explicit",
        quote: source.text.replaceAll(entry.supersedes_source_id ?? "", entry.supersedes_source_id ? opaqueSourceId(entry.supersedes_source_id) : ""),
        supersedes_event_id: entry.supersedes_source_id ? `${opaqueSourceId(entry.supersedes_source_id)}#0` : null,
        ...(entry.supersedes_source_id ? { replacement_quote: `replacing ${opaqueSourceId(entry.supersedes_source_id)}` } : {}),
      };
    }) }));
  };
}

describe("temporal v2 benchmark", () => {
  it("freezes independently clocked, source-grounded fixture coverage", () => {
    validateV2Fixtures();
    expect(V2_WORLDS).toHaveLength(20);
    expect(V2_WORLDS.flatMap((world) => world.sources)).toHaveLength(60);
    expect(V2_WORLDS.flatMap((world) => world.questions)).toHaveLength(56);
    const current = V2_WORLDS.flatMap((world) => world.questions).filter((question) => question.as_of === V2_REFERENCE_NOW && question.observed_before === V2_REFERENCE_NOW && question.expected_values.length > 0);
    expect(current).toHaveLength(6);
    for (const question of V2_WORLDS.flatMap((world) => world.questions)) {
      expect(question.now).toBe(V2_REFERENCE_NOW);
      expect(question.text).toContain(question.as_of);
      expect(question.text).toContain(question.observed_before);
    }
  });

  it("rejects a fixture whose question conceals its effective or knowledge cutoff", () => {
    const altered = structuredClone(V2_WORLDS) as typeof V2_WORLDS;
    altered[0]!.questions[0]!.text = "Which storage backed Cedar Ledger?";
    expect(() => validateV2Fixtures(altered)).toThrow("v2_fixture_question_clock_missing");
  });

  it("runs a no-model smoke without callbacks and counts only the selected split", async () => {
    const calls: unknown[] = [];
    const report = await runTemporalV2Evaluation({ split: "development", answerer: async (input) => { calls.push(input); return answer("{}"); } });
    expect(calls).toEqual([]);
    expect(report.status).toBe("complete");
    expect(report.counts).toMatchObject({ worlds: 6, sources: 18, questions: 20, planned_holdout_worlds: 0 });
    expect(report.summary.ideal_query_exact).toBe(1);
    expect(report.known_tokens.total_tokens).toEqual({ value: null, unknown_attempts: 0 });
  });

  it("keeps gold, raw repository names, and raw source ids out of v2 model prompts", async () => {
    const seen: string[] = [];
    await runTemporalV2Evaluation({ provider: "qwen-local", split: "development", answerer: async (input) => {
      seen.push(input.user);
      expect(input.user).not.toContain("expected_");
      expect(input.user).not.toContain("workbench/");
      expect(input.user).not.toContain("cedar-a");
      return gold()(input);
    } });
    expect(seen.length).toBeGreaterThan(0);
  });

  it("scores both own-store structured lookups before the v2 natural parser", async () => {
    const report = await runTemporalV2Evaluation({ provider: "qwen-local", answerer: gold() });
    const cedar = report.worlds.find((world) => world.id === "cedar")!;
    const ember = report.worlds.find((world) => world.id === "ember")!;
    expect(cedar.questions.every((question) => question.v1_structured_exact && question.v2_structured_exact && question.v2_natural_exact), JSON.stringify(cedar, null, 2)).toBe(true);
    expect(ember.questions.map((question) => question.v2_structured_exact)).toEqual([true, true, true, true]);
    const misses = report.worlds.flatMap((world) => world.questions.filter((question) => question.v2_structured_exact === false || (question.expected_nonempty && !question.v2_natural_exact)).map((question) => ({ world: world.id, question, sources: world.sources })));
    expect(report.summary.structured_lookup, JSON.stringify(misses, null, 2)).toMatchObject({ v1_structured: expect.any(Number), v2_structured: 1, v2_natural_supported: 1 });
  });

  it("retains callback attempts and request failures without invented token usage", async () => {
    const report = await runTemporalV2Evaluation({ provider: "qwen-local", split: "development", answerer: async () => { throw new Error("Bearer secret fixture request failure"); } });
    const stages = report.worlds.flatMap((world) => world.sources).flatMap((source) => [source.v1, source.v2]);
    expect(stages.every((stage) => stage.attempted && stage.error === "model_request_failed")).toBe(true);
    expect(report.worlds.flatMap((world) => world.questions).every((question) => question.attempted && question.v2_error === "model_request_failed")).toBe(true);
    expect(report.known_tokens.total_tokens).toEqual({ value: null, unknown_attempts: 56 });
  });
});

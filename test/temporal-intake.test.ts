import { describe, expect, it, vi } from "vitest";
import { buildExtractionPrompt, buildQueryPrompt, runIntakeProbe, type IntakeAnswerer } from "../benchmark/temporal-intake.js";
import { INTAKE_WORLDS } from "../benchmark/temporal-intake-fixtures.js";

const queryFailure = vi.hoisted(() => ({ enabled: false, matchingCalls: 0 }));

vi.mock("../src/temporal/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/temporal/store.js")>();
  return {
    ...actual,
    queryTemporalFacts: (...args: Parameters<typeof actual.queryTemporalFacts>) => {
      const [, input] = args;
      if (queryFailure.enabled && input.repo === "probe/scheduled" && input.as_of === "2026-02-15") {
        queryFailure.matchingCalls += 1;
        if (queryFailure.matchingCalls === 3) throw new Error("mock temporal query failure");
      }
      return actual.queryTemporalFacts(...args);
    },
  };
});

function answer(text: string) {
  return { text, provider: "qwen-local" as const, model: "mock", duration_ms: 1, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_usd: null } };
}

function goldAnswerer(changes: { wrongExtraction?: boolean; failedParser?: boolean } = {}): IntakeAnswerer {
  return async ({ kind, user }) => {
    if (kind === "extract") {
      const eventId = /Current source:\nevent_id: ([^\n]+)/.exec(user)![1]!;
      const source = INTAKE_WORLDS.flatMap((world) => world.sources).find((item) => item.event_id === eventId)!;
      if (changes.wrongExtraction && source.event_id === "s1") return answer(JSON.stringify({ status: "fact", subject: "production", predicate: "host", value: "Wrong", valid_from: "2026-01-01", valid_to: null, supersedes_event_id: null }));
      if (source.expected_status !== "fact") return answer(JSON.stringify({ status: source.expected_status }));
      return answer(JSON.stringify({ status: "fact", ...source.expected_fact }));
    }
    const question = INTAKE_WORLDS.flatMap((world) => world.questions).find((item) => user.endsWith(`Question: ${item.text}`))!;
    if (changes.failedParser && question.id === "s-q1") return answer("not json");
    return answer(JSON.stringify({ subject: question.subject, predicate: question.predicate, as_of: question.as_of, observed_before: question.observed_before }));
  };
}

describe("temporal source-language intake probe", () => {
  it("keeps evaluator gold and structured questions out of every model prompt", () => {
    const source = INTAKE_WORLDS[0]!.sources[0]!;
    const question = INTAKE_WORLDS[0]!.questions[0]!;
    const extraction = buildExtractionPrompt(source, []);
    const query = buildQueryPrompt(question, INTAKE_WORLDS[0]!.repo);
    for (const prompt of [extraction, query]) {
      expect(prompt).not.toContain("expected_");
      expect(prompt).not.toContain(JSON.stringify(source.expected_fact));
    }
    expect(query).not.toContain(JSON.stringify({ subject: question.subject, predicate: question.predicate, as_of: question.as_of, observed_before: question.observed_before }));
    expect(query).not.toContain(question.expected_values[0]!);
  });

  it("keeps wrong extraction and failed parsing in denominators without oracle leakage", async () => {
    const report = await runIntakeProbe({ provider: "qwen-local", answerer: goldAnswerer({ wrongExtraction: true, failedParser: true }) });
    expect(report.counts).toEqual({ worlds: 8, sources: 16, questions: 19 });
    const first = report.worlds.find((world) => world.id === "scheduled")!;
    expect(first.sources[0]!.extraction_exact).toBe(false);
    expect(first.sources[0]!.ingestion).toBe("stored");
    expect(first.questions[0]!.parse_exact).toBe(false);
    expect(first.questions[0]!.extracted_parsed.exact).toBe(false);
    expect(first.questions[0]!.ideal_oracle.exact).toBe(true);
    expect(report.summary.extraction_exact).toBeLessThan(1);
    expect(report.summary.parse_exact).toBeLessThan(1);
  });

  it("does not record ignored or unsupported sources as facts", async () => {
    const report = await runIntakeProbe({ provider: "qwen-local", answerer: goldAnswerer() });
    const rows = report.worlds.flatMap((world) => world.sources).filter((row) => ["e2", "e3", "u1", "n2"].includes(row.event_id));
    expect(rows.map((row) => row.ingestion)).toEqual(["not_applicable", "not_applicable", "not_applicable", "not_applicable"]);
  });

  it("makes no model calls without a provider and still verifies ideal structured controls", async () => {
    const calls: string[] = [];
    const report = await runIntakeProbe({ answerer: async ({ kind }) => { calls.push(kind); return answer("{}"); } });
    expect(calls).toEqual([]);
    expect(report.invocation.provider).toBeNull();
    expect(report.summary.extraction_exact).toBeNull();
    expect(report.known_tokens).toEqual({ prompt_tokens: { value: null, unknown_attempts: 0 }, completion_tokens: { value: null, unknown_attempts: 0 }, total_tokens: { value: null, unknown_attempts: 0 }, cost_usd: { value: null, unknown_attempts: 0 } });
    expect(report.worlds.flatMap((world) => world.sources).every((row) => row.ingestion === "skipped")).toBe(true);
    expect(report.worlds.flatMap((world) => world.questions).every((row) => row.ideal_oracle.exact)).toBe(true);
  });

  it("keeps known token sums and unknown request counts when a request throws", async () => {
    let calls = 0;
    const report = await runIntakeProbe({ provider: "qwen-local", answerer: async (input) => {
      calls += 1;
      if (calls === 1) throw new Error("mock request failure");
      return goldAnswerer()(input);
    } });
    expect(report.worlds.flatMap((world) => world.sources).some((source) => source.error === "mock request failure")).toBe(true);
    expect(report.known_tokens.total_tokens).toEqual({ value: (report.counts.sources + report.counts.questions - 1) * 2, unknown_attempts: 1 });
    expect(report.known_tokens.cost_usd).toEqual({ value: null, unknown_attempts: report.counts.sources + report.counts.questions });
  });

  it("records a failed parsed query and completes every world", async () => {
    queryFailure.enabled = true;
    queryFailure.matchingCalls = 0;
    try {
      const report = await runIntakeProbe({ provider: "qwen-local", answerer: goldAnswerer() });
      const scheduled = report.worlds.find((world) => world.id === "scheduled")!;
      const failed = scheduled.questions.find((question) => question.id === "s-q1")!;
      expect(report.status).toBe("complete");
      expect(report.worlds).toHaveLength(report.counts.worlds);
      expect(report.worlds.flatMap((world) => world.sources)).toHaveLength(report.counts.sources);
      expect(report.worlds.flatMap((world) => world.questions)).toHaveLength(report.counts.questions);
      expect(failed.ideal_oracle.exact).toBe(true);
      expect(failed.extracted_oracle.exact).toBe(true);
      expect(failed.extracted_parsed).toEqual({ values: null, conflict: null, event_ids: null, exact: false });
      expect(failed.error).toContain("extracted_parsed query failed: mock temporal query failure");
      expect(report.summary.extracted_parsed_exact).toBeLessThan(1);
    } finally {
      queryFailure.enabled = false;
      queryFailure.matchingCalls = 0;
    }
  });

  it("labels partial progress with planned, recorded, and model-attempt counts", async () => {
    const progress: Array<{ status: string; summary: Record<string, number | null>; sources: number; questions: number }> = [];
    await runIntakeProbe({
      provider: "qwen-local",
      answerer: goldAnswerer(),
      onProgress: (report) => progress.push({
        status: report.status,
        summary: { ...report.summary },
        sources: report.worlds.flatMap((world) => world.sources).length,
        questions: report.worlds.flatMap((world) => world.questions).length,
      }),
    });
    const partial = progress.find((snapshot) => snapshot.sources < 16 && snapshot.questions < 19)!;
    expect(partial.status).toBe("partial");
    expect(partial.summary.planned_source_attempts).toBe(16);
    expect(partial.summary.recorded_source_attempts).toBe(partial.sources);
    expect(partial.summary.source_attempts).toBe(partial.sources);
    expect(partial.summary.planned_parse_attempts).toBe(19);
    expect(partial.summary.recorded_parse_attempts).toBe(partial.questions);
    expect(partial.summary.parse_attempts).toBe(partial.questions);

    const noProvider = await runIntakeProbe();
    expect(noProvider.summary.source_attempts).toBe(0);
    expect(noProvider.summary.parse_attempts).toBe(0);
  });

  it("states the fixed-schema limitation in the report", async () => {
    const report = await runIntakeProbe();
    expect(report.limitations.join(" ")).toMatch(/fixed-schema/);
  });
});

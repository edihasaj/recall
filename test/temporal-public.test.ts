import { describe, expect, it, vi } from "vitest";
import {
  baselineEvidence,
  buildExtractionPrompt,
  buildParsePrompt,
  createModelSemaphore,
  isCompleteAbstention,
  retrieveAbstention,
  runPublicTemporalEvaluation,
  selectPublicQuestions,
  type PublicAnswerer,
  type PublicEntry,
} from "../benchmark/temporal-public.js";

const types = ["single-session-user", "single-session-assistant", "single-session-preference", "multi-session", "knowledge-update", "temporal-reasoning"];
vi.setConfig({ testTimeout: 30_000 });

function entry(question_id: string, question_type: string, sessions = 2): PublicEntry {
  return {
    question_id,
    question_type,
    question: `What is the city for ${question_id}?`,
    question_date: "2023/02/01 (Wed) 12:00",
    answer: "gold answer",
    answer_session_ids: ["answer-hidden"],
    haystack_session_ids: Array.from({ length: sessions }, (_, index) => `s${index + 1}`),
    haystack_dates: Array.from({ length: sessions }, () => "2023/01/01 (Sun) 12:00"),
    haystack_sessions: Array.from({ length: sessions }, (_, index) => [{ role: "user", content: `I live in city ${index + 1} for ${question_id}.`, has_answer: true }]),
  };
}

const dataset = [...types.map((type) => entry(`q-${type}`, type)), ...Array.from({ length: 6 }, (_, index) => entry(`abs-${index}_abs`, "single-session-user", 1))];
const rankings = types.map((question_type) => ({ question_type, question_id: `q-${question_type}`, retrieved_session_ids: ["s1", "s2"] }));

function response(text: string) {
  return {
    text,
    provider: "qwen-local" as const,
    model: "fake",
    duration_ms: 1,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_usd: null },
  };
}

function answerer(overrides: Partial<Record<"extract" | "parse" | "answer" | "judge", (user: string) => ReturnType<typeof response> | Promise<ReturnType<typeof response>>>> = {}): PublicAnswerer {
  return async ({ kind, user }) => overrides[kind]?.(user) ?? (
    kind === "extract" ? response(JSON.stringify({ facts: [], deferred: true }))
      : kind === "parse" ? response(JSON.stringify({ route: "fallback" }))
        : kind === "answer" ? response(JSON.stringify({ answer: "unknown", source_session_ids: ["s1"] }))
          : response(JSON.stringify({ correct: true }))
  );
}

describe("public temporal side-car evaluation", () => {
  it("selects a reproducible cache-only all-six-type sample and FTS abstentions without answerability input", () => {
    const first = selectPublicQuestions(dataset, rankings, 1, 6);
    const second = selectPublicQuestions(dataset, rankings, 1, 6);
    expect(first.map((row) => row.entry.question_id)).toEqual(second.map((row) => row.entry.question_id));
    expect(first.filter((row) => !row.is_abstention).map((row) => row.entry.question_type).sort()).toEqual([...types].sort());
    expect(first.filter((row) => !row.is_abstention).every((row) => !row.entry.question_id.endsWith("_abs"))).toBe(true);
    const plain = retrieveAbstention({ question: "city", haystack_session_ids: ["s1", "s2"], haystack_sessions: [[{ role: "user", content: "city alpha" }], [{ role: "user", content: "city beta" }]] });
    const poisoned = retrieveAbstention({ question: "city", haystack_session_ids: ["s1", "s2"], haystack_sessions: [[{ role: "user", content: "city alpha", has_answer: true }], [{ role: "user", content: "city beta", has_answer: false }]] });
    expect(poisoned).toEqual(plain);
  });

  it("keeps evaluator gold, answer flags, and source assertions out of extraction/parser/answer prompts", async () => {
    const seen: Array<{ kind: string; user: string }> = [];
    const fake: PublicAnswerer = async ({ kind, user }) => {
      seen.push({ kind, user });
      return kind === "extract" ? response(JSON.stringify({ facts: [], deferred: true }))
        : kind === "parse" ? response(JSON.stringify({ route: "fallback" }))
          : kind === "answer" ? response(JSON.stringify({ answer: "unknown", source_session_ids: ["s1"] }))
            : response(JSON.stringify({ correct: true }));
    };
    await runPublicTemporalEvaluation({ provider: "qwen-local", answerer: fake, dataset, rankings, perType: 1, abstention: 0 });
    for (const row of seen.filter((row) => row.kind !== "judge")) {
      expect(row.user).not.toContain("gold answer");
      expect(row.user).not.toContain("answer-hidden");
      expect(row.user).not.toContain("has_answer");
      expect(row.user).not.toContain("answer_session_ids");
    }
    expect(buildExtractionPrompt({ session_id: "s", source_date: "2023-01-01T00:00:00.000Z", text: "original" })).not.toContain("question:");
    expect(buildParsePrompt("question", "2023-01-01T00:00:00.000Z")).not.toContain("facts");
  });

  it("uses exact raw fallback evidence for deferred, zero-match, and conflicting temporal paths", async () => {
    const fake = answerer({
      extract: (user) => {
        const city = /city (\d+)/.exec(user)?.[1] ?? "x";
        if (user.includes("q-single-session-user")) return response(JSON.stringify({ facts: [], deferred: false }));
        if (user.includes("q-multi-session")) return response(JSON.stringify({ facts: [{ subject: "person", predicate: "city", value: city, valid_from: "2023-01-01", valid_to: null }], deferred: false }));
        return response(JSON.stringify({ facts: [], deferred: true }));
      },
      parse: () => response(JSON.stringify({ route: "temporal", subject: "person", predicate: "city", as_of: "2023-02-01", observed_before: "2023-02-01" })),
    });
    const report = await runPublicTemporalEvaluation({ provider: "qwen-local", answerer: fake, dataset, rankings, perType: 1, abstention: 0 });
    for (const type of ["single-session-user", "multi-session", "single-session-assistant"]) {
      const question = report.questions.find((row) => row.question_type === type)!;
      expect(question.arms[1]!.evidence).toBe(question.arms[0]!.evidence);
    }
    expect(report.questions.find((row) => row.question_type === "single-session-user")!.sidecar_reason).toBe("no_temporal_match");
    expect(report.questions.find((row) => row.question_type === "multi-session")!.sidecar_reason).toBe("temporal_conflict");
    expect(report.questions.find((row) => row.question_type === "single-session-assistant")!.sidecar_reason).toBe("extraction_unusable");
  });

  it("makes no calls or fabricated scores in the no-model smoke path", async () => {
    let calls = 0;
    const report = await runPublicTemporalEvaluation({ dataset, rankings, perType: 1, abstention: 6, answerer: async () => { calls++; return response("{}"); } });
    expect(calls).toBe(0);
    expect(report.status).toBe("complete");
    expect(report.questions).toHaveLength(12);
    expect(report.summary.baseline_correct).toBeNull();
    expect(report.questions.every((question) => question.arms.every((arm) => arm.answer === null && arm.score === null))).toBe(true);
  });

  it("records a valid answer and an actual failed judge in the arm denominator", async () => {
    const report = await runPublicTemporalEvaluation({
      provider: "qwen-local",
      answerer: answerer({ answer: () => response(JSON.stringify({ answer: "candidate", source_session_ids: ["s1"] })), judge: () => Promise.reject(new Error("HTTP 503")) }),
      dataset,
      rankings,
      perType: 1,
      abstention: 0,
    });
    expect(report.summary.baseline_denominator).toBe(6);
    expect(report.summary.sidecar_denominator).toBe(6);
    expect(report.summary.failures.request.judge).toBe(12);
    expect(report.summary.arms.BASELINE_RAW.failures).toBe(6);
    expect(report.questions.flatMap((question) => question.arms).every((arm) => arm.answer !== null && arm.score?.judge?.error === "HTTP 503")).toBe(true);
  });

  it("treats invalid model dates as malformed without throwing and counts both stages", async () => {
    const report = await runPublicTemporalEvaluation({
      provider: "qwen-local",
      answerer: answerer({
        extract: () => response(JSON.stringify({ facts: [{ subject: "person", predicate: "city", value: "x", valid_from: "2023-02-30", valid_to: null }], deferred: false })),
        parse: () => response(JSON.stringify({ route: "temporal", subject: "person", predicate: "city", as_of: "2023-02-30", observed_before: "2023-02-30" })),
      }),
      dataset,
      rankings,
      perType: 1,
      abstention: 0,
    });
    expect(report.status).toBe("complete");
    expect(report.summary.failures.malformed.extract).toBe(12);
    expect(report.summary.failures.malformed.parse).toBe(6);
    expect(report.questions.every((question) => question.arms.length === 2)).toBe(true);
  });

  it("keeps lookup failures as audit rows and continues every later question", async () => {
    const report = await runPublicTemporalEvaluation({
      provider: "qwen-local",
      answerer: answerer({
        extract: () => response(JSON.stringify({ facts: [{ subject: "person", predicate: "city", value: "x", valid_from: "2023-01-01", valid_to: null }], deferred: false })),
        parse: () => response(JSON.stringify({ route: "temporal", subject: "person", predicate: "city", as_of: "2023-02-01", observed_before: "2023-02-01" })),
      }),
      lookup: () => { throw new Error("lookup exploded"); },
      dataset,
      rankings,
      perType: 1,
      abstention: 0,
    });
    expect(report.questions).toHaveLength(6);
    expect(report.summary.failures.lookup).toBe(6);
    expect(report.questions.every((question) => question.sidecar_reason === "lookup_failed" && question.lookup?.error === "request_failed")).toBe(true);
  });

  it("preflights invalid dataset source dates before any model calls", async () => {
    const invalid = dataset.map((item) => ({ ...item, haystack_dates: [...item.haystack_dates] }));
    invalid[0]!.haystack_dates[0] = "2023/02/30 (Thu) 12:00";
    let calls = 0;
    await expect(runPublicTemporalEvaluation({ provider: "qwen-local", answerer: async () => { calls++; return response("{}"); }, dataset: invalid, rankings, perType: 1, abstention: 0 })).rejects.toThrow("invalid dataset source date");
    expect(calls).toBe(0);
  });

  it("balances source labels and passes only those bounded snippets to extraction", async () => {
    const long = entry("q-single-session-user", "single-session-user", 10);
    long.haystack_sessions = long.haystack_sessions.map((session, index) => [{ ...session[0]!, content: `marker-${index + 1}:${"x".repeat(4_000)}` }]);
    const smallDataset = [long, ...types.slice(1).map((type) => entry(`q-${type}`, type))];
    const seenExtract: string[] = [];
    const seenBaseline: string[] = [];
    const fake: PublicAnswerer = async ({ kind, user }) => {
      if (kind === "extract") seenExtract.push(user);
      if (kind === "answer" && user.includes("evidence:")) seenBaseline.push(user);
      return kind === "extract" ? response(JSON.stringify({ facts: [], deferred: true }))
        : kind === "parse" ? response(JSON.stringify({ route: "fallback" }))
          : kind === "answer" ? response(JSON.stringify({ answer: "unknown", source_session_ids: ["s1"] }))
            : response(JSON.stringify({ correct: true }));
    };
    const longRankings = rankings.map((row) => row.question_id === "q-single-session-user" ? { ...row, retrieved_session_ids: Array.from({ length: 10 }, (_, index) => `s${index + 1}`) } : row);
    await runPublicTemporalEvaluation({ provider: "qwen-local", answerer: fake, dataset: smallDataset, rankings: longRankings, perType: 1, abstention: 0 });
    const baseline = seenBaseline.find((prompt) => prompt.includes("marker-1:"))!;
    for (let index = 1; index <= 10; index++) expect(baseline).toContain(`[source_session_id: s${index};`);
    for (const prompt of seenExtract.filter((prompt) => prompt.includes("marker-"))) {
      const snippet = prompt.split("source_text:\n")[1]!;
      expect(baseline).toContain(snippet);
      expect(snippet.length).toBeLessThan(4_010);
    }
    const bundle = baselineEvidence(Array.from({ length: 10 }, (_, index) => ({ id: `s${index + 1}`, date: "2023-01-01T00:00:00.000Z", text: "x".repeat(4_000) })));
    expect(bundle.text.length).toBeLessThanOrEqual(12_000);
  });

  it("reserves permits for queued work so newcomers cannot exceed the bound", async () => {
    const limit = createModelSemaphore(1);
    let running = 0;
    let maximum = 0;
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const run = (release: (resolve: () => void) => void) => limit(async () => {
      running++;
      maximum = Math.max(maximum, running);
      await new Promise<void>(release);
      running--;
    });
    const first = run((resolve) => { releaseFirst = resolve; });
    await Promise.resolve();
    const second = run((resolve) => { releaseSecond = resolve; });
    releaseFirst!();
    for (let index = 0; index < 10 && !releaseSecond; index++) await Promise.resolve();
    expect(releaseSecond).toBeTypeOf("function");
    const third = run((resolve) => resolve());
    await Promise.resolve();
    releaseSecond!();
    await Promise.all([first, second, third]);
    expect(maximum).toBe(1);
  });

  it("rejects substantive guesses disguised as abstention", () => {
    expect(isCompleteAbstention(" unknown. ")).toBe(true);
    expect(isCompleteAbstention("I do not know.")).toBe(true);
    expect(isCompleteAbstention("I do not know why, but the answer is definitely Berlin.")).toBe(false);
    expect(isCompleteAbstention("Unknown, probably Berlin")).toBe(false);
  });

  it("preserves a same-day source observation before a noon question", async () => {
    const sameDay = dataset.map((item) => ({ ...item, haystack_dates: item.haystack_dates.map(() => "2023/02/01 (Wed) 09:00") }));
    const report = await runPublicTemporalEvaluation({
      provider: "qwen-local", dataset: sameDay, rankings, perType: 1, abstention: 0,
      answerer: answerer({
        extract: () => response(JSON.stringify({ facts: [{ subject: "person", predicate: "city", value: "Berlin", valid_from: "2023-02-01", valid_to: null }], deferred: false })),
        parse: () => response(JSON.stringify({ route: "temporal", subject: "person", predicate: "city", as_of: "2023-02-01T12:00:00Z", observed_before: "2023-02-01T14:00:00+02:00" })),
      }),
    });
    expect(report.questions.every((question) => question.sidecar_reason === "temporal" && question.lookup?.facts === 2)).toBe(true);
    expect(report.questions.every((question) => question.parse?.route?.observed_before === "2023-02-01T12:00:00.000Z")).toBe(true);
    expect(report.summary.failures.lookup).toBe(0);
  });

  it("excludes future sources from evidence and allowed citations", async () => {
    const future = dataset.map((item) => ({ ...item, haystack_dates: item.haystack_dates.map((date, index) => index === 0 ? "2023/03/01 (Wed) 09:00" : date) }));
    const report = await runPublicTemporalEvaluation({
      provider: "qwen-local", dataset: future, rankings, perType: 1, abstention: 0,
      answerer: answerer({ answer: () => response(JSON.stringify({ answer: "candidate", source_session_ids: ["s1"] })) }),
    });
    expect(report.questions.every((question) => question.excluded_future_source_session_ids.includes("s1"))).toBe(true);
    expect(report.questions.flatMap((question) => question.arms).every((arm) => arm.answer === null && !arm.evidence.includes("source_session_id: s1;"))).toBe(true);
    expect(report.summary.baseline_denominator).toBe(6);
    expect(report.summary.baseline_correct).toBe(0);
  });

  it("keeps all shared raw snippets intact when augmenting long evidence", async () => {
    const long = dataset.map((item) => ({
      ...item,
      haystack_sessions: item.haystack_sessions.map((session) => [{ ...session[0]!, content: `${session[0]!.content} ${"padding ".repeat(2_000)}` }]),
    }));
    const report = await runPublicTemporalEvaluation({
      provider: "qwen-local", dataset: long, rankings, perType: 1, abstention: 0,
      answerer: answerer({
        extract: () => response(JSON.stringify({ facts: [{ subject: "person", predicate: "city", value: "Berlin", valid_from: "2023-01-01", valid_to: null }], deferred: false })),
        parse: () => response(JSON.stringify({ route: "temporal", subject: "person", predicate: "city", as_of: "2023-02-01", observed_before: "2023-02-01T12:00:00Z" })),
      }),
    });
    for (const question of report.questions) {
      expect(question.sidecar_reason).toBe("temporal");
      const baseline = question.arms[0]!.evidence, candidate = question.arms[1]!.evidence;
      expect(baseline.length).toBeLessThanOrEqual(10_000);
      expect(candidate.length).toBeLessThanOrEqual(12_000);
      expect(candidate.endsWith(baseline)).toBe(true);
      for (const extracted of question.extraction.rows) {
        expect(baseline).toContain(extracted.source_text);
        expect(candidate).toContain(extracted.source_text);
      }
    }
  });
});

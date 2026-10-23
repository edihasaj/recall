import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memories } from "../src/db/schema.js";
import { runTemporalRealEvaluation, type Retrieval } from "../benchmark/temporal-real.js";
import { bootstrapDifference, prepareCases, temporalEvidence, type LocalModelAnswerer, type RealEntry } from "../benchmark/temporal-real-support.js";

function entry(id: string, dates = ["2023/01/01 (Sun) 12:00", "2023/01/02 (Mon) 12:00"]): RealEntry {
  return { question_id: id, question_type: "single-session-preference", question: "Which city suits my quiet preference?", question_date: "2023/02/01 (Wed) 12:00", answer: "SECRET GOLD recommendation", answer_session_ids: ["s1"], haystack_session_ids: ["s1", "s2"], haystack_dates: dates, haystack_sessions: [[{ role: "user", content: `city evidence ${"a".repeat(14_000)}` }], [{ role: "assistant", content: `more city evidence ${"b".repeat(14_000)}` }]] };
}
function temporalEntry(id = "temporal"): RealEntry {
  return { question_id: id, question_type: "temporal-reasoning", question: "Which hosting provider was Acme using?", question_date: "2023/02/01 (Wed) 12:00", answer: "SECRET GOLD Azure", answer_session_ids: ["s1"], haystack_session_ids: ["s1", "s2"], haystack_dates: ["2023/01/01 (Sun) 12:00", "2023/01/02 (Mon) 12:00"], haystack_sessions: [[{ role: "user", content: "Acme hosting provider is Azure on 2023-01-01." }], [{ role: "assistant", content: "Acme hosting provider is AWS on 2023-01-02." }]] };
}
function response(text: string) { return { text, provider: "qwen-local" as const, model: "fake", duration_ms: 1, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_usd: null } }; }
function exposureFiles(): string[] { const root = mkdtempSync(join(tmpdir(), "recall-real-test-")); const first = join(root, "a.json"), second = join(root, "b.json"); writeFileSync(first, JSON.stringify({ results: [{ question_id: "gone" }] })); writeFileSync(second, JSON.stringify({ questions: [{ question_id: "also-gone" }] })); return [first, second]; }
const rankedRows = async (db: Parameters<Retrieval>[0]) => db.select({ id: memories.id }).from(memories).all().map((row) => row.id);

describe("larger real temporal evaluation harness", () => {
  it("selects by exposure question IDs, excludes all duplicate source occurrences, and filters future source dates", () => {
    const repeated = entry("kept", ["2023/01/01 (Sun) 12:00", "2023/03/01 (Wed) 12:00"]); repeated.haystack_session_ids = ["repeat", "repeat"];
    const prepared = prepareCases([entry("gone"), entry("also-gone"), repeated], new Set(["gone", "also-gone"]));
    expect(prepared.excluded_question_ids).toEqual(["gone", "also-gone"]);
    expect(prepared.cases[0]!.excluded_duplicate_sources).toEqual([{ id: "repeat", dates: ["2023-01-01T12:00:00.000Z", "2023-03-01T12:00:00.000Z"] }]);
    expect(prepared.cases[0]!.source_rows).toEqual([]);
  });

  it("uses frozen runtime systems/catalogs, keeps gold out, reuses fallback answers, and accounts for full raw evidence", async () => {
    const seen: Array<{ kind: string; system: string; user: string }> = [];
    const answerer: LocalModelAnswerer = async ({ kind, system, user }) => { seen.push({ kind, system, user }); if (kind === "capture") return response(JSON.stringify({ route: "ordinary" })); if (kind === "query") return response(JSON.stringify({ route: "fallback" })); if (kind === "answer") return response(JSON.stringify({ answer: "candidate", source_session_ids: ["s1"] })); const ids = [...user.matchAll(/^(a\d+):/gm)].map((match) => match[1]); return response(JSON.stringify({ scores: ids.map((id) => ({ id, correct: true })) })); };
    const report = await runTemporalRealEvaluation({ provider: "qwen-local", answerer, dataset: [entry("kept")], exposurePaths: exposureFiles(), retrieval: rankedRows });
    const question = report.questions[0]!;
    expect(question.temporal_reason).toBe("model_fallback");
    expect(question.arms[1]!.reused_from).toBe("RAW_SHARED");
    expect(question.arms[2]!.evidence.length).toBeGreaterThan(question.arms[0]!.evidence.length);
    expect(seen.filter((item) => item.kind === "answer")).toHaveLength(2);
    expect(seen.find((item) => item.kind === "capture")!.system).toContain("untrusted source evidence");
    expect(seen.find((item) => item.kind === "query")!.system).toContain("available temporal key");
    for (const call of seen.filter((item) => item.kind !== "judge")) expect(call.user).not.toContain("SECRET GOLD");
    expect(question.arms.every((arm) => arm.citations_valid && arm.correct)).toBe(true);
    expect((report.summary.usage as { unique_calls: number }).unique_calls).toBe(seen.length);
  });

  it("maps opaque event ids back to sessions and injects an explicit unresolved conflict", async () => {
    const prompts: Array<{ kind: string; user: string }> = [];
    const answerer: LocalModelAnswerer = async ({ kind, user }) => {
      prompts.push({ kind, user });
      if (kind === "capture") { const azure = user.includes("Azure on 2023-01-01"); const quote = azure ? "Acme hosting provider is Azure on 2023-01-01." : "Acme hosting provider is AWS on 2023-01-02."; return response(JSON.stringify({ route: "temporal", facts: [{ subject: "Acme", predicate: "hosting_provider", value: azure ? "Azure" : "AWS", valid_from: azure ? "2023-01-01" : "2023-01-02", valid_to: null, time_basis: "explicit", quote, supersedes_event_id: null }] })); }
      if (kind === "query") { const key = user.match(/"key_id":"([^"]+)"/)?.[1]; expect(key).toBeTruthy(); return response(JSON.stringify({ route: "temporal", key_id: key })); }
      if (kind === "answer") return response(JSON.stringify({ answer: "unknown", source_session_ids: [] }));
      const ids = [...user.matchAll(/^(a\d+):/gm)].map((match) => match[1]); return response(JSON.stringify({ scores: ids.map((id) => ({ id, correct: false })) }));
    };
    const report = await runTemporalRealEvaluation({ provider: "qwen-local", answerer, dataset: [temporalEntry("temporal_abs")], exposurePaths: exposureFiles(), retrieval: rankedRows });
    const question = report.questions[0]!;
    expect(question.temporal_reason).toBe("temporal");
    expect(question.query!.conflict).toBe(true);
    expect(question.query!.facts.map((fact) => fact.source_session_id)).toEqual(["s1", "s2"]);
    expect(question.arms.find((arm) => arm.arm === "TEMPORAL_V2")!.evidence).toContain("conflict:true");
    expect(question.arms.find((arm) => arm.arm === "TEMPORAL_V2")!.evidence).not.toContain("source_session_id: e");
    const captures = prompts.filter((prompt) => prompt.kind === "capture");
    expect(captures[1]!.user).toContain("Existing evidence catalog");
    expect(captures.every((prompt) => !prompt.user.includes("Which hosting provider"))).toBe(true);
    expect(prompts.every((prompt) => !prompt.user.includes("temporal_abs"))).toBe(true);
  });

  it("treats invalid answers/judges as false and keeps model failures and their usage in the report", async () => {
    let captureCalls = 0;
    const report = await runTemporalRealEvaluation({ provider: "qwen-local", dataset: [entry("kept")], exposurePaths: exposureFiles(), retrieval: rankedRows, answerer: async ({ kind }) => { if (kind === "capture" && captureCalls++ === 0) throw new Error("network unavailable"); if (kind === "capture") return response(JSON.stringify({ route: "ordinary" })); if (kind === "query") return response(JSON.stringify({ route: "fallback" })); if (kind === "answer") return response(JSON.stringify({ answer: "", source_session_ids: [] })); return response("{}"); } });
    const question = report.questions[0]!;
    expect(question.capture[0]!.error).toBe("model_request_failed");
    expect(question.arms.every((arm) => !arm.citations_valid && !arm.correct)).toBe(true);
    expect((report.summary.errors_by_stage as Record<string, number>).capture).toBe(1);
    expect((report.summary.errors_by_stage as Record<string, number>).answer_schema).toBeGreaterThan(0);
  });

  it("caps six worlds and six total model calls, including the frozen runtime callbacks", async () => {
    let active = 0, maximum = 0;
    const answerer: LocalModelAnswerer = async ({ kind, user }) => { active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 3)); active--; if (kind === "capture") return response(JSON.stringify({ route: "ordinary" })); if (kind === "query") return response(JSON.stringify({ route: "fallback" })); if (kind === "answer") return response(JSON.stringify({ answer: "candidate", source_session_ids: ["s1"] })); const ids = [...user.matchAll(/^(a\d+):/gm)].map((match) => match[1]); return response(JSON.stringify({ scores: ids.map((id) => ({ id, correct: true })) })); };
    const report = await runTemporalRealEvaluation({ provider: "qwen-local", answerer, dataset: Array.from({ length: 7 }, (_, index) => entry(`concurrent-${index}`)), exposurePaths: exposureFiles(), retrieval: rankedRows });
    expect(report.status).toBe("complete");
    expect(report.questions.every((question) => question.error === null && question.arms.length === 3)).toBe(true);
    expect((report.summary.usage as { unique_calls: number }).unique_calls).toBeGreaterThan(0);
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(6);
  }, 30_000);

  it("keeps temporal evidence below the exact cap and computes deterministic clustered bootstrap", () => {
    expect(temporalEvidence("x".repeat(20_033), "y".repeat(3_900))!.length).toBe(24_000);
    expect(temporalEvidence("x".repeat(20_034), "y".repeat(3_900))).toBeNull();
    const pairs = [{ id: "a", cluster: "x", candidate: true, control: false }, { id: "a_abs", cluster: "x", candidate: false, control: false }, { id: "b", cluster: "y", candidate: true, control: true }];
    expect(bootstrapDifference(pairs)).toEqual(bootstrapDifference(pairs));
    expect(bootstrapDifference([]).difference_pp).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { cachedRank, type Case } from "../benchmark/longmemeval-qa-support.js";
import { evaluateCase, runEvaluation } from "../benchmark/longmemeval-qa.js";
import { questionSourcesHash } from "../benchmark/longmemeval-source-identity.js";

const sessions = [
  { id: "duplicate", date: "2026-01-01", text: "Earlier deployment used the hills." },
  { id: "duplicate", date: "2026-02-01", text: "Current deployment uses the harbor." },
  { id: "other", date: "2026-02-02", text: "The harbor deployment is ready." },
];
const item: Case = {
  question_id: "fixture", question_type: "knowledge-update", is_abstention: false,
  question: "Where is the deployment?", question_date: "2026-02-03",
  reference: "harbor", gold_session_ids: ["duplicate"],
  answer_prompt_prefix: "__RECALL_CONTEXT__", judge_prompt_template: "__RECALL_CANDIDATE__",
  sessions,
};

describe("exact cached source occurrences", () => {
  it("fingerprints the ordered question and exact source triples as UTF-16LE", () => {
    const expected = JSON.stringify([item.question, sessions.map((source) => [source.id, source.date, source.text])]);
    expect(questionSourcesHash(item.question, sessions)).toBe(createHash("sha256").update(expected, "utf16le").digest("hex"));
  });
  it("replays the actual ranked occurrence without expanding a duplicate ID", async () => {
    expect(cachedRank(sessions, ["duplicate", "other"], 2).map((row) => row.occurrence)).toEqual([0, 1]);
    expect(cachedRank(sessions, ["duplicate", "other"], 2, [1, 2]).map((row) => row.occurrence)).toEqual([1, 2]);
    const row = await evaluateCase(item, {
      retrieval: "cached", topK: 2, contextChars: 1000,
    }, ["duplicate", "other"], undefined, [1, 2]);
    expect(row.evidence?.text).toContain("Current deployment uses the harbor");
    expect(row.evidence?.text).not.toContain("Earlier deployment used the hills");
    expect(row.evidence?.sources.map((source) => source.occurrence)).toEqual([1, 2]);
    expect(row.cached_ambiguous_session_ids).toEqual([]);
    expect(row.exact_ranking_occurrences).toBe(true);
  });

  it("accepts distinct same-ID occurrences and rejects corrupt positional mappings", () => {
    expect(cachedRank(sessions, ["duplicate", "duplicate"], 2, [0, 1])).toHaveLength(2);
    expect(() => cachedRank(sessions, ["duplicate"], 2, [])).toThrow("count mismatch");
    expect(() => cachedRank(sessions, ["duplicate"], 2, [-1])).toThrow("out of bounds");
    expect(() => cachedRank(sessions, ["duplicate"], 2, [3])).toThrow("out of bounds");
    expect(() => cachedRank(sessions, ["duplicate"], 2, [0.5])).toThrow("out of bounds");
    expect(() => cachedRank(sessions, ["other"], 2, [0])).toThrow("source mismatch");
    expect(() => cachedRank(sessions, ["duplicate", "duplicate"], 2, [1, 1])).toThrow("Duplicate ranking occurrence");
  });

  it("refuses incomplete ranking checkpoints before they can become answer scores", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-lme-ranking-"));
    const input = join(dir, "input.json"), rankings = join(dir, "rankings.json");
    writeFileSync(input, JSON.stringify({ provenance: {}, cases: [item] }));
    writeFileSync(rankings, JSON.stringify({
      status: "partial", selected_question_ids: ["fixture"],
      results: [{ question_id: "fixture", retrieved_session_ids: ["duplicate"], retrieved_session_occurrences: [1] }],
    }));
    await expect(runEvaluation({
      input, rankings, out: join(dir, "out.json"), retrieval: "cached",
      concurrency: 1, contextChars: 1000, topK: 2,
    })).rejects.toThrow("incomplete");
    writeFileSync(rankings, JSON.stringify({ status: "complete" }));
    await expect(runEvaluation({
      input, rankings, out: join(dir, "missing.json"), retrieval: "cached",
      concurrency: 1, contextChars: 1000, topK: 2,
    })).rejects.toThrow("results missing");
    writeFileSync(rankings, JSON.stringify({
      status: "complete", selected_question_ids: ["fixture"],
      results: [{ question_id: "fixture", retrieved_session_ids: ["other"], retrieved_session_occurrences: [0] }],
    }));
    let calls = 0;
    await expect(runEvaluation({
      input, rankings, out: join(dir, "corrupt.json"), retrieval: "cached",
      concurrency: 1, contextChars: 1000, topK: 2,
    }, async () => {
      calls++;
      throw new Error("Model must not be called for corrupt rankings");
    })).rejects.toThrow("source mismatch");
    expect(calls).toBe(0);
  });

  it("rejects content, date, or question drift before making any model call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-lme-source-fingerprint-"));
    const rankings = join(dir, "rankings.json");
    const source_sha256 = questionSourcesHash(item.question, item.sessions);
    writeFileSync(rankings, JSON.stringify({
      status: "complete", selected_question_ids: ["fixture"],
      results: [{ question_id: "fixture", retrieved_session_ids: ["duplicate"], retrieved_session_occurrences: [1], source_sha256 }],
    }));
    const changed = [
      { ...item, sessions: item.sessions.map((source, index) => index === 1 ? { ...source, text: `${source.text} changed` } : source) },
      { ...item, sessions: item.sessions.map((source, index) => index === 1 ? { ...source, date: "2026-02-04" } : source) },
      { ...item, question: `${item.question} today` },
    ];
    for (const [index, altered] of changed.entries()) {
      const input = join(dir, `input-${index}.json`);
      writeFileSync(input, JSON.stringify({ provenance: {}, cases: [altered] }));
      let calls = 0;
      await expect(runEvaluation({
        input, rankings, out: join(dir, `out-${index}.json`), retrieval: "cached",
        concurrency: 1, contextChars: 1000, topK: 2,
      }, async () => {
        calls++;
        throw new Error("Model must not be called for fingerprint drift");
      })).rejects.toThrow("source fingerprint mismatch");
      expect(calls).toBe(0);
    }
  });

  it("uses a matching per-question fingerprint even when a subset has another dataset hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-lme-source-fingerprint-"));
    const input = join(dir, "input.json"), rankings = join(dir, "rankings.json"), out = join(dir, "out.json");
    writeFileSync(input, JSON.stringify({ provenance: { dataset_sha256: "full-dataset" }, cases: [item] }));
    writeFileSync(rankings, JSON.stringify({
      status: "complete", dataset_sha256: "subset-dataset", selected_question_ids: ["fixture"],
      results: [{
        question_id: "fixture", retrieved_session_ids: ["duplicate"], retrieved_session_occurrences: [1],
        source_sha256: questionSourcesHash(item.question, item.sessions),
      }],
    }));
    const call = async (kind: "answer" | "judge") => ({
      text: kind === "answer" ? '{"answer":"harbor","reasoning":"source"}' : '{"correct":true,"reason":"matches"}',
      error: null, attempts: 1, elapsed_ms: 0, model: "test", usage: null, prompt_sha256: "test",
    });
    const report = await runEvaluation({
      input, rankings, out, retrieval: "cached", concurrency: 1, contextChars: 1000, topK: 2,
    }, call);
    expect(report.source_verification).toBe("per_question_hash");
  });
});

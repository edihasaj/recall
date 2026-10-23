import { describe, expect, it } from "vitest";
import { buildFocusedEvidence, corpusObservationDate } from "../benchmark/longmemeval-focused-evidence.js";
import { evaluateCase } from "../benchmark/longmemeval-qa.js";
import type { Case } from "../benchmark/longmemeval-qa-support.js";

describe("focused LongMemEval evidence", () => {
  it("keeps exact source ranges while hiding gold-derived IDs", () => {
    const rows = [{
      id: "answer_LABEL_SENTINEL", occurrence: 17,
      date: "2026/09/12 (Sat) 07:30",
      text: "Irrelevant archived setting.\n".repeat(200)
        + "Zephyr workers now run in Helsinki; Oslo is obsolete.",
    }];
    const result = buildFocusedEvidence(rows, "Zephyr workers location", 6000);
    expect(result.text).not.toContain("answer_LABEL_SENTINEL");
    expect(result.text).not.toContain("occurrence");
    expect(result.text).toContain("Helsinki");
    expect(result.text).toContain("2026-09-12T07:30:00Z");
    expect(result.text.length).toBeLessThanOrEqual(6000);
    expect(result.full_chars).toBeGreaterThanOrEqual(result.chars);
    for (const source of result.sources) {
      const original = rows.find((row) => row.occurrence === source.occurrence)!;
      expect(source.used_chars).toBe(source.ranges.reduce((sum, range) => sum + range.end - range.start, 0));
      for (const range of source.ranges) {
        expect(result.text).toContain(original.text.slice(range.start, range.end));
      }
    }
  });

  it("does not pass references or source identifiers to generation in focused mode", async () => {
    const item: Case = {
      question_id: "test", question_type: "single-session-user",
      question: "Where are Zephyr workers?", question_date: "2026/10/01",
      reference: "REFERENCE_SENTINEL", gold_session_ids: ["answer_LABEL_SENTINEL"],
      is_abstention: false, answer_prompt_prefix: "__RECALL_CONTEXT__",
      judge_prompt_template: "REFERENCE_SENTINEL __RECALL_CANDIDATE__",
      sessions: [{ id: "answer_LABEL_SENTINEL", date: "2026/09/12 (Sat) 07:30", text: "Zephyr workers run in Helsinki." }],
    };
    const row = await evaluateCase(item, {
      retrieval: "cached", evidence: "focused", topK: 10, contextChars: 6000,
    }, ["answer_LABEL_SENTINEL"], async (kind, prompt) => {
      if (kind === "answer") {
        expect(prompt).not.toContain("REFERENCE_SENTINEL");
        expect(prompt).not.toContain("answer_LABEL_SENTINEL");
        expect(prompt).toContain("Helsinki");
      } else { expect(prompt).toContain("REFERENCE_SENTINEL"); }
      return {
        text: kind === "answer" ? '{"answer":"Helsinki"}' : '{"correct":true}',
        error: null, attempts: 1, elapsed_ms: 1, model: "mock", usage: null,
        prompt_sha256: "mock",
      };
    });
    expect(row.correct).toBe(true);
  });

  it("preserves the corpus observation clock and defers invalid date validation", () => {
    expect(corpusObservationDate("2026/09/12 (Sat) 07:30")).toBe("2026-09-12T07:30:00Z");
    expect(corpusObservationDate("invalid")).toBe("invalid");
  });

  it("can leave the caller's policy outside the quoted evidence", () => {
    const row = { id: "opaque", occurrence: 0, date: "2026-09-12", text: "user: Workers run in Helsinki." };
    const inline = buildFocusedEvidence([row], "Where are workers?", 6000);
    const separate = buildFocusedEvidence([row], "Where are workers?", 6000, false);
    expect(separate.text).toContain(row.text);
    expect(separate.sources).toEqual(inline.sources);
    expect(separate.chars).toBeLessThan(inline.chars);
  });
});

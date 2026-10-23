import { describe, expect, it } from "vitest";
import { evaluateCase, summarize } from "../benchmark/longmemeval-qa.js";
import type { Call, Case } from "../benchmark/longmemeval-qa-support.js";

const item: Case = {
  question_id: "test", question_type: "single-session-user", is_abstention: false,
  question: "Where are the workers?", question_date: "2026/10/01 (Thu) 23:59",
  reference: "REFERENCE_ONLY_FOR_JUDGE", gold_session_ids: ["answer_OPAQUE_LABEL"],
  answer_prompt_prefix: "Follow the user's requested answer format.\nQuestion: Where are the workers?\nQuestion Date: 2026-10-01T00:00:00+00:00\n\nRetrieved Context:\n__RECALL_CONTEXT__",
  judge_prompt_template: "REFERENCE_ONLY_FOR_JUDGE __RECALL_CANDIDATE__",
  sessions: [{ id: "answer_OPAQUE_LABEL", date: "2026-09-30", text: "user: The workers are in Helsinki." }],
};
const options = { retrieval: "cached" as const, answerCheck: "grounded" as const, topK: 10, contextChars: 1000 };
const response = (text: string | null, error: string | null = null): Call => ({
  text, error, attempts: 1, elapsed_ms: 1, model: "mock",
  usage: { input_tokens: 1, output_tokens: 1 }, prompt_sha256: "mock",
});

describe("fixed answer grounding stage", () => {
  it("checks a drafted answer before judging and keeps gold data judge-only", async () => {
    const kinds: string[] = [];
    const row = await evaluateCase(item, options, ["answer_OPAQUE_LABEL"], async (kind, prompt) => {
      kinds.push(kind);
      if (kinds.length === 1) return response('{"answer":"Oslo"}');
      if (kinds.length === 2) {
        expect(kind).toBe("answer");
        expect(prompt).toContain("Oslo");
        expect(prompt).toContain("The workers are in Helsinki.");
        expect(prompt).toContain("2026-10-01T00:00:00+00:00");
        expect(prompt).toContain("Follow the user's requested answer format.");
        expect(prompt).not.toContain("23:59");
        expect(prompt).not.toContain("REFERENCE_ONLY_FOR_JUDGE");
        expect(prompt).not.toContain("answer_OPAQUE_LABEL");
        return response('{"answer":"Helsinki"}');
      }
      expect(kind).toBe("judge");
      expect(prompt).toContain("REFERENCE_ONLY_FOR_JUDGE");
      expect(prompt).toContain("Helsinki");
      expect(prompt).not.toContain("Oslo");
      return response('{"correct":true}');
    });
    expect(kinds).toEqual(["answer", "answer", "judge"]);
    expect(row.draft_answer).toBe("Oslo");
    expect(row.answer).toBe("Helsinki");
    expect(row.correct).toBe(true);
    expect(row.review_call).not.toBeNull();
  });

  it("counts a grounding-call failure without judging or presenting the draft as final", async () => {
    let calls = 0;
    const row = await evaluateCase(item, options, ["answer_OPAQUE_LABEL"], async () => {
      calls++;
      return calls === 1 ? response('{"answer":"Helsinki"}') : response(null, "timeout");
    });
    expect(calls).toBe(2);
    expect(row.draft_answer).toBe("Helsinki");
    expect(row.answer).toBeNull();
    expect(row.judge_call).toBeNull();
    expect(row.error).toBe("review_timeout");
    expect(summarize([row], 1)).toMatchObject({ correct: 0, errors: 1, accuracy: 0 });
  });
});

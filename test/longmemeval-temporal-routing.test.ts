import { describe, expect, it } from "vitest";
import { resolveReasoningEffort } from "../benchmark/longmemeval-inference-policy.js";
import { resolveTemporalReasoningEffort } from "../benchmark/longmemeval-temporal-routing.js";

describe("LongMemEval temporal reasoning routing", () => {
  it("routes explicit chronology and date deduction to high effort", () => {
    for (const question of [
      "In what order did I visit these museums?",
      "Who attended my most recent concert with me?",
      "Which came first, the move or promotion?",
      "How long between my first and last appointment?",
      "Did I book the flight before the hotel?",
      "What was the earliest book I finished this year?",
      "Which restaurant did you recommend first?",
      "Which restaurant did you recommend a week before the wedding?",
      "Which came first: your advice to move or my promotion?",
    ]) expect(resolveTemporalReasoningEffort(question), question).toBe("high");
  });

  it("keeps recommendation requests and plain lookups at low effort", () => {
    for (const question of [
      "Any recommendations for a new recipe?",
      "Before my next trip, can you recommend a book?",
      "I visited Rome last June; could you suggest a hotel for my latest trip?",
      "Please suggest a gym; I moved last June, before the holidays.",
      "I need advice on a gift after my earlier trip in March.",
      "What is my previous occupation?",
      "What is my favorite color?",
    ]) expect(resolveTemporalReasoningEffort(question), question).toBe("low");
  });

  it("preserves every adaptive enumeration route", () => {
    for (const question of [
      "How many museums did I visit?",
      "What is the total count of books I own?",
      "Please count the trips I took.",
      "Can you recommend books? How many did I already read?",
    ]) {
      expect(resolveReasoningEffort("adaptive", question), question).toBe("high");
      expect(resolveTemporalReasoningEffort(question), question).toBe("high");
    }
  });
});

import { expect, it } from "vitest";
import { cloudRecordIsRelevant } from "../src/cloud/query-relevance.js";

it("accepts a named-subject paraphrase without requiring the same action words", () => {
  expect(cloudRecordIsRelevant("How should I install libraries for a Python project?",
    'Use uv instead of pip or Poetry for backend Python tooling; prefix Python CLI commands with "uv run".', 0.84)).toBe(true);
});
it("does not treat generic home/project overlap and moderate cosine as evidence", () => {
  expect(cloudRecordIsRelevant("How can I bake sourdough bread at home?",
    "Prefer terminal commands over opening applications on the home machine.", 0.84)).toBe(false);
  expect(cloudRecordIsRelevant("How can I bake sourdough bread at home?",
    "Use the personal account for Google Home and Nest access.", 0.84)).toBe(false);
  expect(cloudRecordIsRelevant("How can I bake sourdough bread at home?",
    "How to release Recall: validate all builds before publishing.", 0.84)).toBe(false);
  expect(cloudRecordIsRelevant("How can I bake sourdough bread at home?",
    "Home automation uses the Google personal account for every connected device.", 0.84)).toBe(false);
  expect(cloudRecordIsRelevant("Which account is used for Google Home?",
    "Use the personal account for Google Home and Nest access.", 0.84)).toBe(true);
  expect(cloudRecordIsRelevant("How should I install libraries for a Python project?",
    "Keep each project under the shared workspace.", 0.84)).toBe(false);
});
it("supports direct lexical tools, high semantic paraphrases, and rejects invalid scores", () => {
  expect(cloudRecordIsRelevant("uv", "Use uv to manage Python dependencies.")).toBe(true);
  expect(cloudRecordIsRelevant("How do I ship this?", "Check the release gate first.", 0.95)).toBe(true);
  for (const score of [NaN, Infinity, 2, undefined, "0.95", -1]) {
    expect(cloudRecordIsRelevant("How do I bake bread?", "Check the release gate first.", score)).toBe(false);
  }
});

import { describe, expect, it } from "vitest";
import { EVIDENCE_USE_GUIDANCE } from "../benchmark/longmemeval-focused-evidence.js";
import { buildHighlightedEvidence } from "../benchmark/longmemeval-highlighted-evidence.js";
import type { Ranked } from "../benchmark/longmemeval-qa-support.js";

const row = (text: string, overrides: Partial<Ranked> = {}): Ranked => ({
  id: "source-safe", occurrence: 0, date: "2026/10/19 (Sun) 09:30", text, ...overrides,
});

describe("LongMemEval highlighted evidence", () => {
  it("preserves a short original source verbatim and records its source range", () => {
    const source = row("user: Nila stores field notes in a green folder.");
    const result = buildHighlightedEvidence([source], "Where are Nila's notes?", 5_000);
    expect(result.text).toContain(source.text);
    expect(result.text.indexOf(source.text)).not.toBe(result.text.lastIndexOf(source.text));
    expect(result.text).toContain("Conversation date: 2026/10/19 (Sun) 09:30.");
    expect(result.text.split("Conversation date: 2026/10/19 (Sun) 09:30.")).toHaveLength(3);
    expect(result.sources[0]).toMatchObject({
      full_chars: source.text.length, used_chars: source.text.length, truncated: false,
      ranges: [{ start: 0, end: source.text.length }],
    });
  });

  it("uses a late-tail fact in the preview when no complete full-prefix unit fits", () => {
    const source = row(`${"archival preface ".repeat(120)}\nuser: Nila moved the field notes to a green folder.`);
    const cap = EVIDENCE_USE_GUIDANCE.length + 1_000;
    const result = buildHighlightedEvidence([source], "Where did Nila move the notes?", cap);
    expect(result.text).toContain("Nila moved the field notes to a green folder.");
    expect(result.sources[0]!.ranges.some((range) => range.start > 0)).toBe(true);
    expect(result.sources[0]!.truncated).toBe(true);
  });

  it("unions preview and full ranges without counting overlap twice", () => {
    const text = "user: Nila keeps a green folder.\nassistant: Nila may consider a blue folder.";
    const result = buildHighlightedEvidence([row(text)], "Where is Nila's folder?", 5_000);
    const source = result.sources[0]!;
    expect(source.used_chars).toBe(text.length);
    expect(source.ranges).toEqual([{ start: 0, end: text.length }]);
  });

  it("keeps an overlapping preview and partial full prefix as one original range", () => {
    const first = "user: Miri keeps a brass lantern.";
    const text = `${first}\n${"archive ".repeat(400)}\nuser: She later packed a tent.`;
    const result = buildHighlightedEvidence(
      [row(text)],
      "Where does Miri keep the brass lantern?",
      EVIDENCE_USE_GUIDANCE.length + 1_000,
    );
    const source = result.sources[0]!;
    expect(source.ranges).toEqual([{ start: 0, end: first.length }]);
    expect(source.used_chars).toBe(first.length);
  });

  it("keeps opaque IDs and occurrence values out of rendered evidence", () => {
    const source = row("user: Nila stores a map.", { id: "answer_hidden_marker", occurrence: 91 });
    const result = buildHighlightedEvidence([source], "Where is the map?", 5_000);
    expect(result.text).not.toContain("answer_hidden_marker");
    expect(result.text).not.toContain("91");
    expect(result.text).toContain("## Memory 1");
  });

  it("obeys the exact cap and leaves full diagnostic size at least rendered size", () => {
    const sources = [
      row(`user: Nila keeps a green folder.\n${"archive ".repeat(200)}`),
      row(`assistant: Nila suggested a red folder.\n${"archive ".repeat(200)}`, { occurrence: 1 }),
    ];
    const cap = EVIDENCE_USE_GUIDANCE.length + 1_800;
    const result = buildHighlightedEvidence(sources, "Which folder does Nila keep?", cap);
    expect(result.chars).toBe(result.text.length);
    expect(result.chars).toBeLessThanOrEqual(cap);
    expect(result.full_chars).toBeGreaterThanOrEqual(result.chars);
  });

  it("does not render a partial role turn when a full prefix cannot end on a newline", () => {
    const source = row(`assistant: ${"long planning note ".repeat(100)}\nuser: Nila keeps notes in a green folder.`);
    const cap = EVIDENCE_USE_GUIDANCE.length + 1_000;
    const result = buildHighlightedEvidence([source], "Where are Nila's notes?", cap);
    expect(result.text).toContain("user: Nila keeps notes in a green folder.");
    expect(result.text).toContain("[Full session omitted or truncated to fit the context budget.]");
    expect(result.text).not.toContain("assistant: long planning note long");
  });

  it("keeps duplicate IDs as distinct ranked occurrences", () => {
    const result = buildHighlightedEvidence([
      row("user: Nila owns a compass.", { id: "duplicate", occurrence: 2 }),
      row("user: Nila owns a lantern.", { id: "duplicate", occurrence: 7 }),
    ], "What does Nila own?", 5_000);
    expect(result.sources.map((source) => [source.id, source.occurrence])).toEqual([
      ["duplicate", 2], ["duplicate", 7],
    ]);
    expect(result.text).toContain("## Memory 1");
    expect(result.text).toContain("## Memory 2");
  });

  it("handles an empty ranking and rejects a cap below guidance", () => {
    expect(buildHighlightedEvidence([], "Any question", EVIDENCE_USE_GUIDANCE.length).text)
      .toBe(EVIDENCE_USE_GUIDANCE);
    expect(() => buildHighlightedEvidence([], "Any question", EVIDENCE_USE_GUIDANCE.length - 1))
      .toThrow("guidance");
  });
});

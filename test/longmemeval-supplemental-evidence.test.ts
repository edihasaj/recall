import { describe, expect, it } from "vitest";
import { buildHighlightedEvidence } from "../benchmark/longmemeval-highlighted-evidence.js";
import { buildSupplementalEvidence } from "../benchmark/longmemeval-supplemental-evidence.js";
import type { Ranked } from "../benchmark/longmemeval-qa-support.js";

const question = "Which Saturday activity does Mira prefer?";

function row(
  text: string,
  rank: number,
  overrides: Partial<Ranked> = {},
): Ranked {
  return {
    id: `opaque-source-${rank}`,
    occurrence: rank + 40,
    date: `2026/10/${String(rank + 1).padStart(2, "0")} (Sun) 09:30`,
    text,
    ...overrides,
  };
}

function primaryRows(): Ranked[] {
  return Array.from({ length: 10 }, (_, index) =>
    row(`user: Primary archive ${index + 1} is unrelated.`, index));
}

function supplementalDiagnostics(result: ReturnType<typeof buildSupplementalEvidence>) {
  if (!("supplemental" in result)) throw new Error("Expected supplemental diagnostics");
  return result.supplemental;
}

describe("LongMemEval supplemental evidence", () => {
  it("keeps highlighted primary evidence byte-for-byte and appends complete scoped units", () => {
    const primary = primaryRows();
    const extras = [
      row([
        "user: Preferences",
        "Activity choices:",
        "Do not choose hiking.",
        "Mira prefers pottery on Saturdays.",
      ].join("\n"), 10, { id: "answer_HIDDEN_11", occurrence: 987 }),
      row("assistant: Mira also mentioned painting classes.", 11, { id: "answer_HIDDEN_12", occurrence: 986 }),
    ];
    const cap = 20_000;
    const base = buildHighlightedEvidence(primary, question, cap);
    const result = buildSupplementalEvidence([...primary, ...extras], question, cap);

    expect(result.text.slice(0, base.text.length)).toBe(base.text);
    expect(result.sources.slice(0, 10)).toEqual(base.sources);
    expect(result.text).toContain("## Additional Memory 11");
    expect(result.text).toContain("## Additional Memory 12");
    expect(result.text).toContain("Observed: 2026-10-11T09:30:00Z");
    expect(result.text).toContain("user: Preferences\nActivity choices:\nDo not choose hiking.\nMira prefers pottery on Saturdays.");
    expect(result.text).not.toContain("answer_HIDDEN_11");
    expect(result.text).not.toContain("answer_HIDDEN_12");
    expect(result.text).not.toContain("987");
    expect(result.sources.map((source) => [source.id, source.occurrence])).toContainEqual([
      "answer_HIDDEN_11", 987,
    ]);

    for (const [index, source] of result.sources.slice(10).entries()) {
      const original = extras[index]!;
      expect(source.full_chars).toBe(original.text.length);
      expect(source.used_chars).toBe(source.ranges.reduce(
        (total, range) => total + range.end - range.start, 0,
      ));
      for (const range of source.ranges) {
        expect(range.start).toBeGreaterThanOrEqual(0);
        expect(range.end).toBeLessThanOrEqual(original.text.length);
        expect(result.text).toContain(original.text.slice(range.start, range.end));
      }
    }
    expect(result.chars).toBe(result.text.length);
    expect(result.chars).toBeLessThanOrEqual(cap);
  });

  it("has exact parity with highlighted evidence for at most ten sources", () => {
    for (const includeGuidance of [false, true]) {
      for (const count of [0, 1, 10]) {
        const rows = primaryRows().slice(0, count);
        expect(buildSupplementalEvidence(rows, question, 20_000, includeGuidance))
          .toEqual(buildHighlightedEvidence(rows, question, 20_000, includeGuidance));
      }
    }
  });

  it("tracks duplicate IDs as separate occurrences without rendering either identifier", () => {
    const primary = primaryRows();
    const result = buildSupplementalEvidence([
      ...primary,
      row("user: Mira prefers pottery.", 10, { id: "duplicate-hidden", occurrence: 4 }),
      row("user: Mira also enjoys painting.", 11, { id: "duplicate-hidden", occurrence: 8 }),
    ], question, 20_000);

    expect(result.sources.slice(10).map((source) => [source.id, source.occurrence])).toEqual([
      ["duplicate-hidden", 4],
      ["duplicate-hidden", 8],
    ]);
    expect(result.text).not.toContain("duplicate-hidden");
    expect(result.text).toContain("## Additional Memory 11");
    expect(result.text).toContain("## Additional Memory 12");
  });

  it("honors exact and tiny remaining capacity without emitting a supplemental header", () => {
    const primary = primaryRows();
    const extra = row("user: Mira prefers pottery.", 10);
    const initial = buildHighlightedEvidence(primary, question, 20_000);
    const exactCap = initial.text.length;
    const exactBase = buildHighlightedEvidence(primary, question, exactCap);

    for (const cap of [exactCap, exactCap + 1]) {
      const result = buildSupplementalEvidence([...primary, extra], question, cap);
      expect(result.text).toBe(buildHighlightedEvidence(primary, question, cap).text);
      expect(result.text).not.toContain("## Additional Memory");
      expect(result.sources.slice(0, 10)).toEqual(buildHighlightedEvidence(primary, question, cap).sources);
      expect(result.sources[10]).toMatchObject({
        full_chars: extra.text.length, used_chars: 0, ranges: [], truncated: true,
      });
      expect(supplementalDiagnostics(result).omitted)
        .toEqual([{ source_rank: 11, reason: "budget" }]);
    }
    expect(exactBase.text).toBe(initial.text);
  });

  it("uses spare capacity for a smaller complete supplemental unit", () => {
    const primary = Array.from({ length: 10 }, (_, index) => ({
      id: `hidden${index}`, occurrence: index,
      date: "2026/10/01 (Thu) 00:00", text: `user: unrelated ${index}`,
    }));
    const extra = {
      id: "hidden-supplement", occurrence: 10, date: "2026/10/01 (Thu) 00:00",
      text: Array.from({ length: 12 }, (_, index) => `user: pottery activity option ${index}.`).join("\n"),
    };
    const base = buildHighlightedEvidence(primary, "Which pottery activity?", 20_000, false);
    const cap = base.chars + 150;
    const result = buildSupplementalEvidence([...primary, extra], "Which pottery activity?", cap, false);
    const source = result.sources[10]!;

    expect(base.chars).toBe(1_530);
    expect(result.text.slice(0, base.chars)).toBe(base.text);
    expect(result.sources.slice(0, 10)).toEqual(base.sources);
    expect(result.text).toContain("## Additional Memory 11");
    expect(source.used_chars).toBeGreaterThan(0);
    expect(source.ranges).not.toEqual([]);
    expect(result.chars).toBeLessThanOrEqual(cap);
    expect(supplementalDiagnostics(result)).toEqual({ included_ranks: [11], omitted: [] });
    for (const range of source.ranges) {
      expect(result.text).toContain(extra.text.slice(range.start, range.end));
    }
    for (let spare = 100; spare <= 200; spare++) {
      const bounded = buildSupplementalEvidence(
        [...primary, extra],
        "Which pottery activity?",
        base.chars + spare,
        false,
      );
      expect(supplementalDiagnostics(bounded).included_ranks).toContain(11);
      expect(bounded.chars).toBeLessThanOrEqual(base.chars + spare);
    }
  });

  it("finds a smaller unit in a supplemental source whose 4,000-character probe candidate exceeds the caller cap", () => {
    const primary = Array.from({ length: 10 }, (_, index) => ({
      id: `hidden${index}`, occurrence: index,
      date: "2026/10/01 (Thu) 00:00", text: `user: unrelated ${index}`,
    }));
    const extra = {
      id: "hidden-long-supplement", occurrence: 10, date: "2026/10/01 (Thu) 00:00",
      text: Array.from({ length: 160 }, (_, index) => `user: pottery activity option ${index}.`).join("\n"),
    };
    const base = buildHighlightedEvidence(primary, "Which pottery activity?", 20_000, false);
    const result = buildSupplementalEvidence(
      [...primary, extra],
      "Which pottery activity?",
      base.chars + 150,
      false,
    );

    expect(extra.text.length).toBeGreaterThan(4_000);
    expect(result.text.slice(0, base.chars)).toBe(base.text);
    expect(result.sources.slice(0, 10)).toEqual(base.sources);
    expect(supplementalDiagnostics(result).included_ranks).toEqual([11]);
    expect(result.sources[10]!.used_chars).toBeGreaterThan(0);
    expect(result.chars).toBeLessThanOrEqual(base.chars + 150);
  });

  it("does not confuse dense ellipsis framing with the absence of a complete unit", () => {
    const primary = Array.from({ length: 10 }, (_, index) => ({
      id: `hidden${index}`, occurrence: index,
      date: "2026/10/01 (Thu) 00:00", text: `user: unrelated ${index}`,
    }));
    const extra = {
      id: "hidden-dense-supplement", occurrence: 10, date: "2026/10/01 (Thu) 00:00",
      text: `user: Header\n${Array.from(
        { length: 3_000 },
        () => `qa\n${"z".repeat(100)}\n`,
      ).join("")}`,
    };
    for (const cap of [5_000]) {
      const base = buildHighlightedEvidence(primary, "qa", cap, false);
      const result = buildSupplementalEvidence([...primary, extra], "qa", cap, false);

      expect(result.text.slice(0, base.chars)).toBe(base.text);
      expect(result.sources.slice(0, 10)).toEqual(base.sources);
      expect(supplementalDiagnostics(result).included_ranks).toEqual([11]);
      expect(result.sources[10]!.used_chars).toBeGreaterThan(0);
      expect(result.chars).toBeLessThanOrEqual(cap);
    }
  }, 10_000);

  it("keeps a whole short source at its exact framed capacity but not one character below", () => {
    for (const includeGuidance of [false, true]) {
      const primary = primaryRows();
      const extra = row("user: pottery", 10);
      const spacious = buildSupplementalEvidence([...primary, extra], question, 20_000, includeGuidance);
      const exact = buildSupplementalEvidence([...primary, extra], question, spacious.chars, includeGuidance);
      const below = buildSupplementalEvidence([...primary, extra], question, spacious.chars - 1, includeGuidance);

      expect(supplementalDiagnostics(spacious).included_ranks).toContain(11);
      expect(exact.chars).toBe(spacious.chars);
      expect(supplementalDiagnostics(exact).included_ranks).toContain(11);
      expect(supplementalDiagnostics(below).included_ranks).not.toContain(11);
      expect(below.chars).toBeLessThan(spacious.chars);
    }
  });

  it("skips an oversized unit as no complete unit and continues in ranking order", () => {
    const primary = primaryRows();
    const tooLarge = row(`user: ${"pottery ".repeat(700)}`, 10);
    const later = row("user: Mira prefers pottery on Saturdays.", 11);
    const result = buildSupplementalEvidence([...primary, tooLarge, later], question, 20_000);

    expect(result.sources[10]).toMatchObject({
      full_chars: tooLarge.text.length, used_chars: 0, ranges: [], truncated: true,
    });
    expect(result.sources[11]!.used_chars).toBe(later.text.length);
    expect(result.text).not.toContain("## Additional Memory 11");
    expect(result.text).toContain("## Additional Memory 12");
    expect(supplementalDiagnostics(result)).toEqual({
      included_ranks: [12],
      omitted: [{ source_rank: 11, reason: "no_complete_unit" }],
    });
  });

  it("rejects invalid supplemental source values rather than treating them as omissions", () => {
    const base = [...primaryRows()];
    for (const text of [null, 123, {}, []]) {
      const invalid = { ...row("user: not used", 10), text } as unknown as Ranked;
      expect(() => buildSupplementalEvidence([...base, invalid], question, 20_000))
        .toThrow(/source text/);
    }
    const wrongDate = { ...row("user: not used", 10), date: 123 } as unknown as Ranked;
    expect(() => buildSupplementalEvidence([...base, wrongDate], question, 20_000))
      .toThrow(/source date/);
    for (const occurrence of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      const wrongOccurrence = { ...row("user: not used", 10), occurrence } as unknown as Ranked;
      expect(() => buildSupplementalEvidence([...base, wrongOccurrence], question, 20_000))
        .toThrow(/source occurrence/);
    }
  });

  it("rejects oversized rankings and does not swallow unsupported errors", () => {
    const rows = Array.from({ length: 21 }, (_, index) => row("user: evidence", index));
    expect(() => buildSupplementalEvidence(rows, question, 20_000)).toThrow(/at most 20/);

    const invalid = { ...row("user: not used", 10), id: null } as unknown as Ranked;
    expect(() => buildSupplementalEvidence([...primaryRows(), invalid], question, 20_000)).toThrow(TypeError);
  });
});

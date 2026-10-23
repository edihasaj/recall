import { describe, expect, it } from "vitest";
import {
  ADDITIVE_EXTRA_CAP, ADDITIVE_FRAMED_CAP, ADDITIVE_RAW_UNIT_CAP, ADDITIVE_TOTAL_CAP,
  buildAdditiveLexicalEvidence,
} from "../benchmark/longmemeval-additive-evidence.js";
import type { Ranked } from "../benchmark/longmemeval-qa-support.js";
import { buildSupplementalEvidence } from "../benchmark/longmemeval-supplemental-evidence.js";

const question = "Which Saturday activity does Mira prefer?";

function row(text: string, occurrence: number, overrides: Partial<Ranked> = {}): Ranked {
  return {
    id: `opaque-${occurrence}`,
    occurrence,
    date: `2026/10/${String((occurrence % 27) + 1).padStart(2, "0")} (Sun) 09:30`,
    text,
    ...overrides,
  };
}

function original(textFor: (index: number) => string = (i) => `user: Archive ${i} is unrelated.`): Ranked[] {
  return Array.from({ length: 20 }, (_, index) => row(textFor(index), index));
}

function bigText(index: number): string {
  return Array.from({ length: 700 }, (_, line) => `user: archive ${index} filler line ${line}.`).join("\n");
}

function pottery(count: number): string {
  return Array.from({ length: count }, (_, i) => `user: Mira pottery activity option ${i}.`).join("\n");
}

describe("LongMemEval additive lexical evidence", () => {
  it("keeps the base rendering an exact prefix even when it nearly fills its cap", () => {
    const rows = original(bigText);
    const base = buildSupplementalEvidence(rows, question, 180_000, false);
    const lexical = [row("user: Mira prefers pottery on Saturdays.", 100)];
    const result = buildAdditiveLexicalEvidence(rows, lexical, question);

    expect(base.chars).toBeGreaterThan(150_000);
    expect(base.chars).toBeLessThanOrEqual(180_000);
    expect(result.text.slice(0, base.text.length)).toBe(base.text);
    expect(result.sources.slice(0, 20)).toEqual(base.sources);
    expect(result.supplemental).toEqual((base as { supplemental: unknown }).supplemental);
    expect(result.text.slice(base.text.length)).toBe(
      "\n\n## Lexical Memory 21\nObserved: 2026-10-20T09:30:00Z\nuser: Mira prefers pottery on Saturdays.",
    );
    expect(result.chars).toBeLessThanOrEqual(ADDITIVE_TOTAL_CAP);
    expect(result.additive.extra_chars).toBe(result.text.length - base.text.length);
  });

  it("accepts an empty or short lexical tail and appends nothing for it", () => {
    const rows = original();
    const base = buildSupplementalEvidence(rows, question, 180_000, false);
    const empty = buildAdditiveLexicalEvidence(rows, [], question);
    expect(empty.text).toBe(base.text);
    expect(empty.sources).toEqual(base.sources);
    expect(empty.additive).toMatchObject({ extra_chars: 0, selected_occurrences: [], included_ranks: [] });

    const alreadyOriginal = buildAdditiveLexicalEvidence(rows, [rows[3]!, rows[7]!], question);
    expect(alreadyOriginal.text).toBe(base.text);
    expect(alreadyOriginal.additive.selected_occurrences).toEqual([]);

    const small = buildAdditiveLexicalEvidence(rows, [row("user: Mira likes pottery.", 101)], question);
    expect(small.sources).toHaveLength(21);
    expect(small.additive.included_ranks).toEqual([21]);
  });

  it("deduplicates by occurrence and takes the first twenty distinct outside the original", () => {
    const rows = original();
    const lexical: Ranked[] = [rows[2]!];
    for (let i = 0; i < 25; i++) {
      lexical.push(row(`user: Mira pottery candidate ${i}.`, 200 + i));
      if (i % 5 === 0) lexical.push(row(`user: Mira pottery candidate ${i}.`, 200 + i));
    }
    const result = buildAdditiveLexicalEvidence(rows, lexical, question);
    expect(result.additive.selected_occurrences).toEqual(Array.from({ length: 20 }, (_, i) => 200 + i));
    expect(result.sources).toHaveLength(40);
    expect(result.sources.slice(20).map((s) => s.occurrence)).toEqual(result.additive.selected_occurrences);
    expect(result.additive.included_ranks).toEqual(Array.from({ length: 20 }, (_, i) => 21 + i));
    expect(result.text).toContain("## Lexical Memory 40");
    expect(result.text).not.toContain("## Lexical Memory 41");
  });

  it("rejects invalid shapes and inconsistent or repeated identities", () => {
    const rows = original();
    const dup = row("user: Mira pottery.", 300);
    expect(() => buildAdditiveLexicalEvidence(rows.slice(0, 19), [], question)).toThrow(/exactly 20/);
    expect(() => buildAdditiveLexicalEvidence([...rows, dup], [], question)).toThrow(/exactly 20/);
    expect(() => buildAdditiveLexicalEvidence([...rows.slice(0, 19), { ...rows[0]! }], [], question))
      .toThrow(/repeats an occurrence/);
    for (const change of [{ text: "user: other." }, { id: "other" }, { date: "2026/01/01 (Thu) 00:00" }]) {
      expect(() => buildAdditiveLexicalEvidence(rows, [{ ...rows[5]!, ...change }], question))
        .toThrow(/inconsistent duplicate/);
      expect(() => buildAdditiveLexicalEvidence(rows, [dup, { ...dup, ...change }], question))
        .toThrow(/inconsistent duplicate/);
    }
    // A conflict beyond the first twenty selected rows is still rejected.
    const many = Array.from({ length: 22 }, (_, i) => row(`user: pottery ${i}.`, 400 + i));
    expect(() => buildAdditiveLexicalEvidence(rows, [...many, { ...many[21]!, text: "changed" }], question))
      .toThrow(/inconsistent duplicate/);
    expect(() => buildAdditiveLexicalEvidence(rows, [{ ...dup, occurrence: -1 }], question)).toThrow(/occurrence/);
    expect(() => buildAdditiveLexicalEvidence(rows, [{ ...dup, text: 5 as unknown as string }], question))
      .toThrow(/text/);
  });

  it("replaces only the trusted initial header and keeps body text and storage identity out", () => {
    const rows = original();
    const body = [
      "user: Mira prefers pottery.",
      "## Memory 1",
      "## Lexical Memory 21",
      "## Additional Memory 11",
      "Observed: 1999-01-01",
    ].join("\n");
    const result = buildAdditiveLexicalEvidence(rows, [
      row(body, 777, { id: "hidden-source-id" }),
      row("user: Mira also enjoys painting.", 778, { id: "hidden-two" }),
    ], question);
    const tail = result.text.slice(result.text.indexOf("\n\n## Lexical Memory 21\n"));
    expect(tail.startsWith(`\n\n## Lexical Memory 21\nObserved: 2026-10-22T09:30:00Z\n${body}`)).toBe(true);
    expect(tail).toContain("\n\n## Lexical Memory 22\n");
    expect(result.text).not.toContain("hidden-source-id");
    expect(result.text).not.toContain("hidden-two");
    expect(result.text).not.toMatch(/\b77[78]\b/);
    expect(result.sources[20]).toMatchObject({ id: "hidden-source-id", occurrence: 777 });
  });

  it("includes only complete units within the per-source cap and preserves exact ranges", () => {
    const rows = original();
    const long = row(pottery(400), 500);
    const result = buildAdditiveLexicalEvidence(rows, [long], question);
    const source = result.sources[20]!;
    const block = result.text.slice(result.text.lastIndexOf("## Lexical Memory 21"));

    expect(long.text.length).toBeGreaterThan(ADDITIVE_FRAMED_CAP);
    expect(block.length).toBeLessThanOrEqual(ADDITIVE_FRAMED_CAP);
    expect(source.used_chars).toBeGreaterThan(0);
    expect(source.used_chars).toBe(source.ranges.reduce((t, r) => t + r.end - r.start, 0));
    expect(source.truncated).toBe(true);
    for (const range of source.ranges) {
      const piece = long.text.slice(range.start, range.end);
      expect(block).toContain(piece);
      expect(piece.startsWith("user: ")).toBe(true);
      expect(piece.endsWith(".")).toBe(true);
    }
  });

  it("respects per-source and shared extra budgets, including labels and separators", () => {
    const rows = original();
    const lexical = Array.from({ length: 8 }, (_, i) => row(pottery(30), 600 + i));
    const limits = { extra_chars: 1_000, framed_chars: 300, raw_unit_chars: 280 };
    const base = buildSupplementalEvidence(rows, question, 180_000, false);
    const result = buildAdditiveLexicalEvidence(rows, lexical, question, limits);
    const blocks = result.text.slice(base.text.length).split("\n\n## ").filter(Boolean);

    expect(result.additive.extra_chars).toBeLessThanOrEqual(1_000);
    expect(result.text.length - base.text.length).toBe(result.additive.extra_chars);
    expect(result.additive.included_ranks.length).toBeGreaterThan(0);
    expect(result.additive.omitted.length).toBeGreaterThan(0);
    expect(result.additive.omitted.every((o) => o.reason === "budget")).toBe(true);
    for (const block of blocks) expect(block.length + "\n\n## ".length).toBeLessThanOrEqual(300 + 2);
    for (const rank of result.additive.included_ranks) {
      const source = result.sources[rank - 1]!;
      expect(source.used_chars).toBeGreaterThan(0);
      expect(source.used_chars).toBeLessThanOrEqual(280);
    }
    for (const entry of result.additive.omitted) {
      expect(result.sources[entry.source_rank - 1]).toMatchObject({ used_chars: 0, ranges: [], occurrence: entry.occurrence });
    }
  });

  it("stays within the real extra and total caps for twenty dense lexical sources", () => {
    const rows = original(bigText);
    const dense = (seed: number) => Array.from({ length: 900 }, (_, i) => `user: Mira pottery ${seed} ${i}.`).join("\n");
    const lexical = Array.from({ length: 20 }, (_, i) => row(dense(i), 900 + i));
    const result = buildAdditiveLexicalEvidence(rows, lexical, question);
    expect(result.additive.extra_chars).toBeLessThanOrEqual(ADDITIVE_EXTRA_CAP);
    expect(result.chars).toBeLessThanOrEqual(ADDITIVE_TOTAL_CAP);
    expect(result.sources.length).toBeLessThanOrEqual(40);
    const tail = result.text.slice(result.additive.base_chars);
    for (const block of tail.split("\n\n## Lexical Memory ").slice(1)) {
      expect(block.length + "\n\n## Lexical Memory ".length).toBeLessThanOrEqual(ADDITIVE_FRAMED_CAP + 2);
    }
  });

  it("accepts only integer limits within the protocol ceilings", () => {
    const rows = original();
    const lexical = [row("user: Mira likes pottery.", 101)];
    const fixed = buildAdditiveLexicalEvidence(rows, lexical, question);
    expect(buildAdditiveLexicalEvidence(rows, lexical, question, {})).toEqual(fixed);
    expect(buildAdditiveLexicalEvidence(rows, lexical, question, {
      extra_chars: ADDITIVE_EXTRA_CAP, framed_chars: ADDITIVE_FRAMED_CAP, raw_unit_chars: ADDITIVE_RAW_UNIT_CAP,
    })).toEqual(fixed);
    expect(buildAdditiveLexicalEvidence(rows, lexical, question, { extra_chars: 0 }).additive)
      .toMatchObject({ extra_chars: 0, included_ranks: [], omitted: [{ reason: "budget" }] });
    expect(buildAdditiveLexicalEvidence(rows, lexical, question, { extra_chars: undefined })).toEqual(fixed);

    const invalid: Partial<Record<"extra_chars" | "framed_chars" | "raw_unit_chars", unknown>>[] = [
      { extra_chars: ADDITIVE_EXTRA_CAP + 1 }, { extra_chars: -1 }, { extra_chars: 1.5 },
      { extra_chars: Number.NaN }, { extra_chars: Number.POSITIVE_INFINITY }, { extra_chars: "10" },
      { framed_chars: 0 }, { framed_chars: ADDITIVE_FRAMED_CAP + 1 }, { framed_chars: 2.5 },
      { framed_chars: Number.NaN }, { framed_chars: null },
      { raw_unit_chars: 0 }, { raw_unit_chars: ADDITIVE_RAW_UNIT_CAP + 1 }, { raw_unit_chars: -5 },
      { raw_unit_chars: Number.NaN }, { raw_unit_chars: 0.5 },
    ];
    for (const limits of invalid) {
      expect(() => buildAdditiveLexicalEvidence(rows, lexical, question, limits as never)).toThrow(/limit/);
    }
    expect(() => buildAdditiveLexicalEvidence(rows, lexical, question, { extra: 5 } as never))
      .toThrow(/Unknown additive evidence limit/);
    expect(() => buildAdditiveLexicalEvidence(rows, lexical, question, null as never)).toThrow(/object/);
  });

  describe("exact raw-ceiling search", () => {
    // Headings with oversized filler make the first anchor's mandatory context
    // overflow at high ceilings, so only a slightly smaller ceiling selects the
    // complete final user turn. A coarse step would skip that ceiling.
    function headingSource(headings: number, filler: number, needle: string, last: number): string {
      const lines = ["user:"];
      for (let i = 0; i < headings; i++) {
        lines.push(`H${String(i).padStart(2, "0")}:`, "f".repeat(filler));
      }
      lines.push(needle, `user: ${"z".repeat(last)}`);
      return lines.join("\n");
    }

    function expectCompleteLastTurn(
      result: ReturnType<typeof buildAdditiveLexicalEvidence>,
      text: string,
      last: number,
      framedCap: number,
    ) {
      const lastTurn = `user: ${"z".repeat(last)}`;
      const block = result.text.slice(result.additive.base_chars + 2);
      expect(result.additive.omitted).toEqual([]);
      expect(result.additive.included_ranks).toEqual([21]);
      expect(block.startsWith("## Lexical Memory 21\n")).toBe(true);
      expect(block.length).toBeLessThanOrEqual(framedCap);
      expect(block.endsWith(lastTurn)).toBe(true);
      const source = result.sources[20]!;
      expect(source.used_chars).toBeGreaterThan(0);
      expect(text.slice(source.ranges.at(-1)!.start, source.ranges.at(-1)!.end)).toBe(lastTurn);
    }

    it("finds a complete final user turn at the default caps", () => {
      const text = headingSource(100, 4_001, `needle ${"x".repeat(3_387)}`, 3_784);
      const result = buildAdditiveLexicalEvidence(original(), [row(text, 100)], "Which needle fact applies?");
      expectCompleteLastTurn(result, text, 3_784, ADDITIVE_FRAMED_CAP);
    });

    it("finds an exact-fit ceiling at tighter caps", () => {
      const text = headingSource(20, 201, "needle fact.", 84);
      const result = buildAdditiveLexicalEvidence(
        original(), [row(text, 100)], "Which needle fact applies?",
        { raw_unit_chars: 98, framed_chars: 144 },
      );
      expectCompleteLastTurn(result, text, 84, 144);
      expect(result.additive.extra_chars).toBeLessThanOrEqual(146);
    });

    it("still reports no complete unit when every ceiling overflows its context", () => {
      const lines: string[] = [];
      for (let i = 0; i < 5; i++) lines.push(`${"h".repeat(300)}:`, "a");
      const result = buildAdditiveLexicalEvidence(
        original(), [row(lines.join("\n"), 101)], "Which needle fact applies?",
        { raw_unit_chars: 200, framed_chars: 200 },
      );
      expect(result.additive.omitted).toEqual([{ source_rank: 21, occurrence: 101, reason: "no_complete_unit" }]);
      expect(result.sources[20]).toMatchObject({ used_chars: 0, ranges: [] });
    });
  });

  it("omits an oversized source as no complete unit and continues with later sources", () => {
    const rows = original();
    const oversized = row(`user: ${"pottery ".repeat(700)}`, 700);
    const later = row("user: Mira prefers pottery on Saturdays.", 701);
    const result = buildAdditiveLexicalEvidence(rows, [oversized, later], question);
    expect(result.sources[20]).toMatchObject({
      full_chars: oversized.text.length, used_chars: 0, ranges: [], truncated: true,
    });
    expect(result.additive.omitted).toEqual([{ source_rank: 21, occurrence: 700, reason: "no_complete_unit" }]);
    expect(result.additive.included_ranks).toEqual([22]);
    expect(result.text).not.toContain("## Lexical Memory 21");
    expect(result.text).toContain("## Lexical Memory 22\n");
  });

  it("reserves a zero-overlap user fact from a lexical source", () => {
    const rows = original();
    const text = [
      "user: I keep my gear at the lakeside cabin.",
      ...Array.from({ length: 150 }, (_, i) => `assistant: Mira prefers pottery activity advice ${i}.`),
    ].join("\n");
    const result = buildAdditiveLexicalEvidence(rows, [row(text, 800)], question);
    expect(result.sources[20]!.ranges[0]!.start).toBe(0);
    expect(result.text).toContain("user: I keep my gear at the lakeside cabin.");
  });
});

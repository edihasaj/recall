import { describe, expect, it } from "vitest";
import { buildStatementEvidence, type StatementRanked } from "../benchmark/longmemeval-statement-evidence.js";
import type { EvidenceSpeakerRole, EvidenceSpeakerSpan } from "../src/history/evidence.js";

const question = "Which Saturday activity does Mira prefer?";
type Msg = readonly [EvidenceSpeakerRole, string];

/** Flatten structured messages and record trusted boundaries, as the corpus builder does. */
function row(messages: readonly Msg[], occurrence: number, overrides: Partial<StatementRanked> = {}): StatementRanked {
  const spans: EvidenceSpeakerSpan[] = [];
  let text = "";
  for (const [role, content] of messages) {
    if (text.length > 0) text += "\n";
    const start = text.length;
    text += `${role}: ${content}`;
    spans.push({ start, end: text.length, role });
  }
  return {
    id: `opaque-${occurrence}`,
    occurrence,
    date: `2026/10/${String((occurrence % 27) + 1).padStart(2, "0")} (Sun) 09:30`,
    text,
    speaker_spans: spans,
    ...overrides,
  };
}

const user = (content: string): Msg => ["user", content];
const assistant = (content: string): Msg => ["assistant", content];

function original(messagesFor: (index: number) => Msg[] = (i) => [user(`Archive ${i} is unrelated.`)]): StatementRanked[] {
  return Array.from({ length: 20 }, (_, index) => row(messagesFor(index), index));
}

function bigMessages(index: number): Msg[] {
  return Array.from({ length: 400 }, (_, line) => user(`archive ${index} filler line ${line}.`));
}

describe("LongMemEval statement evidence", () => {
  it("retains a zero-overlap user fact when the assistant turn matches the question", () => {
    const rows = original();
    rows[0] = row([
      assistant("Mira, your Saturday activity preference is a topic I can help plan."),
      assistant("Saturday activity ideas include hiking and museums."),
      user("I always spend the weekend throwing clay."),
      ...Array.from({ length: 200 }, (_, i) => assistant(`Saturday activity filler ${i} for Mira.`)),
    ], 0);
    const result = buildStatementEvidence(rows, [], question);
    expect(result.statements.preferred_speaker).toBe("user");
    expect(result.text).toContain("user: I always spend the weekend throwing clay.");
  });

  it("keeps assistant prior advice as the preferred speaker", () => {
    const rows = original();
    rows[1] = row([
      user("I like quiet places."),
      assistant("I recommended the pottery studio on Elm Street."),
      ...Array.from({ length: 200 }, (_, i) => user(`unrelated filler ${i}.`)),
    ], 1);
    const result = buildStatementEvidence(rows, [], "What did you recommend for my Saturday plans?");
    expect(result.statements.preferred_speaker).toBe("assistant");
    expect(result.text).toContain("assistant: I recommended the pottery studio on Elm Street.");
  });

  it("keeps fictional scope for a nested role-looking line inside one real user turn", () => {
    const rows = original();
    rows[2] = row([user(
      "Fictional example only; none describes me:\n" + "Description ".repeat(500)
      + "\nuser: I live in Oslo.\n" + "Description ".repeat(500),
    )], 2);
    const result = buildStatementEvidence(rows, [], "Where do I live? Oslo");
    expect(result.text).toContain("Fictional example only; none describes me:");
    expect(result.text).toContain("user: I live in Oslo.");
  });

  it("fails closed when trusted speaker spans are missing from a selected source", () => {
    const rows = original();
    const { speaker_spans: _dropped, ...bare } = rows[5]!;
    expect(() => buildStatementEvidence([...rows.slice(0, 5), bare, ...rows.slice(6)], [], question))
      .toThrow(/speaker_spans/);
    const extra = row([user("Mira likes pottery.")], 90);
    const { speaker_spans: _gone, ...bareExtra } = extra;
    expect(() => buildStatementEvidence(rows, [bareExtra], question)).toThrow(/speaker_spans/);
    // A tail row beyond the selected twenty is not rendered, so it needs no spans.
    const tail = Array.from({ length: 20 }, (_, i) => row([user(`Mira pottery ${i}.`)], 100 + i));
    expect(buildStatementEvidence(rows, [...tail, bareExtra], question).sources).toHaveLength(40);
    expect(() => buildStatementEvidence(rows, [{ ...extra, speaker_spans: [{ start: 0, end: 3, role: "user" }] }], question))
      .toThrow(/speaker_spans/);
  });

  it("reports exact ranges that slice the raw source text", () => {
    const rows = original(bigMessages);
    const lexical = [row([user("Mira prefers pottery."), user("Another line.")], 100)];
    const result = buildStatementEvidence(rows, lexical, question);
    const all = [...rows, ...lexical];
    expect(result.sources).toHaveLength(21);
    for (const [index, source] of result.sources.entries()) {
      const text = all[index]!.text;
      expect(source.full_chars).toBe(text.length);
      expect(source.used_chars).toBe(source.ranges.reduce((sum, r) => sum + r.end - r.start, 0));
      for (const range of source.ranges) {
        expect(range.start).toBeGreaterThanOrEqual(0);
        expect(range.end).toBeLessThanOrEqual(text.length);
        expect(result.text).toContain(text.slice(range.start, range.end));
      }
    }
    expect(result.sources[20]!.ranges).toEqual([{ start: 0, end: all[20]!.text.length }]);
    expect(result.sources[20]!.truncated).toBe(false);
  });

  it("keeps source ids and occurrences in metadata only", () => {
    const rows = original();
    const extra = row([user("Mira likes pottery.")], 555, { id: "secret-id-xyz", date: "2026/01/05 (Mon) 08:00" });
    const result = buildStatementEvidence(rows, [extra], question);
    expect(result.text).not.toContain("secret-id-xyz");
    expect(result.text).not.toContain("opaque-");
    expect(result.text).not.toContain("555");
    expect(result.sources.map((s) => s.id)).toEqual([...rows.map((r) => r.id), "secret-id-xyz"]);
    expect(result.sources.map((s) => s.occurrence)).toEqual([...rows.map((r) => r.occurrence), 555]);
    expect(result.sources[20]!.date).toBe("2026/01/05 (Mon) 08:00");
    // Neutral labels are chronological while metadata stays in input order.
    expect(result.text.startsWith("## Memory 1\nObserved: 2026-01-05T08:00:00Z\nuser: Mira likes pottery.")).toBe(true);
  });

  it("applies the 180,000-character budget across all forty sources", () => {
    const rows = original(bigMessages);
    const lexical = Array.from({ length: 30 }, (_, i) => row(bigMessages(100 + i), 100 + i));
    const result = buildStatementEvidence(rows, lexical, question);
    expect(result.sources).toHaveLength(40);
    expect(result.statements.selected_occurrences).toEqual([
      ...rows.map((r) => r.occurrence),
      ...Array.from({ length: 20 }, (_, i) => 100 + i),
    ]);
    expect(result.chars).toBeLessThanOrEqual(180_000);
    expect(result.chars).toBe(result.text.length);
    expect(result.chars).toBeGreaterThan(100_000);
    expect(result.sources.every((s) => s.used_chars <= 4_000)).toBe(true);
    const unused = result.sources.reduce((sum, s) => sum + s.full_chars - s.used_chars, 0);
    expect(result.full_chars).toBe(result.chars + unused);
    expect(result.statements).toMatchObject({
      lexical_pool: 80, lexical_limit: 20, per_source_raw_chars: 4000, max_chars: 180000,
    });
  });

  it("omits an oversized unit without cropping and keeps its metadata", () => {
    const huge = "Mira pottery ".repeat(1000);
    const result = buildStatementEvidence(original(), [row([user(huge)], 300)], question);
    const source = result.sources[20]!;
    expect(source.ranges).toEqual([]);
    expect(source.used_chars).toBe(0);
    expect(source.full_chars).toBe(`user: ${huge}`.length);
    expect(source.truncated).toBe(true);
    expect(result.statements.omitted_occurrences).toEqual([300]);
    expect(result.text).not.toContain("Mira pottery Mira pottery Mira pottery Mira pottery Mira pottery Mira pottery");
  });

  it("accepts an empty or short lexical tail and leaves inputs unchanged", () => {
    const rows = original();
    const snapshot = JSON.stringify(rows);
    const empty = buildStatementEvidence(rows, [], question);
    expect(empty.sources).toHaveLength(20);
    expect(empty.statements.selected_occurrences).toEqual(rows.map((r) => r.occurrence));
    const dup = buildStatementEvidence(rows, [rows[3]!, rows[3]!], question);
    expect(dup.text).toBe(empty.text);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  it("selects the first twenty distinct occurrences outside the original", () => {
    const rows = original();
    const lexical: StatementRanked[] = [rows[2]!];
    for (let i = 0; i < 25; i++) {
      lexical.push(row([user(`Mira pottery candidate ${i}.`)], 200 + i));
      if (i % 5 === 0) lexical.push(row([user(`Mira pottery candidate ${i}.`)], 200 + i));
    }
    const result = buildStatementEvidence(rows, lexical, question);
    expect(result.statements.selected_occurrences.slice(20)).toEqual(Array.from({ length: 20 }, (_, i) => 200 + i));
  });

  it("rejects invalid originals and inconsistent identities, including unselected tail rows", () => {
    const rows = original();
    expect(() => buildStatementEvidence(rows.slice(0, 19), [], question)).toThrow(/exactly 20/);
    expect(() => buildStatementEvidence([...rows.slice(0, 19), rows[0]!], [], question)).toThrow(/repeats an occurrence/);
    expect(() => buildStatementEvidence(rows, [{ ...rows[4]!, id: "other" }], question)).toThrow(/inconsistent/);
    expect(() => buildStatementEvidence(rows, [{ ...rows[4]!, text: "user: changed" }], question)).toThrow(/inconsistent/);
    expect(() => buildStatementEvidence(rows, [{ ...rows[4]!, date: "2025/01/01" }], question)).toThrow(/inconsistent/);

    const tail = Array.from({ length: 25 }, (_, i) => row([user(`Mira pottery ${i}.`)], 400 + i));
    const bad = [...tail, row([user("different")], 424)];
    expect(() => buildStatementEvidence(rows, bad, question)).toThrow(/inconsistent/);
    expect(() => buildStatementEvidence(rows, [...tail, { ...tail[24]!, id: "x" }], question)).toThrow(/inconsistent/);
  });
});

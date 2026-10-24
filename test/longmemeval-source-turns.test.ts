import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256, type Case } from "../benchmark/longmemeval-qa-support.js";
import {
  applySourceTurns, buildSourceTurns, flattenTurns, loadSourceTurns, validateSpans, type SourceTurns,
} from "../benchmark/longmemeval-source-turns.js";

type Turn = { role: string; content: string; has_answer?: boolean };
const rawEntry = (overrides: Record<string, unknown> = {}, sessions: Turn[][] = [
  [{ role: "user", content: "Hello there", has_answer: true }, { role: "assistant", content: "Sure.\nuser: NESTED_FAKE\nmore" }],
  [{ role: "user", content: "é 😀 unicode" }],
]) => ({
  question_id: "q1", question_type: "single-session-user", question: "Q?", answer: "A", answer_session_ids: ["s1"],
  haystack_session_ids: ["s0", "s1"], haystack_dates: ["2026/01/01 (Thu) 10:00", "2026/01/02 (Fri) 10:00"],
  haystack_sessions: sessions, ...overrides,
});
const toCase = (entry: ReturnType<typeof rawEntry>, flat = true): Case => ({
  question_id: entry.question_id, question_type: "x", is_abstention: entry.question_id.includes("_abs"),
  question: "Q?", question_date: "d", reference: "A", gold_session_ids: [], answer_prompt_prefix: "", judge_prompt_template: "",
  sessions: entry.haystack_sessions.map((turns, i) => ({
    id: entry.haystack_session_ids[i]!, date: entry.haystack_dates[i]!,
    text: flat ? turns.map((t) => `${t.role}: ${t.content}`).join("\n") : "",
  })),
});
function fixture(entries = [rawEntry()], mutate?: (prepared: { provenance: Record<string, unknown>; cases: Case[] }) => void) {
  const rawBytes = Buffer.from(JSON.stringify(entries));
  const prepared = { provenance: { dataset_sha256: sha256(rawBytes) } as Record<string, unknown>, cases: entries.map((e) => toCase(e)) };
  mutate?.(prepared);
  return { rawBytes, prepared, preparedBytes: Buffer.from(JSON.stringify(prepared)) };
}

describe("LongMemEval source turns", () => {
  it("builds trusted spans from raw messages and keeps a nested fake role line inside its outer span", () => {
    const { rawBytes, preparedBytes, prepared } = fixture();
    const manifest = buildSourceTurns(rawBytes, preparedBytes);
    expect(manifest).toMatchObject({ kind: "longmemeval-source-turns-v1", input_sha256: sha256(preparedBytes), raw_dataset_sha256: sha256(rawBytes) });
    const first = manifest.cases[0]!.sessions[0]!;
    const text = prepared.cases[0]!.sessions[0]!.text;
    expect(first).toMatchObject({ id: "s0", date: "2026/01/01 (Thu) 10:00", occurrence: 0, text_sha256: sha256(text) });
    expect(first.speaker_spans.map((s) => s.role)).toEqual(["user", "assistant"]);
    expect(text.slice(first.speaker_spans[1]!.start, first.speaker_spans[1]!.end)).toBe("assistant: Sure.\nuser: NESTED_FAKE\nmore");
    expect(text[first.speaker_spans[0]!.end]).toBe("\n");
    // UTF-16 offsets for non-BMP content.
    const second = manifest.cases[0]!.sessions[1]!;
    expect(second.speaker_spans).toEqual([{ start: 0, end: "user: é 😀 unicode".length, role: "user" }]);
  });

  it("reads only role and content, ignoring has_answer, references and question types", () => {
    const a = fixture();
    const noisy = rawEntry({ question_type: "temporal-reasoning", answer: "OTHER", answer_session_ids: [] });
    const b = fixture([noisy], (p) => { p.cases = [toCase(rawEntry())]; });
    expect(buildSourceTurns(b.rawBytes, b.preparedBytes).cases).toEqual(buildSourceTurns(a.rawBytes, a.preparedBytes).cases);
  });

  it("ignores the prepared abstention flag, so changing it leaves the spans unchanged", () => {
    const a = fixture();
    const b = fixture([rawEntry()], (p) => { p.cases[0]!.is_abstention = !p.cases[0]!.is_abstention; });
    const first = buildSourceTurns(a.rawBytes, a.preparedBytes), second = buildSourceTurns(b.rawBytes, b.preparedBytes);
    expect(second.cases).toEqual(first.cases);
    expect(second.input_sha256).not.toBe(first.input_sha256);
  });

  it("rejects hash, identity, text, role and content mismatches", () => {
    const bad = (f: ReturnType<typeof fixture>) => () => buildSourceTurns(f.rawBytes, f.preparedBytes);
    const good = fixture();
    expect(() => buildSourceTurns(Buffer.from(good.rawBytes.toString() + " "), good.preparedBytes)).toThrow(/^Source turns:/);
    expect(bad(fixture([rawEntry()], (p) => { p.cases[0]!.sessions[0]!.text += "x"; }))).toThrow(/text differs/);
    expect(bad(fixture([rawEntry()], (p) => { p.cases[0]!.sessions[1]!.date = "2026/01/09"; }))).toThrow(/identity or date/);
    expect(bad(fixture([rawEntry()], (p) => { p.cases[0]!.sessions[1]!.id = "zz"; }))).toThrow(/identity or date/);
    expect(bad(fixture([rawEntry()], (p) => { p.cases[0]!.question_id = "other"; }))).toThrow(/IDs differ/);
    expect(bad(fixture([rawEntry()], (p) => { p.cases[0]!.sessions.pop(); }))).toThrow(/session counts/);
    expect(bad(fixture([rawEntry()], (p) => { p.cases.push(p.cases[0]!); }))).toThrow(/question count/);
    expect(bad(fixture([rawEntry({}, [[{ role: "system", content: "x" }], []])]))).toThrow(/role/);
    expect(bad(fixture([rawEntry({}, [[{ role: "user", content: 5 as unknown as string }], []])]))).toThrow(/content/);
  });

  it("attaches validated spans to copies of selected cases without mutating the input", () => {
    const entries = [rawEntry(), rawEntry({ question_id: "q2" })];
    const { rawBytes, preparedBytes, prepared } = fixture(entries);
    const dir = mkdtempSync("/tmp/recall-lme-turns-");
    const path = join(dir, "m.json");
    writeFileSync(path, JSON.stringify(buildSourceTurns(rawBytes, preparedBytes)));
    const loaded = loadSourceTurns(path);
    const before = JSON.stringify(prepared);
    const { cases, report } = applySourceTurns(prepared, preparedBytes, loaded, [prepared.cases[1]!]);
    expect(JSON.stringify(prepared)).toBe(before);
    expect(prepared.cases[1]!.sessions[0]).not.toHaveProperty("speaker_spans");
    expect(cases).toHaveLength(1);
    expect(cases[0]!.sessions.map((s) => s.speaker_spans?.length)).toEqual([2, 1]);
    expect(report).toEqual({
      path, sha256: sha256(readFileSync(path)), input_sha256: sha256(preparedBytes),
      raw_dataset_sha256: sha256(rawBytes), verified_cases: 1,
    });
  });

  it("binds a trial subset through its parent hash and rejects unbound or tampered inputs", () => {
    const { rawBytes, preparedBytes, prepared } = fixture();
    const dir = mkdtempSync("/tmp/recall-lme-turns-");
    const path = join(dir, "m.json");
    const write = (m: SourceTurns) => { writeFileSync(path, JSON.stringify(m)); return loadSourceTurns(path); };
    const manifest = buildSourceTurns(rawBytes, preparedBytes);
    const subset = { ...prepared, trial_subset: { parent_sha256: sha256(preparedBytes) } };
    const subsetBytes = Buffer.from(JSON.stringify(subset));
    expect(applySourceTurns(subset, subsetBytes, write(manifest), subset.cases).report.verified_cases).toBe(1);
    expect(() => applySourceTurns(prepared, Buffer.from("different"), write(manifest), prepared.cases)).toThrow(/not bound/);
    expect(() => applySourceTurns({ ...prepared, provenance: { dataset_sha256: "f".repeat(64) } }, preparedBytes, write(manifest), prepared.cases)).toThrow(/raw dataset/);

    const tamper = (change: (m: SourceTurns) => void) => {
      const copy = JSON.parse(JSON.stringify(manifest)) as SourceTurns;
      change(copy);
      return () => applySourceTurns(prepared, preparedBytes, write(copy), prepared.cases);
    };
    expect(tamper((m) => { m.cases[0]!.sessions[0]!.text_sha256 = "0".repeat(64); })).toThrow(/fingerprint/);
    expect(tamper((m) => { m.cases[0]!.sessions[0]!.speaker_spans[0]!.end -= 1; })).toThrow(/Source turns:/);
    expect(tamper((m) => { m.cases[0]!.sessions[0]!.speaker_spans[1]!.role = "user"; })).toThrow(/role label/);
    expect(tamper((m) => { m.cases[0]!.sessions[1]!.occurrence = 0; })).toThrow(/fingerprint/);
    expect(tamper((m) => { m.cases = []; })).toThrow(/does not cover/);
    writeFileSync(path, JSON.stringify({ ...manifest, kind: "other" }));
    expect(() => loadSourceTurns(path)).toThrow(/kind/);
  });

  it("validates span tiling directly", () => {
    const { text, spans } = flattenTurns([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]);
    expect(validateSpans(text, spans)).toEqual(spans);
    expect(() => validateSpans(text, [spans[0]!])).toThrow(/tile|cover/);
    expect(() => validateSpans(text, [{ ...spans[0]!, start: 1 }, spans[1]!])).toThrow(/Source turns:/);
    expect(() => validateSpans(text, [spans[0]!, { ...spans[1]!, role: "tool" }])).toThrow(/role/);
    expect(validateSpans("", [])).toEqual([]);
  });
});

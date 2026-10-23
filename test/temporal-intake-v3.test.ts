import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import { captureTemporalSource, type TemporalLanguageSource, type TemporalTextModel } from "../src/temporal/intake-v3.js";
import { stableTemporalKey } from "../src/temporal/intake-contract.js";
import { appendTemporalFact } from "../src/temporal/store.js";

let number = 0;
function db(): RecallDb { process.env.RECALL_EMBEDDINGS_DISABLED = "true"; return initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-intake-v3-")), `${number++}.db`)); }
const source = { repo: "owner/app", observed_at: "2026-02-01T10:00:00Z" };
function model(response: object): TemporalTextModel { return vi.fn(async () => JSON.stringify(response)); }
function fact(overrides: Record<string, unknown> = {}) {
  return { subject: "acme", predicate: "color", value: "blue", valid_from: "2026-02-01", valid_to: null, time_basis: "explicit", quote: "Acme color is blue on 2026-02-01", supersedes_event_id: null, ...overrides };
}
async function capture(store: RecallDb, input: Omit<TemporalLanguageSource, "repo" | "observed_at">, proposal: Record<string, unknown>, policies?: Parameters<typeof captureTemporalSource>[2]["predicates"]) {
  return captureTemporalSource(store, { ...source, ...input }, { model: model({ route: "temporal", facts: [fact(proposal)] }), predicates: policies });
}

describe("temporal language intake v3", () => {
  it("grounds exact underscore labels and rejects identifier substrings", async () => {
    const store = db();
    const exact = "api_gateway pool_size is 12 on 2026-02-01.";
    const stored = await capture(store, { event_id: "underscore", text: exact }, fact({ subject: "api_gateway", predicate: "pool_size", value: "12", quote: exact }), [{ name: "pool_size", description: "pool size", value_kind: "integer" }]);
    expect(stored.stored).toHaveLength(1);
    const open = await capture(store, { event_id: "underscore-open", text: exact }, fact({ subject: "api_gateway", predicate: "pool_size", value: "12", quote: exact }));
    expect(open.stored).toHaveLength(1);
    const substring = "apiary poolside is 12 on 2026-02-01.";
    const rejected = await capture(store, { event_id: "substring", text: substring }, fact({ subject: "api", predicate: "pool_size", value: "12", quote: substring }), [{ name: "pool_size", description: "pool size", value_kind: "integer" }]);
    expect(rejected.rejected[0]?.reason).toBe("ungrounded_new_key");
  });

  it("keeps uncertainty scoped to a supported independent continuation", async () => {
    const store = db();
    for (const [event_id, text] of [
      ["repaint", "Acme color is blue on 2026-02-01, and we might repaint it later."],
      ["lobby", "Acme color is blue on 2026-02-01, and the lobby is not green."],
    ]) {
      const quote = "Acme color is blue on 2026-02-01";
      expect((await capture(store, { event_id, text }, fact({ quote }))).stored).toHaveLength(1);
    }
    for (const [event_id, text, quote] of [
      ["pretend", "Pretend Acme color is blue on 2026-02-01.", "Acme color is blue on 2026-02-01"],
      ["condition", "If Acme color is blue on 2026-02-01, deploy it.", "Acme color is blue on 2026-02-01"],
      ["negated", "It is not true that Acme color is blue on 2026-02-01.", "Acme color is blue on 2026-02-01"],
      ["hedged", "Acme color is blue on 2026-02-01, but I might be wrong.", "Acme color is blue on 2026-02-01"],
      ["doubted", "I doubt Acme color is blue on 2026-02-01.", "Acme color is blue on 2026-02-01"],
      ["contradiction", "Acme color is blue on 2026-02-01, and the Acme is not blue.", "Acme color is blue on 2026-02-01"],
      ["scope-hedge", "Acme color is blue on 2026-02-01, and we might repaint it because I could be wrong.", "Acme color is blue on 2026-02-01"],
      ["contraction", "Acme doesn't use blue on 2026-02-01.", "Acme doesn't use blue on 2026-02-01"],
      ["third-clause", "Acme color is blue on 2026-02-01, and the lobby is not green, but Acme color is not blue.", "Acme color is blue on 2026-02-01"],
      ["multiline-condition", "If the launch succeeds,\nAcme color is blue on 2026-02-01.", "Acme color is blue on 2026-02-01"],
    ]) {
      const result = await capture(store, { event_id, text }, fact({ quote }));
      expect(result.rejected[0]?.reason).toBe("unsupported_clause");
    }
  });

  it("uses trusted user spans only for direct first-person assertions", async () => {
    const store = db();
    const favorite = "My favorite color is blue.";
    const first = await capture(store, { event_id: "favorite", text: favorite, speaker_spans: [{ start: 0, end: favorite.length, role: "user", subject: "user" }] }, fact({ subject: "user", predicate: "favorite_color", quote: favorite, valid_from: null, time_basis: "observed" }), [{ name: "favorite_color", description: "favorite color" }]);
    expect(first.stored).toHaveLength(1);
    const live = "I live in Berlin.";
    const second = await capture(store, { event_id: "live", text: live, speaker_spans: [{ start: 0, end: live.length, role: "user", subject: "user" }] }, fact({ subject: "user", predicate: "live_in", value: "Berlin", quote: live, valid_from: null, time_basis: "observed" }), [{ name: "live_in", description: "where the person lives" }]);
    expect(second.stored).toHaveLength(1);
  });

  it("applies the same speaker proof to first-person dates and replacements", async () => {
    const store = db();
    const dated = "My favorite color is blue on 2026-02-01.";
    const datedResult = await capture(store, { event_id: "dated", text: dated, speaker_spans: [{ start: 0, end: dated.length, role: "user", subject: "user" }] }, fact({ subject: "user", predicate: "favorite_color", quote: dated }), [{ name: "favorite_color", description: "favorite color" }]);
    expect(datedResult.stored).toHaveLength(1);
    appendTemporalFact(store, { repo: source.repo, event_id: "old", subject: "user", predicate: "favorite_color", value: "red", valid_from: "2026-01-01", observed_at: "2026-01-01", evidence: "old" });
    const replacement = "Correction: My favorite color is blue, replacing old on 2026-02-01.";
    const changed = await capture(store, { event_id: "replacement", text: replacement, speaker_spans: [{ start: 0, end: replacement.length, role: "user", subject: "user" }] }, fact({ subject: "user", predicate: "favorite_color", quote: replacement, replacement_quote: replacement, supersedes_event_id: "old" }), [{ name: "favorite_color", description: "favorite color" }]);
    expect(changed.stored[0]?.supersedes_id).toBeTruthy();
  });

  it("rejects possessives, reported speech, role mismatch, invalid spans, and repeated quotes", async () => {
    const cases: Array<{ event_id: string; text: string; spans: TemporalLanguageSource["speaker_spans"]; quote: string }> = [
      { event_id: "possessive", text: "My wife's favorite color is blue.", spans: [{ start: 0, end: "My wife's favorite color is blue.".length, role: "user", subject: "user" }], quote: "My wife's favorite color is blue." },
      { event_id: "reported", text: "John said 'I live in Rome'.", spans: [{ start: 0, end: "John said 'I live in Rome'.".length, role: "user", subject: "user" }], quote: "I live in Rome" },
      { event_id: "reported-full", text: "John said 'I live in Rome'.", spans: [{ start: 0, end: "John said 'I live in Rome'.".length, role: "user", subject: "user" }], quote: "John said 'I live in Rome'." },
      { event_id: "reported-told", text: "John told me 'I live in Rome'.", spans: [{ start: 0, end: "John told me 'I live in Rome'.".length, role: "user", subject: "user" }], quote: "I live in Rome" },
      { event_id: "nested-possessive", text: "My favorite color consultant's favorite color is blue.", spans: [{ start: 0, end: "My favorite color consultant's favorite color is blue.".length, role: "user", subject: "user" }], quote: "My favorite color consultant's favorite color is blue." },
      { event_id: "mixed-owners", text: "My favorite color is red; my wife's favorite color is blue.", spans: [{ start: 0, end: "My favorite color is red; my wife's favorite color is blue.".length, role: "user", subject: "user" }], quote: "My favorite color is red; my wife's favorite color is blue." },
      { event_id: "reported-wrong-relation", text: "I live near Rome.", spans: [{ start: 0, end: "I live near Rome.".length, role: "user", subject: "user" }], quote: "I live near Rome." },
      { event_id: "assistant", text: "My favorite color is blue.", spans: [{ start: 0, end: "My favorite color is blue.".length, role: "assistant", subject: "user" }], quote: "My favorite color is blue." },
      { event_id: "ambiguous", text: "My favorite color is blue. My favorite color is blue.", spans: [{ start: 0, end: "My favorite color is blue. My favorite color is blue.".length, role: "user", subject: "user" }], quote: "My favorite color is blue." },
    ];
    for (const item of cases) {
      const store = db();
      const predicate = item.event_id.startsWith("reported") ? "live_in" : "favorite_color";
      const value = item.event_id.startsWith("reported") ? "Rome" : "blue";
      const result = await capture(store, { event_id: item.event_id, text: item.text, speaker_spans: item.spans }, fact({ subject: "user", predicate, value, quote: item.quote, valid_from: null, time_basis: "observed" }), [{ name: predicate, description: predicate.replace(/_/g, " ") }]);
      expect(result.stored).toEqual([]);
    }
    const store = db(), calls = vi.fn(async () => "{}");
    const invalid = await captureTemporalSource(store, { ...source, event_id: "overlap", text: "My favorite color is blue.", speaker_spans: [{ start: 0, end: 10, role: "user", subject: "user" }, { start: 9, end: 26, role: "user", subject: "user" }] }, { model: calls });
    expect(invalid.error).toBe("invalid_source");
    expect(calls).not.toHaveBeenCalled();
  });

  it("makes span metadata part of a bounded canonical replay receipt", async () => {
    const store = db(), text = "My favorite color is blue.", spans = [{ start: 0, end: text.length, role: "user" as const, subject: "User" }];
    const response = { route: "temporal", facts: [fact({ subject: "user", predicate: "favorite_color", quote: text, valid_from: null, time_basis: "observed" })] };
    const options = { model: model(response), predicates: [{ name: "favorite_color", description: "favorite color" }] };
    const first = await captureTemporalSource(store, { ...source, event_id: "receipt", text, speaker_spans: spans }, options);
    expect(first.stored).toHaveLength(1);
    expect(JSON.parse(first.stored[0]!.evidence)).toEqual({ version: 3, text, speaker_spans: [{ ...spans[0], subject: "user" }] });
    const replay = await captureTemporalSource(store, { ...source, event_id: "receipt", text, speaker_spans: spans }, { ...options, model: vi.fn(async () => { throw new Error("replay should not call"); }) });
    expect(replay.stored.map((item) => item.id)).toEqual(first.stored.map((item) => item.id));
    const changed = await captureTemporalSource(store, { ...source, event_id: "receipt", text, speaker_spans: [{ ...spans[0], subject: "someone-else" }] }, options);
    expect(changed.error).toBe("replay_conflict");
    const collisionModel = vi.fn(async () => "{}");
    const collision = await captureTemporalSource(store, { ...source, event_id: "receipt", text: first.stored[0]!.evidence }, { model: collisionModel });
    expect(collision.error).toBe("replay_conflict");
    expect(collisionModel).not.toHaveBeenCalled();
    const tooLarge = await captureTemporalSource(store, { ...source, event_id: "large", text: "x".repeat(15_990), speaker_spans: [{ start: 0, end: 15_990, role: "user", subject: "user" }] }, { model: vi.fn(async () => "{}") });
    expect(tooLarge.error).toBe("receipt_too_large");
  });

  it("does not borrow another clause's relative or natural date", async () => {
    const store = db();
    for (const [index, date, valid_from] of [
      [0, "yesterday", "2026-01-31"],
      [1, "on January 1, 2026", "2026-01-01"],
    ] as const) {
      const text = `Acme color is blue, and John moved ${date}.`;
      const result = await capture(store, { event_id: `unrelated-date-${index}`, text }, fact({ quote: text, valid_from }));
      expect(result.stored).toHaveLength(0);
      expect(result.rejected[0]?.reason).toBe("missing_temporal_anchor");
    }
  });

  it("keeps canonical keys, explicit-date validation, and source idempotence", async () => {
    const store = db(), text = "Acme color is blue on 2026-02-01.";
    const captured = await capture(store, { event_id: "stable", text }, fact());
    expect(captured.stored[0]?.subject).toBe("acme");
    expect(stableTemporalKey(source.repo, "Acme", "color")).toBe(stableTemporalKey(source.repo, "acme", "color"));
    const replay = await captureTemporalSource(store, { ...source, event_id: "stable", text }, { model: vi.fn(async () => { throw new Error("replay should not call"); }) });
    expect(replay.stored).toHaveLength(1);
    const noDate = await capture(store, { event_id: "bad-date", text: "Acme color is blue." }, fact({ quote: "Acme color is blue.", valid_from: "2026-02-01" }));
    expect(noDate.rejected[0]?.reason).toBe("missing_temporal_anchor");
    const may = "Acme color is blue on May 5, 2025.";
    expect((await capture(store, { event_id: "month-may", text: may }, fact({ quote: may, valid_from: "2025-05-05" }))).stored).toHaveLength(1);
  });
});

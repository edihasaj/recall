import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import { captureTemporalSource, queryTemporalLanguage, type TemporalTextModel } from "../src/temporal/intake.js";
import { appendTemporalFact, queryTemporalFacts } from "../src/temporal/store.js";

let number = 0;
function db(): RecallDb { process.env.RECALL_EMBEDDINGS_DISABLED = "true"; return initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-intake-v2-")), `${number++}.db`)); }
const source = { repo: "owner/app", event_id: "s", observed_at: "2026-02-01T10:00:00Z" };
function model(response: object): TemporalTextModel { return vi.fn(async () => JSON.stringify(response)); }
function temporalFact(overrides: Record<string, unknown> = {}) { return { value: "Cloudflare", valid_from: "2026-02-01", valid_to: null, time_basis: "explicit", quote: "Cloudflare on 2026-02-01", supersedes_event_id: null, ...overrides }; }

describe("temporal language intake v2", () => {
  it("keeps entity keys stable, but retains independent conflicts and corroboration", async () => {
    const store = db();
    const firstText = "Acme production hosting provider is Azure on 2026-01-01.";
    const first = await captureTemporalSource(store, { ...source, text: firstText }, { model: model({ route: "temporal", facts: [temporalFact({ value: "Azure", valid_from: "2026-01-01", quote: firstText, subject: "Acme Production", predicate: "hosting_provider" })] }) });
    expect(first.stored).toHaveLength(1);
    const keyId = (await import("../src/temporal/intake-contract.js")).stableTemporalKey(source.repo, "acme production", "hosting_provider");
    for (const [event_id, value] of [["s2", "Cloudflare"], ["s3", "Azure"]]) {
      const text = "Acme Production hosting provider is " + value + " on 2026-02-01.";
      await captureTemporalSource(store, { ...source, event_id, text }, { model: model({ route: "temporal", facts: [temporalFact({ value, subject: "acme  production", predicate: "hosting_provider", quote: text })] }) });
    }
    const result = await queryTemporalLanguage(store, { repo: source.repo, text: "current host", now: "2026-03-01" }, { model: model({ route: "temporal", key_id: keyId }) });
    expect(result.result?.facts.map((fact) => fact.value).sort()).toEqual(["Azure", "Azure", "Cloudflare"]); expect(result.result?.conflict).toBe(true);
  });

  it("links only explicit replacements and preserves source cutoffs", async () => {
    const store = db(); const old = appendTemporalFact(store, { repo: source.repo, event_id: "old", subject: "production", predicate: "hosting_provider", value: "Azure", valid_from: "2026-01-01", observed_at: "2026-01-01", evidence: "old" });
    const key = (await import("../src/temporal/intake-contract.js")).stableTemporalKey(source.repo, "production", "hosting_provider");
    const text = "Correction: production hosting provider moved to Cloudflare on 2026-02-01.";
    const captured = await captureTemporalSource(store, { ...source, text }, { model: model({ route: "temporal", facts: [temporalFact({ subject: "production", predicate: "hosting_provider", supersedes_event_id: "old", replacement_quote: text, quote: text })] }) });
    expect(captured.stored[0]?.supersedes_id).toBe(old.id);
    const prior = await queryTemporalLanguage(store, { repo: source.repo, text: "host", now: "2026-01-15" }, { model: model({ route: "temporal", key_id: key }) });
    expect(prior.result?.facts.map((item) => item.value)).toEqual(["Azure"]);
  });

  it("rejects invalid intervals and impossible dates without losing valid neighbors", async () => {
    const store = db();
    const firstText = "Production hosting provider is Azure on 2024-02-29.";
    const secondText = "Production hosting provider is Cloudflare on 2026-01-01.";
    const result = await captureTemporalSource(store, { ...source, text: firstText + " " + secondText }, { model: model({ route: "temporal", facts: [temporalFact({ value: "Azure", subject: "production", predicate: "hosting_provider", valid_from: "2024-02-29", valid_to: "2024-02-29", quote: firstText }), temporalFact({ subject: "production", predicate: "hosting_provider", valid_from: "2026-01-01", quote: secondText })] }) });
    expect(result.rejected).toEqual([{ index: 0, reason: "invalid_interval" }]); expect(result.stored).toHaveLength(1);
    expect(queryTemporalFacts(store, { repo: source.repo, subject: "production", predicate: "hosting_provider", as_of: "2026-02-01", observed_before: "2026-03-01" }).facts).toHaveLength(1);
  });

  it("uses observed state from the observation instant and never calls models for secrets", async () => {
    const store = db(); const calls = vi.fn(async () => "{}");
    const observed = await captureTemporalSource(store, { ...source, text: "Production hosting provider uses Azure." }, { model: model({ route: "temporal", facts: [temporalFact({ value: "Azure", subject: "production", predicate: "hosting_provider", valid_from: null, time_basis: "observed", quote: "Production hosting provider uses Azure" })] }) });
    expect(observed.stored[0]?.valid_from).toBe("2026-02-01T10:00:00.000Z");
    const sensitive = await captureTemporalSource(store, { ...source, event_id: "secret", text: "OPENAI_API_KEY=sk-abcdefghijklmnop" }, { model: calls });
    expect(sensitive.error).toBe("sensitive_source"); expect(calls).not.toHaveBeenCalled();
  });

  it("uses same-day now for both query defaults and blocks unknown or future-only keys", async () => {
    const store = db();
    appendTemporalFact(store, { repo: source.repo, event_id: "today", subject: "production", predicate: "hosting_provider", value: "Azure", valid_from: "2026-02-01", observed_at: "2026-02-01", evidence: "evidence" });
    const key = (await import("../src/temporal/intake-contract.js")).stableTemporalKey(source.repo, "production", "hosting_provider");
    const current = await queryTemporalLanguage(store, { repo: source.repo, text: "current host", now: "2026-02-01" }, { model: model({ route: "temporal", key_id: key }) });
    expect(current.result?.as_of).toBe("2026-02-01T00:00:00.000Z"); expect(current.result?.observed_before).toBe("2026-02-01T00:00:00.000Z");
    const unknown = await queryTemporalLanguage(store, { repo: source.repo, text: "unknown", now: "2026-02-01" }, { model: model({ route: "temporal", key_id: "not-listed" }) });
    expect(unknown).toMatchObject({ route: "fallback", error: "unsupported_query" });
    const future = await queryTemporalLanguage(store, { repo: source.repo, text: "future", now: "2026-01-01" }, { model: model({ route: "temporal", key_id: key }) });
    expect(future).toMatchObject({ route: "fallback", error: "unsupported_query" });
  });

  it("rejects ungrounded keys, values, dates, and non-factual clauses before writes", async () => {
    const store = db();
    const text = "Acme hosting provider is Azure on 2026-02-01.";
    const bad = await captureTemporalSource(store, { ...source, event_id: "bad", text }, { model: model({ route: "temporal", facts: [
      temporalFact({ key_id: "unknown-key", subject: undefined, predicate: undefined, quote: text }),
      temporalFact({ value: "A", subject: "acme", predicate: "hosting_provider", quote: text }),
      temporalFact({ subject: "acme", predicate: "hosting_provider", value: "Azure", valid_from: "2025-01-01", quote: text }),
    ] }) });
    expect(bad.stored).toHaveLength(0);
    expect(bad.rejected.map((item) => item.reason)).toEqual(["unknown_key", "value_not_in_source", "missing_temporal_anchor"]);
    const negative = await captureTemporalSource(store, { ...source, event_id: "negative", text: "Acme will use Azure on 2026-02-01." }, { model: model({ route: "temporal", facts: [
      temporalFact({ subject: "acme", predicate: "hosting_provider", value: "Azure", quote: "Acme will use Azure on 2026-02-01." }),
    ] }) });
    expect(negative.rejected).toEqual([{ index: 0, reason: "unsupported_clause" }]);
  });

  it("permits declared semantic predicates, replays only identical sources, and redacts model output", async () => {
    const store = db();
    const text = "Acme ran on Wasabi storage on 2026-02-01.";
    const response = { route: "temporal", facts: [temporalFact({ subject: "acme", predicate: "storage_provider", value: "Wasabi", quote: text })] };
    const calls = model(response);
    const options = { model: calls, predicates: [{ name: "storage_provider", description: "storage provider" }] };
    const first = await captureTemporalSource(store, { ...source, event_id: "replay", text }, options);
    const replay = await captureTemporalSource(store, { ...source, event_id: "replay", text }, { ...options, model: vi.fn(async () => { throw new Error("must not run"); }) });
    expect(first.stored).toHaveLength(1); expect(replay.stored.map((fact) => fact.id)).toEqual(first.stored.map((fact) => fact.id)); expect(calls).toHaveBeenCalledTimes(1);
    const changed = await captureTemporalSource(store, { ...source, event_id: "replay", text: text + " Changed." }, options);
    expect(changed.error).toBe("replay_conflict");
    const raw = await queryTemporalLanguage(store, { repo: source.repo, text: "host", now: "2026-03-01" }, { model: vi.fn(async () => '{"route":"fallback","token":"sk-abcdefghijklmnop"}') });
    expect(raw.raw_output).toContain("[REDACTED]");
    expect(raw.raw_output).not.toContain("abcdefghijklmnop");
  });

  it("does not expose a key at an earlier source cutoff or transmit sensitive query text", async () => {
    const store = db();
    appendTemporalFact(store, { repo: source.repo, event_id: "future-key", subject: "future", predicate: "hosting_provider", value: "Azure", valid_from: "2026-02-02", observed_at: "2026-02-02", evidence: "evidence" });
    const key = (await import("../src/temporal/intake-contract.js")).stableTemporalKey(source.repo, "future", "hosting_provider");
    const cutoff = await queryTemporalLanguage(store, { repo: source.repo, text: "host", now: "2026-03-01" }, { model: model({ route: "temporal", key_id: key, observed_before: "2026-02-01" }) });
    expect(cutoff).toMatchObject({ route: "fallback", error: "unsupported_query" });
    const calls = vi.fn(async () => "{}");
    const sensitive = await queryTemporalLanguage(store, { repo: source.repo, text: "OPENAI_API_KEY=sk-abcdefghijklmnop", now: "2026-03-01" }, { model: calls });
    expect(sensitive.error).toBe("sensitive_source"); expect(calls).not.toHaveBeenCalled();
  });

  it("accepts null for new-key identity without permitting invented keys", async () => {
    const store = db(), text = "Acme uses Azure storage since 2026-02-01.";
    const result = await captureTemporalSource(store, { ...source, text }, {
      predicates: [{ name: "storage_provider", description: "Storage vendor" }],
      model: model({ route: "temporal", facts: [temporalFact({ key_id: null, subject: "acme", predicate: "storage_provider", value: "Azure", quote: text })] }),
    });
    expect(result.stored).toHaveLength(1);
  });

  it("retains surrounding negation and hypothetical context omitted by a model quote", async () => {
    for (const prefix of ["It is not true that ", "If "]) {
      const store = db(), quote = "Acme hosting provider is Azure on 2026-02-01.";
      const result = await captureTemporalSource(store, { ...source, text: prefix + quote }, {
        model: model({ route: "temporal", facts: [temporalFact({ subject: "acme", predicate: "hosting_provider", value: "Azure", quote })] }),
      });
      expect(result.stored).toEqual([]);
      expect(result.rejected[0]?.reason).toBe("unsupported_clause");
    }
  });

  it("does not use unrelated clauses to ground dates or retire an assertion", async () => {
    const store = db();
    const old = appendTemporalFact(store, { repo: source.repo, event_id: "old", subject: "acme", predicate: "hosting_provider", value: "Azure", valid_from: "2026-01-01", observed_at: "2026-01-01", evidence: "old" });
    const text = "Acme hosting provider is Cloudflare on 2026-02-01. Correction: staging spelling was wrong in 2020-01-01.";
    const result = await captureTemporalSource(store, { ...source, text }, {
      model: model({ route: "temporal", facts: [temporalFact({
        subject: "acme", predicate: "hosting_provider", quote: text, supersedes_event_id: "old",
        replacement_quote: "Correction: staging spelling was wrong in 2020-01-01.",
      })] }),
    });
    expect(result.stored).toEqual([]);
    const date = await captureTemporalSource(store, { ...source, event_id: "date", text }, {
      model: model({ route: "temporal", facts: [temporalFact({ subject: "acme", predicate: "hosting_provider", quote: text, valid_from: "2020-01-01" })] }),
    });
    expect(date.stored).toEqual([]);
    expect(queryTemporalFacts(store, { repo: source.repo, subject: "acme", predicate: "hosting_provider", as_of: "2026-03-01", observed_before: "2026-03-01" }).facts[0]?.id).toBe(old.id);
  });

  it("refuses unowned or sensitive rows masquerading as source replay", async () => {
    for (const [event_id, value] of [["foreign", "Azure"], ["s#0", "sk-abcdefghijklmnop"]]) {
      const store = db(), text = "Acme hosting provider is Azure on 2026-02-01.";
      appendTemporalFact(store, { repo: source.repo, event_id, source: "s", subject: "acme", predicate: "hosting_provider", value, valid_from: "2026-02-01", observed_at: source.observed_at, evidence: text });
      const calls = vi.fn(async () => "{}");
      const result = await captureTemporalSource(store, { ...source, text }, { model: calls });
      expect(result).toMatchObject({ route: "defer", error: "replay_conflict", stored: [] });
      expect(calls).not.toHaveBeenCalled();
    }
  });
});

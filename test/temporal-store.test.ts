import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import {
  appendTemporalFact,
  queryTemporalFacts,
  type AppendTemporalFactInput,
} from "../src/temporal/store.js";

let dbNumber = 0;
function freshDb(): RecallDb {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  return initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-temporal-")), `${dbNumber++}.db`));
}

function fact(db: RecallDb, changes: Partial<AppendTemporalFactInput> = {}) {
  return appendTemporalFact(db, {
    repo: "owner/service",
    event_id: `event-${Math.random()}`,
    subject: " Production ",
    predicate: " Hosting   Provider ",
    value: "Azure",
    valid_from: "2026-01-01",
    observed_at: "2026-01-02",
    evidence: "The source said Azure was in use.",
    ...changes,
  });
}

function snapshot(db: RecallDb, as_of: string, observed_before = "2026-12-31") {
  return queryTemporalFacts(db, {
    repo: "owner/service", subject: "PRODUCTION", predicate: "hosting provider", as_of, observed_before,
  });
}

describe("temporal assertion store", () => {
  it("normalizes matching keys but preserves evidence/value and validates strict input", () => {
    const db = freshDb();
    const stored = fact(db, { value: " Azure ", evidence: " Original evidence " });
    expect(stored.subject).toBe("production");
    expect(stored.predicate).toBe("hosting provider");
    expect(stored.value).toBe(" Azure ");
    expect(stored.evidence).toBe(" Original evidence ");
    expect(() => fact(db, { valid_from: "2026-02-30" })).toThrow(/calendar/);
    expect(() => fact(db, { observed_at: "2026-01-02T10:00:00" })).toThrow(/timezone/);
    expect(() => fact(db, { confidence: Number.NaN })).toThrow(/finite/);
    expect(() => fact(db, { valid_to: "2026-01-01" })).toThrow(/after/);
  });

  it("normalizes date-only early years without changing their calendar year", () => {
    const db = freshDb();
    for (const date of ["0000-01-01", "0001-01-01", "0099-01-01"]) {
      const dateOnly = fact(db, { event_id: `date-${date}`, valid_from: date, observed_at: date });
      const timestamp = fact(db, {
        event_id: `timestamp-${date}`,
        valid_from: `${date}T00:00:00Z`,
        observed_at: `${date}T00:00:00Z`,
      });
      expect(dateOnly.valid_from).toBe(`${date}T00:00:00.000Z`);
      expect(dateOnly.valid_from).toBe(timestamp.valid_from);
    }
  });

  it("validates early-year leap dates and rejects UTC year boundary crossings", () => {
    const db = freshDb();
    expect(fact(db, {
      event_id: "year-zero-leap-day", valid_from: "0000-02-29", observed_at: "0000-03-01",
    }).valid_from).toBe("0000-02-29T00:00:00.000Z");
    expect(() => fact(db, { event_id: "year-ninety-nine-leap-day", valid_from: "0099-02-29" })).toThrow(/calendar/);
    expect(() => fact(db, { event_id: "invalid-zero-leap-day", valid_from: "0000-02-30" })).toThrow(/calendar/);
    expect(() => fact(db, { event_id: "before-year-zero", valid_from: "0000-01-01T00:00:00+01:00" })).toThrow(/four-digit UTC year/);
    expect(() => fact(db, { event_id: "after-year-9999", valid_from: "9999-12-31T23:59:59-01:00" })).toThrow(/four-digit UTC year/);
  });

  it("answers effective intervals with an exclusive end and supports history", () => {
    const db = freshDb();
    const old = fact(db, { event_id: "azure", valid_to: "2026-03-01" });
    fact(db, { event_id: "cloudflare", value: "Cloudflare", valid_from: "2026-03-01", observed_at: "2026-03-02" });
    expect(snapshot(db, "2026-02-28").facts.map((row) => row.id)).toEqual([old.id]);
    expect(snapshot(db, "2026-03-01").facts.map((row) => row.value)).toEqual(["Cloudflare"]);
    const history = queryTemporalFacts(db, {
      repo: "owner/service", subject: "production", predicate: "hosting provider",
      mode: "history", observed_before: "2026-12-31",
    });
    expect(history.facts).toHaveLength(2);
    expect(history.conflict).toBe(false);
  });

  it("retains a predecessor until a visible successor becomes effective and never resurrects it", () => {
    const db = freshDb();
    const old = fact(db, { event_id: "old", valid_from: "2026-01-01", observed_at: "2026-01-01" });
    fact(db, {
      event_id: "new", value: "Cloudflare", valid_from: "2026-04-01", valid_to: "2026-05-01",
      observed_at: "2026-02-01", supersedes_id: old.id,
    });
    expect(snapshot(db, "2026-03-01").facts.map((row) => row.value)).toEqual(["Azure"]);
    expect(snapshot(db, "2026-04-15").facts.map((row) => row.value)).toEqual(["Cloudflare"]);
    expect(snapshot(db, "2026-06-01").facts).toEqual([]);
  });

  it("uses observation time as a knowledge cutoff and accepts out-of-order ingestion", () => {
    const db = freshDb();
    const old = fact(db, { event_id: "old", observed_at: "2026-01-02" });
    fact(db, {
      event_id: "late-correction", value: "Cloudflare", valid_from: "2026-02-01",
      observed_at: "2026-04-01", supersedes_id: old.id,
    });
    expect(snapshot(db, "2026-03-01", "2026-03-01").facts.map((row) => row.value)).toEqual(["Azure"]);
    expect(snapshot(db, "2026-03-01", "2026-04-02").facts.map((row) => row.value)).toEqual(["Cloudflare"]);
    expect(() => fact(db, {
      event_id: "impossible", value: "x", valid_from: "2026-01-03", observed_at: "2026-01-01", supersedes_id: old.id,
    })).toThrow(/predate/);
  });

  it("keeps independent assertions ambiguous and calculates conflicts before truncation", () => {
    const db = freshDb();
    fact(db, { event_id: "one", value: "Azure" });
    fact(db, { event_id: "two", value: "Cloudflare", observed_at: "2026-01-03" });
    const result = queryTemporalFacts(db, {
      repo: "owner/service", subject: "production", predicate: "hosting provider",
      as_of: "2026-02-01", observed_before: "2026-12-31", limit: 1,
    });
    expect(result).toMatchObject({ conflict: true, matched_count: 2, truncated: true });
    expect(result.facts).toHaveLength(1);
  });

  it("guards supersession isolation and makes exact replay idempotent", () => {
    const db = freshDb();
    const originalInput: AppendTemporalFactInput = {
      repo: "owner/service", event_id: "replay", subject: "Production", predicate: "hosting provider",
      value: "Azure", valid_from: "2026-01-01", observed_at: "2026-01-02", evidence: "evidence",
    };
    const original = appendTemporalFact(db, originalInput);
    expect(appendTemporalFact(db, originalInput)).toEqual(original);
    expect(() => appendTemporalFact(db, { ...originalInput, value: "AWS" })).toThrow(/different/);
    expect(() => fact(db, { event_id: "foreign", repo: "owner/other", supersedes_id: original.id })).toThrow(/same repo/);
    expect(() => fact(db, { event_id: "wrong-key", predicate: "region", supersedes_id: original.id })).toThrow(/same repo/);
  });

  it("persists assertions after reopening a migrated database", () => {
    process.env.RECALL_EMBEDDINGS_DISABLED = "true";
    const path = join(mkdtempSync(join(tmpdir(), "recall-temporal-reopen-")), "recall.db");
    const first = initStandaloneDb(path);
    const stored = fact(first, { event_id: "persist" });
    first.$client.close();
    const reopened = initStandaloneDb(path);
    expect(snapshot(reopened, "2026-02-01").facts).toEqual([expect.objectContaining({ id: stored.id })]);
    reopened.$client.close();
  });
});

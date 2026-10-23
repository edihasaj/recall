import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import {
  captureUmpTemporalRecord,
  queryUmpTemporalRecords,
  toUmpTemporalDraft,
} from "../src/temporal/ump-v2.js";

let number = 0;
const owner = "did:key:z6MkharnessOwner";
const policies = [
  { name: "favorite_color", description: "A person's directly stated favorite color." },
  { name: "pool_size", description: "A service's directly stated pool size.", value_kind: "integer" as const },
  { name: "home_city", description: "A person's directly stated home city." },
];

function db(): RecallDb {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  return initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-temporal-ump-")), `${number++}.db`));
}

function source(overrides: Partial<{
  repo: string; event_id: string; text: string; observed_at: string;
  speaker_spans: Array<{ start: number; end: number; role: "user" | "assistant"; subject: string }>;
}> = {}) {
  const text = overrides.text ?? "My favorite color is blue.";
  return {
    repo: "owner/project", event_id: "event-1", text, observed_at: "2026-02-01T10:00:00Z",
    speaker_spans: [{ start: 0, end: text.length, role: "user" as const, subject: "ada" }],
    ...overrides,
  };
}

function record(input = source(), overrides: Record<string, unknown> = {}) {
  const proposal = {
    subject: "ada", predicate: "favorite_color", value: "blue", quote: input.text,
    valid_from: "2026-02-01T10:00:00Z", valid_to: null,
    time_basis: "observed" as const, supersedes_event_id: null,
  };
  const draft = toUmpTemporalDraft(input, owner, proposal);
  return { ...draft, ...overrides };
}

async function capture(store: RecallDb, input = source(), value: unknown = record(input)) {
  return captureUmpTemporalRecord(store, value, { owner, source: input, predicates: policies });
}

describe("UMP 1.0 temporal bridge v2", () => {
  it("captures a trusted first-person UMP profile without ordinary memories", async () => {
    const store = db(), input = source();
    const result = await capture(store, input);
    expect(result.stored).toHaveLength(1);
    expect(result.stored[0]).toMatchObject({ subject: "ada", predicate: "favorite_color", value: "blue" });
    expect(store.$client.prepare("select count(*) as count from memories").get()).toEqual({ count: 0 });
    expect(queryUmpTemporalRecords(store, {
      owner, repo: input.repo, subject: "ada", predicate: "favorite_color",
      as_of: "2026-02-01T10:00:00Z", observed_before: "2026-02-02",
    }).facts.map((fact) => fact.value)).toEqual(["blue"]);
  });

  it("preserves exact underscore grounding and uses only context speaker spans", async () => {
    const store = db(), text = "api_gateway pool_size is 12 on 2026-02-01.";
    const input = source({ event_id: "underscore", text, speaker_spans: [] });
    const value = toUmpTemporalDraft(input, owner, {
      subject: "api_gateway", predicate: "pool_size", value: "12", quote: text,
      valid_from: "2026-02-01", valid_to: null, time_basis: "explicit", supersedes_event_id: null,
    });
    expect((await capture(store, input, value)).stored).toHaveLength(1);

    const spoofed = {
      ...record(source({ event_id: "spoof", text: "Ada's favorite color is blue." })),
      body: {
        text: "My favorite color is blue.",
        structured: {
          profile: "recall.temporal.v1", subject: "ada", predicate: "favorite_color", value: "blue",
          quote: "My favorite color is blue.", time_basis: "observed", supersedes_event_id: null,
        },
      },
    };
    expect((await capture(store, source({ event_id: "spoof", text: "Ada's favorite color is blue.", speaker_spans: [] }), spoofed)).error)
      .toBe("quote_not_in_source");
  });

  it("refuses scope, source, time, unsupported envelope fields, negation, uncertainty, and reported ownership", async () => {
    const store = db(), input = source();
    const attempts: Array<[string, unknown]> = [
      ["scope", { ...record(input), scope: { owner, project: "other/project", visibility: "private" } }],
      ["source", { ...record(input), provenance: { actor: owner, actor_kind: "user", method: "source_assertion", source: { ref: "other-event" } } }],
      ["time", { ...record(input), time: { observed: input.observed_at, valid_from: "2026-02-02", valid_to: null } }],
      ["consent", { ...record(input), consent: { exportable: false } }],
      ["relations", { ...record(input), relations: [] }],
    ];
    for (const [, value] of attempts) expect((await capture(store, input, value)).route).toBe("defer");

    for (const [event_id, text] of [
      ["negated", "It is not true that Ada favorite color is blue."],
      ["uncertain", "Ada favorite color is blue, but I might be wrong."],
      ["reported", "John said 'My favorite color is blue.'"],
    ]) {
      const item = source({ event_id, text, speaker_spans: [{ start: 0, end: text.length, role: "user", subject: "ada" }] });
      const proposal = {
        subject: "ada", predicate: "favorite_color", value: "blue",
        quote: event_id === "reported" ? "My favorite color is blue." : text,
        valid_from: item.observed_at, valid_to: null, time_basis: "observed" as const, supersedes_event_id: null,
      };
      expect((await capture(store, item, toUmpTemporalDraft(item, owner, proposal))).stored).toEqual([]);
    }
  });

  it("binds structured payloads on replay and isolates equivalent source IDs by owner", async () => {
    const store = db(), input = source();
    const first = await capture(store, input);
    expect((await capture(store, input)).stored.map((fact) => fact.id)).toEqual(first.stored.map((fact) => fact.id));

    const changedValue = record(input);
    (changedValue.body.structured as Record<string, unknown>).value = "red";
    expect((await capture(store, input, changedValue)).error).toBe("replay_conflict");
    const changedDate = record(input);
    changedDate.time!.valid_from = "2026-02-02T00:00:00.000Z";
    expect((await capture(store, input, changedDate)).route).toBe("defer");
    const changedTimeBasis = record(input);
    changedTimeBasis.time!.valid_from = "2026-02-02T00:00:00.000Z";
    (changedTimeBasis.body.structured as Record<string, unknown>).time_basis = "explicit";
    expect((await capture(store, input, changedTimeBasis)).error).toBe("replay_conflict");
    const invalidDateOnly = record(input);
    invalidDateOnly.time!.valid_from = "2026-02-02";
    (invalidDateOnly.body.structured as Record<string, unknown>).time_basis = "explicit";
    expect((await capture(store, input, invalidDateOnly)).error).toBe("invalid_ump_record");
    const changedSubject = record(input);
    (changedSubject.body.structured as Record<string, unknown>).subject = "bea";
    expect((await capture(store, input, changedSubject)).error).toBe("replay_conflict");

    const quotedText = "Ada favorite color is blue on 2026-02-01. The recorded color is blue.";
    const quoted = source({ event_id: "quoted", text: quotedText, speaker_spans: [] });
    const firstQuote = "Ada favorite color is blue on 2026-02-01.";
    const quoteRecord = toUmpTemporalDraft(quoted, owner, {
      subject: "ada", predicate: "favorite_color", value: "blue", quote: firstQuote,
      valid_from: "2026-02-01", valid_to: null, time_basis: "explicit", supersedes_event_id: null,
    });
    expect((await capture(store, quoted, quoteRecord)).stored).toHaveLength(1);
    (quoteRecord.body.structured as Record<string, unknown>).quote = "The recorded color is blue.";
    quoteRecord.body.text = "The recorded color is blue.";
    expect((await capture(store, quoted, quoteRecord)).error).toBe("replay_conflict");

    const otherOwner = "did:key:z6MkharnessOther";
    const other = await captureUmpTemporalRecord(store, record(input), {
      owner: otherOwner,
      source: input,
      predicates: policies,
    });
    expect(other.error).toBe("scope_mismatch");
    const otherRecord = toUmpTemporalDraft(input, otherOwner, {
      subject: "ada", predicate: "favorite_color", value: "blue", quote: input.text,
      valid_from: input.observed_at, valid_to: null, time_basis: "observed", supersedes_event_id: null,
    });
    expect((await captureUmpTemporalRecord(store, otherRecord, {
      owner: otherOwner, source: input, predicates: policies,
    })).stored).toHaveLength(1);
  });

  it("keeps an explicit predecessor visible until its late correction is observed", async () => {
    const store = db();
    const oldText = "Ada favorite color is blue on 2026-01-01.";
    const old = source({ event_id: "old", text: oldText, observed_at: "2026-01-02", speaker_spans: [] });
    const oldRecord = toUmpTemporalDraft(old, owner, {
      subject: "ada", predicate: "favorite_color", value: "blue", quote: oldText,
      valid_from: "2026-01-01", valid_to: null, time_basis: "explicit", supersedes_event_id: null,
    });
    expect((await capture(store, old, oldRecord)).stored).toHaveLength(1);

    const changeText = "Correction: Ada favorite color changed from blue to red on 2026-02-01, replacing old.";
    const change = source({ event_id: "change", text: changeText, observed_at: "2026-03-01", speaker_spans: [] });
    const changed = toUmpTemporalDraft(change, owner, {
      subject: "ada", predicate: "favorite_color", value: "red", quote: changeText,
      valid_from: "2026-02-01", valid_to: null, time_basis: "explicit", supersedes_event_id: "old",
      replacement_quote: changeText,
    });
    expect((await capture(store, change, changed)).stored).toHaveLength(1);
    const changedReplacement = structuredClone(changed);
    (changedReplacement.body.structured as Record<string, unknown>).replacement_quote = "replacing old";
    expect((await capture(store, change, changedReplacement)).error).toBe("replay_conflict");
    const historical = queryUmpTemporalRecords(store, {
      owner, repo: old.repo, subject: "ada", predicate: "favorite_color",
      as_of: "2026-02-15", observed_before: "2026-02-15",
    });
    const corrected = queryUmpTemporalRecords(store, {
      owner, repo: old.repo, subject: "ada", predicate: "favorite_color",
      as_of: "2026-02-15", observed_before: "2026-03-02", mode: "history",
    });
    expect(historical.facts.map((fact) => fact.value)).toEqual(["blue"]);
    expect(corrected.facts.map((fact) => fact.value)).toEqual(["blue", "red"]);
  });

  it("copies same-instant predecessor history in dependency order and rejects span extras", async () => {
    const store = db();
    const oldText = "Ada favorite color is blue on 2026-02-01.";
    const old = source({ event_id: "same-time-old", text: oldText, observed_at: "2026-04-01", speaker_spans: [] });
    expect((await capture(store, old, toUmpTemporalDraft(old, owner, {
      subject: "ada", predicate: "favorite_color", value: "blue", quote: oldText,
      valid_from: "2026-02-01", valid_to: null, time_basis: "explicit", supersedes_event_id: null,
    }))).stored).toHaveLength(1);

    const correctionText = "Correction: Ada favorite color changed from blue to red on 2026-01-01, replacing same-time-old.";
    const correction = source({ event_id: "same-time-red", text: correctionText, observed_at: "2026-04-01T00:00:00Z", speaker_spans: [] });
    expect((await capture(store, correction, toUmpTemporalDraft(correction, owner, {
      subject: "ada", predicate: "favorite_color", value: "red", quote: correctionText,
      valid_from: "2026-01-01", valid_to: null, time_basis: "explicit", supersedes_event_id: "same-time-old",
      replacement_quote: correctionText,
    }))).stored).toHaveLength(1);

    const greenText = "Ada favorite color is green on 2026-03-01.";
    const green = source({ event_id: "same-time-green", text: greenText, observed_at: "2026-04-01T02:00:00+02:00", speaker_spans: [] });
    expect((await capture(store, green, toUmpTemporalDraft(green, owner, {
      subject: "ada", predicate: "favorite_color", value: "green", quote: greenText,
      valid_from: "2026-03-01", valid_to: null, time_basis: "explicit", supersedes_event_id: null,
    }))).stored).toHaveLength(1);

    const unsafeBase = source();
    const unsafe = {
      ...unsafeBase,
      speaker_spans: [{ ...unsafeBase.speaker_spans[0]!, extra: "OPENAI_API_KEY=dummy-not-a-real-secret" }],
    };
    expect((await capture(store, unsafe)).error).toBe("invalid_ump_record");
  });

  it("makes identical concurrent source capture idempotent", async () => {
    const store = db(), input = source({ event_id: "concurrent" }), draft = record(input);
    const [left, right] = await Promise.all([capture(store, input, draft), capture(store, input, draft)]);
    expect(left.error).toBeNull();
    expect(right.error).toBeNull();
    expect(left.stored.map((fact) => fact.id)).toEqual(right.stored.map((fact) => fact.id));
  });
});

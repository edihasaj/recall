import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateExpandedDataset } from "../benchmark/temporal-expanded-fixtures.js";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import { appendTemporalFact, queryTemporalFacts } from "../src/temporal/store.js";

function freshDb(): RecallDb {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  return initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-expanded-")), "fixtures.db"));
}

function seed(db: RecallDb, events: ReturnType<typeof generateExpandedDataset>["events"]) {
  const ids = new Map<string, string>();
  let pending = [...events];
  while (pending.length) {
    const ready = pending.filter((event) => !event.supersedes_event_id || ids.has(`${event.repo}\u0000${event.supersedes_event_id}`));
    if (!ready.length) throw new Error("fixture contains an unresolved replacement link");
    for (const event of ready) {
      const supersedes_id = event.supersedes_event_id ? ids.get(`${event.repo}\u0000${event.supersedes_event_id}`) : undefined;
      const stored = appendTemporalFact(db, { ...event, supersedes_id });
      ids.set(`${event.repo}\u0000${event.event_id}`, stored.id);
    }
    pending = pending.filter((event) => !ready.includes(event));
  }
}

describe("expanded temporal fixtures", () => {
  it("is deterministic while varying fresh names and dates by seed", () => {
    expect(generateExpandedDataset()).toEqual(generateExpandedDataset());
    const changed = generateExpandedDataset(7);
    const original = generateExpandedDataset();
    expect(changed.events.map((event) => event.repo)).not.toEqual(original.events.map((event) => event.repo));
    expect(changed.events.map((event) => event.valid_from)).not.toEqual(original.events.map((event) => event.valid_from));
  });

  it("makes forty worlds, eighty questions, ten families, and both strata by default", () => {
    const data = generateExpandedDataset();
    expect(new Set(data.questions.map((question) => question.world_id)).size).toBe(40);
    expect(data.questions).toHaveLength(80);
    expect(new Set(data.questions.map((question) => question.world_id.split("-").slice(0, -1).join("-"))).size).toBe(10);
    expect(new Set(data.questions.map((question) => question.stratum))).toEqual(new Set(["clean", "noise"]));
    const categories = new Set(data.questions.map((question) => question.category));
    expect(categories).not.toContain("");
    expect(categories.size).toBe(10);
  });

  it("keeps source references local, permits cross-repository event ids, and authors viable gold", () => {
    const data = generateExpandedDataset();
    const unique = new Set(data.events.map((event) => `${event.repo}\u0000${event.event_id}`));
    expect(unique.size).toBe(data.events.length);
    for (const event of data.events) {
      if (event.supersedes_event_id) expect(unique.has(`${event.repo}\u0000${event.supersedes_event_id}`)).toBe(true);
      expect(event.confidence).toBeGreaterThanOrEqual(0);
      expect(event.confidence).toBeLessThanOrEqual(1);
      expect(event.evidence, event.event_id).toContain(event.value);
    }
    expect(data.events.filter((event) => event.event_id.includes("shared-record"))).toHaveLength(8);
    for (const question of data.questions) for (const id of question.expected_event_ids) expect(unique.has(`${question.repo}\u0000${id}`)).toBe(true);
    expect(data.questions.some((question) => question.expected_values.length === 0)).toBe(true);
    expect(data.questions.some((question) => question.expected_conflict)).toBe(true);
    expect(data.questions.some((question) => question.category === "static preference control")).toBe(true);
    expect(data.questions.every((question) => !/(before any valid source|unrecorded|absent|with both independent reports visible)/i.test(question.question))).toBe(true);
  });

  it("keeps static controls static and isolates noise in every queried repository", () => {
    const data = generateExpandedDataset();
    const staticWorlds = new Set(data.questions.filter((question) => question.category === "static preference control").map((question) => question.world_id));
    for (const worldId of staticWorlds) {
      const questions = data.questions.filter((question) => question.world_id === worldId);
      const targetEvents = data.events.filter((event) => event.event_id.startsWith(`${worldId}-record-`));
      expect(targetEvents).toHaveLength(1);
      expect(new Set(questions.map((question) => question.expected_values.join("\u0000")))).toEqual(new Set([targetEvents[0]!.value]));
      expect(new Set(questions.map((question) => question.expected_event_ids.join("\u0000")))).toEqual(new Set([targetEvents[0]!.event_id]));
      expect(new Set(questions.map((question) => question.as_of)).size).toBe(2);
      expect(questions.every((question) => question.observed_before >= targetEvents[0]!.observed_at)).toBe(true);
    }

    const noiseIsolationWorlds = new Set(data.questions.filter((question) => question.category === "repo isolation" && question.stratum === "noise").map((question) => question.world_id));
    for (const worldId of noiseIsolationWorlds) {
      const repos = new Set(data.questions.filter((question) => question.world_id === worldId).map((question) => question.repo));
      for (const repo of repos) {
        expect(data.events.filter((event) => event.repo === repo && event.event_id.includes("-context-")).length).toBe(10);
      }
    }
  });

  it("matches every hand-authored gold answer in the store", () => {
    const data = generateExpandedDataset();
    const db = freshDb();
    seed(db, data.events);
    for (const question of data.questions) {
      const result = queryTemporalFacts(db, question);
      expect(result.facts.map((fact) => fact.value).sort(), question.id).toEqual(question.expected_values);
      expect(result.facts.map((fact) => fact.event_id).sort(), question.id).toEqual(question.expected_event_ids);
      expect(result.conflict, question.id).toBe(question.expected_conflict);
    }
    db.$client.close();
  });

  it("deterministically checks five hundred generated worlds and one thousand queries against the same authored gold", () => {
    const data = generateExpandedDataset(20261019, 50);
    expect(data).toEqual(generateExpandedDataset(20261019, 50));
    expect(new Set(data.questions.map((question) => question.world_id)).size).toBe(500);
    expect(data.questions).toHaveLength(1000);
    const db = freshDb();
    seed(db, data.events);
    for (const question of data.questions) {
      const result = queryTemporalFacts(db, question);
      expect(result.facts.map((fact) => fact.value).sort(), question.id).toEqual(question.expected_values);
      expect(result.conflict, question.id).toBe(question.expected_conflict);
    }
    db.$client.close();
  });
});

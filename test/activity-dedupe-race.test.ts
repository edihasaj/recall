import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, initStandaloneDb } from "../src/db/client.js";
import { createActivityEvent, listActivityEvents } from "../src/models/activity.js";
import {
  ACTIVITY_DEDUPE_PREFIX,
  HOOK_DEDUPE_PREFIX,
  activityEventDedupeKey,
  hookCallDedupeKey,
} from "../src/models/dedupe.js";
import { activityEvents } from "../src/db/schema.js";

afterEach(() => {
  closeDb();
  delete process.env.RECALL_EMBEDDINGS_DISABLED;
});

function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-dedupe-race-"));
  return initStandaloneDb(join(dir, "test.db"));
}

describe("createActivityEvent dedupe race", () => {
  const input = {
    session_id: "sess-race-1",
    repo: "edihasaj/recall",
    source: "hook:claude-code" as const,
    event_type: "tool_call" as const,
    request: { name: "Edit" },
    result: { ok: true },
  };

  it("stores fixed-size hashes instead of request and result payloads", () => {
    const activity = activityEventDedupeKey({
      ...input,
      request: { prompt: "x".repeat(10_000) },
    });
    const hook = hookCallDedupeKey({
      session_id: input.session_id,
      agent: "codex",
      event: "prompt_submitted",
      ok: true,
      payload: { prompt: "x".repeat(10_000) },
    });

    expect(activity).toMatch(new RegExp(`^${ACTIVITY_DEDUPE_PREFIX}[a-f0-9]{64}$`));
    expect(hook).toMatch(new RegExp(`^${HOOK_DEDUPE_PREFIX}[a-f0-9]{64}$`));
    expect(activity).toHaveLength(ACTIVITY_DEDUPE_PREFIX.length + 64);
    expect(hook).toHaveLength(HOOK_DEDUPE_PREFIX.length + 64);
  });

  it("returns the same id for repeated calls with the same dedupe key", () => {
    const db = freshDb();
    const id1 = createActivityEvent(db, input);
    const id2 = createActivityEvent(db, input);
    const id3 = createActivityEvent(db, input);

    expect(id2).toBe(id1);
    expect(id3).toBe(id1);
    expect(listActivityEvents(db, { session_id: input.session_id })).toHaveLength(1);
  });

  it("survives a concurrent insert that wins the race on dedupe_key", () => {
    const db = freshDb();
    const dedupeKey = activityEventDedupeKey(input)!;

    db.insert(activityEvents)
      .values({
        id: "preexisting-id",
        session_id: input.session_id,
        repo: input.repo,
        path: null,
        source: input.source,
        event_type: input.event_type,
        memory_ids: [],
        dedupe_key: dedupeKey,
        request: input.request,
        result: input.result,
        created_at: new Date().toISOString(),
      })
      .onConflictDoNothing({ target: activityEvents.dedupe_key })
      .run();

    expect(() => createActivityEvent(db, input)).not.toThrow();
    expect(createActivityEvent(db, input)).toBe("preexisting-id");
    expect(listActivityEvents(db, { session_id: input.session_id })).toHaveLength(1);
  });
});

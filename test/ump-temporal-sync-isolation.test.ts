import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initStandaloneDb } from "../src/db/client.js";
import { getMemory, createMemory } from "../src/models/memory.js";
import { bumpSyncVersion, pullMemories, pushMemories } from "../src/sync/client.js";

const config = {
  remote_url: "https://sync.example.com",
  api_key: "test-key",
  team_id: "team-1",
};

let sequence = 0;

function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  return initStandaloneDb(join(
    mkdtempSync(join(tmpdir(), "recall-ump-sync-")),
    `sync-${sequence++}.db`,
  ));
}

function createUmpSource(db: ReturnType<typeof freshDb>, text = "UMP source assertion"): string {
  return createMemory(db, {
    type: "decision",
    text,
    scope: "repo",
    repo: "owner/service",
    source: "user_correction",
    confidence: 0.9,
    auto_inject: false,
    capture_context: { ump_record: null as never },
  });
}

function createOrdinaryMemory(db: ReturnType<typeof freshDb>, text = "ordinary memory"): string {
  return createMemory(db, {
    type: "rule",
    text,
    scope: "repo",
    repo: "owner/service",
    source: "user_correction",
    confidence: 0.9,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("UMP temporal sync isolation", () => {
  it("does not call Cloud for UMP-only changes and advances the local cursor", async () => {
    const db = freshDb();
    const id = createUmpSource(db);
    bumpSyncVersion(db, id);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(pushMemories(db, config)).resolves.toEqual({ pushed: 0, version: 1 });
      expect(fetchMock).not.toHaveBeenCalled();
      const state = db.$client
        .prepare("select last_push_version from sync_state where id = 'local'")
        .get() as { last_push_version: number };
      expect(state.last_push_version).toBe(1);
      await expect(pushMemories(db, config)).resolves.toEqual({ pushed: 0, version: 1 });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      db.$client.close();
    }
  });

  it("pushes only ordinary memories when UMP and ordinary rows change together", async () => {
    const db = freshDb();
    const umpId = createUmpSource(db);
    const ordinaryId = createOrdinaryMemory(db);
    bumpSyncVersion(db, umpId);
    bumpSyncVersion(db, ordinaryId);
    bumpSyncVersion(db, ordinaryId);
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ pushed: 1, version: 8 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(pushMemories(db, config)).resolves.toEqual({ pushed: 1, version: 8 });
      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0].origin_id).toBe(ordinaryId);
      expect(body.memories[0].capture_context).toBeNull();
      expect(body.memories.map((memory: { origin_id: string }) => memory.origin_id)).not.toContain(umpId);
      const state = db.$client
        .prepare("select last_push_version from sync_state where id = 'local'")
        .get() as { last_push_version: number };
      expect(state.last_push_version).toBe(2);
    } finally {
      db.$client.close();
    }
  });

  it("keeps local UMP sources unchanged while pulling ordinary updates", async () => {
    const db = freshDb();
    const umpId = createUmpSource(db, "local UMP source");
    const ordinaryId = createOrdinaryMemory(db, "local ordinary memory");
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        version: 17,
        memories: [
          {
            origin_id: umpId,
            text: "remote must not overwrite source",
            status: "active",
            confidence: 1,
            evidence: [],
            updated_at: "2099-01-01T00:00:00.000Z",
          },
          {
            origin_id: ordinaryId,
            text: "remote ordinary update",
            status: "candidate",
            confidence: 0.7,
            evidence: [],
            updated_at: "2099-01-01T00:00:00.000Z",
          },
          {
            origin_id: "remote-ump-source",
            capture_context: { ump_record: null },
            text: "incoming UMP source",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(pullMemories(db, config)).resolves.toEqual({ pulled: 1, conflicts: 1 });
      expect(getMemory(db, umpId)?.text).toBe("local UMP source");
      expect(getMemory(db, umpId)?.capture_context).toHaveProperty("ump_record");
      expect(getMemory(db, ordinaryId)?.text).toBe("remote ordinary update");
      expect(getMemory(db, "remote-ump-source")).toBeUndefined();
      const state = db.$client
        .prepare("select last_pull_version from sync_state where id = 'local'")
        .get() as { last_pull_version: number };
      expect(state.last_pull_version).toBe(17);
    } finally {
      db.$client.close();
    }
  });
});

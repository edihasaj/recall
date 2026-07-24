/**
 * Sync client — pushes/pulls memories to/from a remote sync server.
 * Handles conflict resolution (last-write-wins by updated_at).
 */

import { eq, gt } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { memories, syncState } from "../db/schema.js";
import { queueMemoryEmbeddingSync } from "../embeddings/embeddings.js";
import type { SyncConfig, SyncResult, MemoryItem } from "../types.js";
import { normalizeSyncRemoteUrl } from "../security/outbound-url.js";

const SYNC_REQUEST_TIMEOUT_MS = 30_000;

function syncRequestInit(init: RequestInit): RequestInit {
  return {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(SYNC_REQUEST_TIMEOUT_MS),
  };
}

// --- Sync state helpers ---

interface SyncStateRow {
  id: string;
  remote_url: string | null;
  team_id: string | null;
  last_push_at: string | null;
  last_pull_at: string | null;
  last_push_version: number;
  last_pull_version: number;
}

function getSyncState(db: RecallDb): SyncStateRow {
  const row = db.select().from(syncState).where(eq(syncState.id, "local")).get();
  if (row) return row;
  // Initialize
  db.insert(syncState)
    .values({
      id: "local",
      remote_url: null,
      team_id: null,
      last_push_at: null,
      last_pull_at: null,
      last_push_version: 0,
      last_pull_version: 0,
    })
    .run();
  return db.select().from(syncState).where(eq(syncState.id, "local")).get()!;
}

function updateSyncState(
  db: RecallDb,
  updates: Partial<Omit<SyncStateRow, "id">>,
) {
  db.update(syncState)
    .set(updates)
    .where(eq(syncState.id, "local"))
    .run();
}

// --- Push ---

export async function pushMemories(
  db: RecallDb,
  config: SyncConfig,
): Promise<{ pushed: number; version: number }> {
  const state = getSyncState(db);
  const remoteUrl = normalizeSyncRemoteUrl(config.remote_url);

  // Get locally modified memories since last push
  const localMemories = db
    .select()
    .from(memories)
    .where(gt(memories.sync_version, state.last_push_version))
    .all();

  if (localMemories.length === 0) {
    return { pushed: 0, version: state.last_push_version };
  }

  const payload = localMemories.map((m) => ({
    ...m,
    origin_id: m.id,
    evidence: typeof m.evidence === "string" ? JSON.parse(m.evidence as string) : m.evidence,
  }));

  const resp = await fetch(`${remoteUrl}/api/push`, syncRequestInit({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.api_key}`,
    },
    body: JSON.stringify({
      team_id: config.team_id,
      memories: payload,
    }),
  }));

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(`Push failed: ${(err as any).error ?? resp.statusText}`);
  }

  const result = (await resp.json()) as { pushed: number; version: number };

  updateSyncState(db, {
    remote_url: remoteUrl,
    team_id: config.team_id,
    last_push_at: new Date().toISOString(),
    last_push_version: Math.max(
      ...localMemories.map((m) => m.sync_version),
    ),
  });

  return result;
}

// --- Pull ---

export async function pullMemories(
  db: RecallDb,
  config: SyncConfig,
): Promise<{ pulled: number; conflicts: number }> {
  const state = getSyncState(db);
  const remoteUrl = normalizeSyncRemoteUrl(config.remote_url);

  const resp = await fetch(`${remoteUrl}/api/pull`, syncRequestInit({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.api_key}`,
    },
    body: JSON.stringify({
      team_id: config.team_id,
      since_version: state.last_pull_version,
    }),
  }));

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(`Pull failed: ${(err as any).error ?? resp.statusText}`);
  }

  const data = (await resp.json()) as {
    memories: any[];
    version: number;
  };

  let pulled = 0;
  let conflicts = 0;

  for (const remote of data.memories) {
    const localMem = db
      .select()
      .from(memories)
      .where(eq(memories.id, remote.origin_id))
      .get();

    if (localMem) {
      // Conflict resolution: last-write-wins by updated_at
      if (remote.updated_at > localMem.updated_at) {
        db.update(memories)
          .set({
            text: remote.text,
            status: remote.status,
            confidence: remote.confidence,
            evidence: remote.evidence,
            updated_at: remote.updated_at,
            team_id: config.team_id,
          })
          .where(eq(memories.id, localMem.id))
          .run();
        queueMemoryEmbeddingSync(db, localMem.id);
        pulled++;
        conflicts++;
      }
    } else {
      // New memory from team
      const memoryId = remote.origin_id ?? randomUUID();
      db.insert(memories)
        .values({
          id: memoryId,
          type: remote.type,
          text: remote.text,
          scope: remote.scope,
          path_scope: remote.path_scope,
          repo: remote.repo,
          status: remote.status,
          confidence: remote.confidence,
          source: remote.source,
          evidence: remote.evidence,
          supersedes: remote.supersedes,
          created_at: remote.created_at,
          updated_at: remote.updated_at,
          team_id: config.team_id,
          sync_version: 0,
        })
        .run();
      queueMemoryEmbeddingSync(db, memoryId);
      pulled++;
    }
  }

  updateSyncState(db, {
    last_pull_at: new Date().toISOString(),
    last_pull_version: data.version,
  });

  return { pulled, conflicts };
}

// --- Full sync ---

export async function sync(
  db: RecallDb,
  config: SyncConfig,
): Promise<SyncResult> {
  const errors: string[] = [];
  let pushed = 0;
  let pulled = 0;
  let conflicts = 0;

  try {
    const pushResult = await pushMemories(db, config);
    pushed = pushResult.pushed;
  } catch (err: any) {
    errors.push(`push: ${err.message}`);
  }

  try {
    const pullResult = await pullMemories(db, config);
    pulled = pullResult.pulled;
    conflicts = pullResult.conflicts;
  } catch (err: any) {
    errors.push(`pull: ${err.message}`);
  }

  return { pushed, pulled, conflicts, errors };
}

// --- Team helpers ---

export async function createTeam(
  config: Pick<SyncConfig, "remote_url" | "api_key">,
  name: string,
): Promise<string> {
  const remoteUrl = normalizeSyncRemoteUrl(config.remote_url);
  const resp = await fetch(`${remoteUrl}/api/team`, syncRequestInit({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.api_key}`,
    },
    body: JSON.stringify({ name }),
  }));

  if (!resp.ok) throw new Error(`Failed to create team: ${resp.statusText}`);
  const data = (await resp.json()) as { team_id: string };
  return data.team_id;
}

export async function joinTeam(
  config: Pick<SyncConfig, "remote_url" | "api_key">,
  teamId: string,
): Promise<void> {
  const remoteUrl = normalizeSyncRemoteUrl(config.remote_url);
  const resp = await fetch(
    `${remoteUrl}/api/team/${encodeURIComponent(teamId)}/join`,
    syncRequestInit({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.api_key}`,
      },
    }),
  );

  if (!resp.ok) throw new Error(`Failed to join team: ${resp.statusText}`);
}

// --- Bump sync version on local changes ---

export function bumpSyncVersion(db: RecallDb, memoryId: string) {
  const mem = db.select().from(memories).where(eq(memories.id, memoryId)).get();
  if (!mem) return;
  db.update(memories)
    .set({ sync_version: mem.sync_version + 1 })
    .where(eq(memories.id, memoryId))
    .run();
}

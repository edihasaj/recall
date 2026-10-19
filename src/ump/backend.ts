/**
 * Recall backend for the Universal Memory Protocol adapter.
 *
 * Direct UMP records retain their complete protocol representation in capture
 * context. Recall's ordinary columns stay in sync for FTS/vector retrieval,
 * but are never allowed to discard temporal, scope, provenance, or relation
 * fields.
 */

import { eq } from "drizzle-orm";
import type { MemoryRecord, RecallRequest } from "@universalmemoryprotocol/core";
import {
  fromAmpId,
  kindToRecallType,
  recallMemoryToRecord,
  toUmpId,
  type RecallBackend,
  type RecallMemory,
} from "@universalmemoryprotocol/core/adapters/recall";
import type { RecallDb } from "../db/client.js";
import { memories } from "../db/schema.js";
import {
  createMemory,
  getMemory,
  queryMemories,
  rejectMemory,
} from "../models/memory.js";
import {
  flushEmbeddingJobs,
  loadEmbeddingConfigFromEnv,
  semanticSearch,
} from "../embeddings/embeddings.js";
import { searchMemoryFtsIndex } from "../vector/sqlite-fts.js";
import { processCorrection } from "../capture/correction.js";
import type { CaptureContext, MemoryItem, MemoryScope } from "../types.js";
import {
  canonicalizeStoredRecord,
  storedUmpRecord,
} from "./records.js";

const SEARCH_MIN_SIM = parseFloat(process.env.UMP_RECALL_MIN_SIM ?? "0.3");
const RRF_K = 60;

type UmpCompileRequest = Parameters<RecallBackend["compileHybrid"]>[0];

function toRecallMemory(m: MemoryItem): RecallMemory {
  return {
    id: m.id,
    text: m.text,
    type: m.type,
    scope: m.scope,
    status: m.status,
    confidence: m.confidence,
    repo: m.repo,
    path: m.path_scope,
    source: m.source,
    supersedes: m.supersedes,
    created_at: m.created_at,
    updated_at: m.updated_at,
    last_validated_at: m.last_validated_at,
    evidence: m.evidence?.map((e) => ({
      ref: (e as { ref?: string }).ref,
      context: (e as { context?: string }).context,
    })),
    capture_context: m.capture_context ?? null,
  };
}

function tokenOverlap(query: string, text: string): number {
  const queryTokens = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
  if (queryTokens.size === 0) return 0;
  const candidate = text.toLowerCase();
  let hits = 0;
  for (const word of queryTokens) if (candidate.includes(word)) hits++;
  return hits / queryTokens.size;
}

function statusForNative(memory: MemoryItem): "active" | "candidate" | "tombstoned" {
  // A manual/native rejection must always win over an older UMP active status.
  if (memory.status === "rejected") return "tombstoned";
  const saved = storedUmpRecord(memory.capture_context?.ump_record);
  if (saved?.lifecycle?.status === "tombstoned") return "tombstoned";
  return memory.status === "active" ? "active" : "candidate";
}

function recordForMemory(memory: MemoryItem, owner: string): MemoryRecord {
  const saved = storedUmpRecord(memory.capture_context?.ump_record);
  if (saved) {
    return {
      ...saved,
      id: toUmpId(memory.id),
      integrity: undefined,
      lifecycle: {
        ...saved.lifecycle,
        status: statusForNative(memory),
      },
    };
  }
  // Legacy Recall rows retain the SDK's native mapping.
  return recallMemoryToRecord(toRecallMemory(memory), owner);
}

function matchesScope(
  record: MemoryRecord,
  requested?: Partial<MemoryRecord["scope"]>,
): boolean {
  if (!requested) return true;
  return (Object.keys(requested) as Array<keyof MemoryRecord["scope"]>)
    .every((key) => requested[key] === undefined || record.scope[key] === requested[key]);
}

function matchesFilter(record: MemoryRecord, filter?: RecallRequest["filter"]): boolean {
  if (!filter) return true;
  const status = record.lifecycle?.status ?? "active";
  if (filter.status && !filter.status.includes(status)) return false;
  if (filter.kind && !filter.kind.includes(record.kind)) return false;
  if (filter.valid_at) {
    const at = Date.parse(filter.valid_at);
    const from = Date.parse(record.time.valid_from ?? record.time.created);
    const to = record.time.valid_to == null ? Number.POSITIVE_INFINITY : Date.parse(record.time.valid_to);
    // UMP validates API timestamps. Invalid persisted legacy data is excluded.
    if (!Number.isFinite(at) || !Number.isFinite(from) || Number.isNaN(to)) return false;
    if (at < from || at > to) return false;
  }
  return true;
}

function candidateMatches(
  memory: MemoryItem,
  owner: string,
  request: UmpCompileRequest,
): boolean {
  const record = recordForMemory(memory, owner);
  if (statusForNative(memory) === "tombstoned") return false;
  // A Recall UMP server serves one persisted operator identity. A record for
  // another owner must not become searchable just because it shares a project.
  if (record.scope.owner !== owner) return false;
  return matchesScope(record, request.scope) && matchesFilter(record, request.filter);
}

function asTemporalScope(record: MemoryRecord): {
  scope: MemoryScope;
  repo: string | null;
  path: string | null;
} {
  if (record.scope.project) {
    return { scope: "repo", repo: record.scope.project, path: null };
  }
  return { scope: "global", repo: null, path: null };
}

function confidenceFor(record: MemoryRecord): number {
  const confidence = record.lifecycle?.confidence ?? 0.8;
  return record.lifecycle?.status === "candidate"
    ? Math.min(confidence, 0.59)
    : Math.max(confidence, 0.6);
}

function captureContextFor(
  record: MemoryRecord,
  canonicalId: string,
  previous: MemoryItem | undefined,
): CaptureContext {
  const prior = storedUmpRecord(previous?.capture_context?.ump_record);
  return {
    ...(previous?.capture_context ?? {}),
    ump_kind: record.kind,
    ump_record: canonicalizeStoredRecord(record, canonicalId, prior),
  };
}

function putUmpRecord(
  db: RecallDb,
  record: MemoryRecord,
  existingId?: string,
): string {
  const targetId = existingId ?? (
    record.id.startsWith("urn:ump:") ? safeRecallId(record.id) : undefined
  );
  const existing = targetId ? getMemory(db, targetId) : undefined;

  if (existing) {
    const captureContext = captureContextFor(record, toUmpId(existing.id), existing);
    const scope = asTemporalScope(record);
    const tombstoned = record.lifecycle?.status === "tombstoned";
    const nativeStatus = existing.status === "rejected"
      ? "rejected"
      : record.lifecycle?.status === "candidate"
        ? "candidate"
        : "active";

    db.update(memories)
      .set({
        text: record.body.text,
        type: kindToRecallType(record.kind),
        scope: scope.scope,
        repo: scope.repo,
        path_scope: scope.path,
        confidence: confidenceFor(record),
        status: nativeStatus,
        capture_context: captureContext as never,
        // A UMP record can carry validity, source, and structured semantics
        // that the instruction compiler does not understand. Keep all direct
        // UMP writes out of automatic instructions until that path is proven.
        auto_inject: false,
        updated_at: new Date().toISOString(),
      })
      .where(eq(memories.id, existing.id))
      .run();

    // Supersession only closes the UMP interval. It must not reject the prior:
    // historical recalls still need that predecessor. Forget is tombstoning.
    if (tombstoned && existing.status !== "rejected") {
      rejectMemory(db, existing.id, "ump");
    }
    return existing.id;
  }

  const scope = asTemporalScope(record);
  const id = db.$client.transaction(() => {
    // Store a complete source marker in the INSERT itself. If canonical-id
    // finalization ever fails, a crash cannot leave an active ordinary row
    // eligible for query-time instruction reinjection.
    const initialContext: CaptureContext = {
      ump_kind: record.kind,
      ump_record: canonicalizeStoredRecord(record, record.id, undefined),
    };
    const createdId = createMemory(db, {
      type: kindToRecallType(record.kind),
      text: record.body.text,
      scope: scope.scope,
      repo: scope.repo,
      path_scope: scope.path,
      source: "user_correction",
      confidence: confidenceFor(record),
      // Equal text with distinct validity windows is intentional.
      dedupe: false,
      auto_inject: false,
      capture_context: initialContext,
    });
    db.update(memories)
      .set({
        capture_context: captureContextFor(record, toUmpId(createdId), undefined) as never,
        auto_inject: false,
        updated_at: new Date().toISOString(),
      })
      .where(eq(memories.id, createdId))
      .run();
    return createdId;
  })();
  if (record.lifecycle?.status === "tombstoned") rejectMemory(db, id, "ump");
  return id;
}

function safeRecallId(umpId: string): string | undefined {
  try {
    return fromAmpId(umpId);
  } catch {
    return undefined;
  }
}

export function makeRecallBackend(db: RecallDb, owner: string): RecallBackend {
  const umpSessionId = `ump:${process.pid}:${Date.now().toString(36)}`;
  return {
    queryMemories: (filter) => queryMemories(db, { repo: filter.repo }).map(toRecallMemory),

    getMemory: (id) => {
      const memory = getMemory(db, id);
      return memory ? toRecallMemory(memory) : undefined;
    },

    compileHybrid: async (request) => {
      const cap = request.limit ?? 8;
      // Fetch the complete indexed population before protocol filters. A
      // cap×5 window loses an eligible dated/private record behind noise.
      const totalCandidates = queryMemories(db, {}).length;
      const window = Math.max(totalCandidates, cap);
      const scores = new Map<string, number>();
      const add = (id: string, rank: number) =>
        scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank));

      const config = loadEmbeddingConfigFromEnv();
      if (config && window > 0) {
        try {
          const semantic = await semanticSearch(
            db,
            request.query,
            { ...config, similarity_threshold: SEARCH_MIN_SIM },
            { repo: request.repo, limit: window },
          );
          semantic.forEach((result, index) => add(result.memory.id, index));
        } catch {
          // Embeddings are optional; FTS and exhaustive fallback still work.
        }
      }
      if (window > 0) {
        try {
          searchMemoryFtsIndex(db, request.query, { repo: request.repo, limit: window })
            .forEach((result, index) => add(result.memory_id, index));
        } catch {
          // The FTS table may not be initialized in a standalone test DB.
        }
      }

      const ranked: Array<{ memory: RecallMemory; score: number }> = [];
      for (const [id, score] of [...scores.entries()].sort((a, b) => b[1] - a[1])) {
        const memory = getMemory(db, id);
        if (!memory || !candidateMatches(memory, owner, request)) continue;
        ranked.push({ memory: toRecallMemory(memory), score });
        if (ranked.length >= cap) return ranked;
      }

      // Index arms can have no textual hit for an otherwise eligible structured
      // record. Exhaustively score all remaining rows after filtering.
      const rankedIds = new Set(scores.keys());
      const fallback = queryMemories(db, {})
        .filter((memory) => !rankedIds.has(memory.id))
        .filter((memory) => candidateMatches(memory, owner, request))
        .map((memory) => ({ memory, score: tokenOverlap(request.query, memory.text) }))
        .sort((a, b) => b.score - a.score);
      for (const result of fallback) {
        ranked.push({ memory: toRecallMemory(result.memory), score: result.score });
        if (ranked.length >= cap) break;
      }
      return ranked;
    },

    putRecord: async (record, existingId) => {
      const id = putUmpRecord(db, record, existingId);
      await flushEmbeddingJobs();
      return id;
    },

    // SDK 1.0.2 compatibility only. SDK 1.0.3 uses putRecord for all direct
    // writes, including lifecycle revisions and tombstones.
    storeDirect: async ({ text, type, scope, repo, confidence, kind }) => {
      const id = createMemory(db, {
        type,
        text,
        scope,
        repo: repo ?? null,
        source: "user_correction",
        confidence,
        dedupe: false,
        capture_context: { ump_kind: kind } as CaptureContext,
      });
      await flushEmbeddingJobs();
      return id;
    },

    tombstone: (id) => rejectMemory(db, id, "ump"),

    capture: async ({ text, repo, path }) => {
      const result = await processCorrection(db, text, {
        sessionId: umpSessionId,
        repo,
        path,
        agent: "ump",
        force_semantic_capture: true,
      });
      return { ids: result.ids ?? [] };
    },
  };
}

/**
 * Recall backend for the Universal Memory Protocol adapter (@universalmemoryprotocol/core).
 *
 * Bridges Recall's native modules to the UMP `RecallBackend` interface so a
 * `recall ump` server can serve UMP over Recall's engine. Reads map faithfully;
 * writes flow into Recall's capture pipeline (text -> candidate memory).
 */

import type { RecallDb } from "../db/client.js";
import { createMemory, getMemory, queryMemories, rejectMemory } from "../models/memory.js";
import { flushEmbeddingJobs, semanticSearch, loadEmbeddingConfigFromEnv } from "../embeddings/embeddings.js";
import { searchMemoryFtsIndex } from "../vector/sqlite-fts.js";
import { processCorrection } from "../capture/correction.js";

// Lower than Recall's dedup threshold (0.8): retrieval wants paraphrase recall,
// not exact-duplicate precision. Tune with UMP_RECALL_MIN_SIM.
const SEARCH_MIN_SIM = parseFloat(process.env.UMP_RECALL_MIN_SIM ?? "0.3");
const RRF_K = 60;
import type { MemoryItem } from "../types.js";
import type { RecallBackend, RecallMemory } from "@universalmemoryprotocol/core/adapters/recall";

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
    capture_context: (m.capture_context as { ump_kind?: string } | null) ?? null,
  };
}

function tokenOverlap(query: string, text: string): number {
  const q = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
  if (q.size === 0) return 0;
  const t = text.toLowerCase();
  let hits = 0;
  for (const w of q) if (t.includes(w)) hits++;
  return hits / q.size;
}

export function makeRecallBackend(db: RecallDb): RecallBackend {
  const umpSessionId = `ump:${process.pid}:${Date.now().toString(36)}`;
  return {
    queryMemories: (f) => queryMemories(db, { repo: f.repo }).map(toRecallMemory),

    getMemory: (id) => {
      const m = getMemory(db, id);
      return m ? toRecallMemory(m) : undefined;
    },

    compileHybrid: async ({ query, repo, limit }) => {
      const cap = limit ?? 8;
      const window = Math.max(cap * 5, 30);
      // Reciprocal-rank fusion of a semantic arm (vector index, paraphrase-aware)
      // and a lexical arm (BM25 FTS). Both are index-backed, so this scales.
      const rrf = new Map<string, number>();
      const add = (id: string, rank: number) => rrf.set(id, (rrf.get(id) ?? 0) + 1 / (RRF_K + rank));

      const cfg = loadEmbeddingConfigFromEnv();
      if (cfg) {
        try {
          const sem = await semanticSearch(
            db,
            query,
            { ...cfg, similarity_threshold: SEARCH_MIN_SIM },
            { repo, limit: window },
          );
          sem.forEach((s, i) => add(s.memory.id, i));
        } catch { /* embeddings unavailable; lexical still applies */ }
      }
      try {
        searchMemoryFtsIndex(db, query, { repo, limit: window }).forEach((l, i) => add(l.memory_id, i));
      } catch { /* fts unavailable */ }

      if (rrf.size > 0) {
        const out: Array<{ memory: RecallMemory; score: number }> = [];
        for (const [id, score] of [...rrf.entries()].sort((a, b) => b[1] - a[1])) {
          const m = getMemory(db, id);
          if (m && (m.status === "active" || m.status === "candidate")) {
            out.push({ memory: toRecallMemory(m), score });
            if (out.length >= cap) break;
          }
        }
        if (out.length > 0) return out;
      }

      // Last-resort lexical scan (e.g. embeddings + FTS both empty).
      return queryMemories(db, {})
        .filter((m) => m.status === "active" || m.status === "candidate")
        .map((m) => ({ memory: toRecallMemory(m), score: tokenOverlap(query, m.text) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, cap);
    },

    storeDirect: async ({ text, type, scope, repo, confidence, kind }) => {
      const id = createMemory(db, {
        type,
        text,
        scope,
        repo: repo ?? null,
        source: "user_correction",
        confidence,
        capture_context: { ump_kind: kind } as never,
      });
      // createMemory queues the embedding sync; flush so the new memory is
      // immediately retrievable by semantic (vector) search.
      await flushEmbeddingJobs();
      return id;
    },

    tombstone: (id) => rejectMemory(db, id),

    capture: async ({ text, repo, path }) => {
      const res = await processCorrection(db, text, {
        // Unique per server process: a constant "ump" session id made
        // stablePromptId() dedupe identical rule text forever, so a rule
        // re-sent in a later UMP session was silently never re-extracted.
        sessionId: umpSessionId,
        repo,
        path,
        agent: "ump",
      });
      return { ids: res.ids ?? [] };
    },
  };
}

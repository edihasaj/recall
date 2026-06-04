/**
 * Recall backend for the Agent Memory Protocol adapter (@amp/core).
 *
 * Bridges Recall's native modules to the AMP `RecallBackend` interface so a
 * `recall amp` server can serve AMP over Recall's engine. Reads map faithfully;
 * writes flow into Recall's capture pipeline (text -> candidate memory).
 */

import type { RecallDb } from "../db/client.js";
import { getMemory, queryMemories } from "../models/memory.js";
import { compileContextHybrid } from "../compiler/context.js";
import { processCorrection } from "../capture/correction.js";
import type { MemoryItem } from "../types.js";
import type { RecallBackend, RecallMemory } from "@amp/core/adapters/recall";

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
  return {
    queryMemories: (f) => queryMemories(db, { repo: f.repo }).map(toRecallMemory),

    getMemory: (id) => {
      const m = getMemory(db, id);
      return m ? toRecallMemory(m) : undefined;
    },

    compileHybrid: async ({ query, repo, limit }) => {
      const cap = limit ?? 8;

      // Repo-scoped query: use Recall's hybrid compiler, then resolve ids.
      if (repo) {
        const ctx = await compileContextHybrid(db, { repo, query_text: query });
        const out: Array<{ memory: RecallMemory; score: number }> = [];
        ctx.memories_included.slice(0, cap).forEach((id, i) => {
          const m = getMemory(db, id);
          if (m) out.push({ memory: toRecallMemory(m), score: Math.max(0.1, 1 - i * 0.05) });
        });
        if (out.length > 0) return out;
      }

      // No repo (or empty hybrid result): lexical fallback over active memories.
      return queryMemories(db, {})
        .filter((m) => m.status === "active" || m.status === "candidate")
        .map((m) => ({ memory: toRecallMemory(m), score: tokenOverlap(query, m.text) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, cap);
    },

    capture: async ({ text, repo, path }) => {
      const res = await processCorrection(db, text, {
        sessionId: "amp",
        repo,
        path,
      });
      return { ids: res.ids ?? [] };
    },
  };
}

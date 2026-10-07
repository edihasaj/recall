import type { memories } from "../db/schema.js";
import type { EvidenceEntry, MemoryItem } from "../types.js";

export type MemoryRow = typeof memories.$inferSelect;

/**
 * The one mapping from a memories row to a MemoryItem. Keep every reader on
 * it: a second copy in the search path once dropped the note, so re-ranking
 * scored memories without it.
 */
export function rowToMemory(row: MemoryRow): MemoryItem {
  const evidence =
    typeof row.evidence === "string"
      ? JSON.parse(row.evidence as string)
      : Array.isArray(row.evidence)
        ? row.evidence
        : [];
  const captureContext =
    typeof row.capture_context === "string"
      ? JSON.parse(row.capture_context as string)
      : row.capture_context ?? null;
  return {
    id: row.id,
    type: row.type,
    text: row.text,
    scope: row.scope,
    path_scope: row.path_scope,
    repo: row.repo,
    status: row.status,
    confidence: row.confidence,
    source: row.source,
    evidence: evidence as EvidenceEntry[],
    capture_context: captureContext as MemoryItem["capture_context"],
    note: row.note ?? null,
    supersedes: row.supersedes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_validated_at: row.last_validated_at,
    last_injected_at: row.last_injected_at,
    injection_count: row.injection_count,
    override_count: row.override_count,
    repetition_count: row.repetition_count,
    auto_inject: row.auto_inject,
  };
}

import { eq } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { historySnippets, memories } from "../db/schema.js";
import { getMemory } from "../models/memory.js";
import { recordAuditWithSnapshot } from "../audit/trail.js";
import { queueMemoryEmbeddingSync } from "../embeddings/embeddings.js";
import type { MaintenanceTask } from "../types.js";
import type {
  RefineCandidateResult,
  SummarizeHistoryResult,
} from "./tasks.js";

export class ApplyError extends Error {
  constructor(message: string, public readonly code: "target-missing" | "invalid-state" | "unsupported-kind") {
    super(message);
    this.name = "ApplyError";
  }
}

export interface ApplyOutcome {
  audit_entry_id: string | null;
  target_id: string;
  changed_fields: string[];
}

export function applyRefineCandidate(
  db: RecallDb,
  task: MaintenanceTask,
  result: RefineCandidateResult,
): ApplyOutcome {
  const memoryId = (task.payload as { memory_id?: string }).memory_id;
  if (!memoryId) throw new ApplyError("payload missing memory_id", "invalid-state");

  const before = getMemory(db, memoryId);
  if (!before) throw new ApplyError(`memory ${memoryId} not found`, "target-missing");

  const changed: string[] = [];
  if (before.text !== result.refined_text) changed.push("text");
  if (before.scope !== result.scope) changed.push("scope");
  const newPathScope = result.path_scope ?? null;
  if (before.path_scope !== newPathScope) changed.push("path_scope");

  if (changed.length === 0) {
    return { audit_entry_id: null, target_id: memoryId, changed_fields: [] };
  }

  const now = new Date().toISOString();
  db.update(memories)
    .set({
      text: result.refined_text,
      scope: result.scope,
      path_scope: newPathScope,
      updated_at: now,
      last_validated_at: now,
    })
    .where(eq(memories.id, memoryId))
    .run();

  queueMemoryEmbeddingSync(db, memoryId);

  const after = getMemory(db, memoryId);
  const reason = result.rationale
    ? `refined:${task.id}:${result.rationale.slice(0, 200)}`
    : `refined:${task.id}`;
  const auditId = recordAuditWithSnapshot(
    db,
    memoryId,
    "edited",
    `maintenance:${task.claimed_by ?? "unknown"}`,
    reason,
    before,
    after ?? null,
  );

  return { audit_entry_id: auditId, target_id: memoryId, changed_fields: changed };
}

export function applySummarizeHistory(
  db: RecallDb,
  task: MaintenanceTask,
  result: SummarizeHistoryResult,
): ApplyOutcome {
  const snippetId = (task.payload as { snippet_id?: string }).snippet_id;
  if (!snippetId) throw new ApplyError("payload missing snippet_id", "invalid-state");

  const existing = db.select().from(historySnippets)
    .where(eq(historySnippets.id, snippetId))
    .get();
  if (!existing) throw new ApplyError(`history snippet ${snippetId} not found`, "target-missing");

  const changed: string[] = [];
  if (existing.text !== result.summary_text) changed.push("text");
  if (changed.length === 0) {
    return { audit_entry_id: null, target_id: snippetId, changed_fields: [] };
  }

  db.update(historySnippets)
    .set({
      text: result.summary_text,
      updated_at: new Date().toISOString(),
    })
    .where(eq(historySnippets.id, snippetId))
    .run();

  // History snippets aren't memories, so no audit_trail row — the activity
  // log + the task's stored `result` column is the audit surface here.
  return { audit_entry_id: null, target_id: snippetId, changed_fields: changed };
}

export function applyTaskResult(
  db: RecallDb,
  task: MaintenanceTask,
  result: unknown,
): ApplyOutcome {
  switch (task.kind) {
    case "refine_candidate":
      return applyRefineCandidate(db, task, result as RefineCandidateResult);
    case "summarize_history":
      return applySummarizeHistory(db, task, result as SummarizeHistoryResult);
    case "merge_duplicates":
    case "summarize_session":
    case "synthesize_repo":
      throw new ApplyError(`applier for ${task.kind} not implemented`, "unsupported-kind");
    default: {
      const never: never = task.kind;
      throw new ApplyError(`unknown kind ${never}`, "unsupported-kind");
    }
  }
}

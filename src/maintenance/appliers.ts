import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { historySnippets, memories } from "../db/schema.js";
import { getMemory } from "../models/memory.js";
import { recordAuditWithSnapshot } from "../audit/trail.js";
import { queueMemoryEmbeddingSync } from "../embeddings/embeddings.js";
import type { MaintenanceTask } from "../types.js";
import type {
  MergeDuplicatesResult,
  RefineCandidateResult,
  SummarizeHistoryResult,
  SummarizeSessionResult,
  SynthesizeRepoResult,
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

interface MergeCandidate {
  id: string;
  text: string;
  scope: string;
  path_scope: string | null;
}

export function applyMergeDuplicates(
  db: RecallDb,
  task: MaintenanceTask,
  result: MergeDuplicatesResult,
): ApplyOutcome {
  const payload = task.payload as { candidates?: MergeCandidate[] };
  const candidates = payload.candidates ?? [];
  if (candidates.length < 2) {
    throw new ApplyError("merge_duplicates payload needs ≥2 candidates", "invalid-state");
  }

  const winnerId = result.winner_id;
  if (!candidates.some((c) => c.id === winnerId)) {
    throw new ApplyError(`winner_id ${winnerId} not in candidates`, "invalid-state");
  }

  const winner = getMemory(db, winnerId);
  if (!winner) throw new ApplyError(`winner ${winnerId} not found`, "target-missing");

  const now = new Date().toISOString();
  const changed: string[] = [];
  const actor = `maintenance:${task.claimed_by ?? "unknown"}`;

  // Update winner if requested.
  const nextText = result.winner_text ?? winner.text;
  const nextScope = result.winner_scope ?? winner.scope;
  const nextPathScope = result.winner_path_scope !== undefined
    ? (result.winner_path_scope ?? null)
    : winner.path_scope;

  const winnerChanged = nextText !== winner.text
    || nextScope !== winner.scope
    || nextPathScope !== winner.path_scope;

  if (winnerChanged) {
    db.update(memories)
      .set({
        text: nextText,
        scope: nextScope as any,
        path_scope: nextPathScope,
        updated_at: now,
        last_validated_at: now,
      })
      .where(eq(memories.id, winnerId))
      .run();
    queueMemoryEmbeddingSync(db, winnerId);

    const after = getMemory(db, winnerId);
    recordAuditWithSnapshot(
      db,
      winnerId,
      "edited",
      actor,
      `merged_winner:${task.id}`,
      winner,
      after ?? null,
    );
    changed.push(`winner:${winnerId}`);
  }

  // Reject losers with supersedes=winner.
  for (const cand of candidates) {
    if (cand.id === winnerId) continue;
    const loser = getMemory(db, cand.id);
    if (!loser) continue;
    if (loser.status === "rejected") continue;

    db.update(memories)
      .set({
        status: "rejected",
        supersedes: winnerId,
        dedupe_key: null,
        updated_at: now,
      })
      .where(eq(memories.id, cand.id))
      .run();
    queueMemoryEmbeddingSync(db, cand.id);

    const afterLoser = getMemory(db, cand.id);
    recordAuditWithSnapshot(
      db,
      cand.id,
      "rejected",
      actor,
      `merged_into:${winnerId}:${task.id}`,
      loser,
      afterLoser ?? null,
    );
    changed.push(`loser:${cand.id}`);
  }

  return {
    audit_entry_id: null,
    target_id: winnerId,
    changed_fields: changed,
  };
}

export function applySummarizeSession(
  db: RecallDb,
  task: MaintenanceTask,
  result: SummarizeSessionResult,
): ApplyOutcome {
  const payload = task.payload as {
    session_id?: string;
    repo?: string | null;
    source_activity_ids?: string[];
  };
  const sessionId = payload.session_id;
  if (!sessionId) throw new ApplyError("payload missing session_id", "invalid-state");

  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(historySnippets).values({
    id,
    repo: payload.repo ?? null,
    session_id: sessionId,
    kind: "session_summary",
    text: result.summary_text,
    source_activity_ids: (payload.source_activity_ids ?? []) as any,
    created_at: now,
    updated_at: now,
  }).run();

  return { audit_entry_id: null, target_id: id, changed_fields: ["text"] };
}

export function applySynthesizeRepo(
  db: RecallDb,
  task: MaintenanceTask,
  result: SynthesizeRepoResult,
): ApplyOutcome {
  const payload = task.payload as { repo?: string };
  const repo = payload.repo;
  if (!repo) throw new ApplyError("payload missing repo", "invalid-state");

  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(historySnippets).values({
    id,
    repo,
    session_id: null,
    kind: "repo_synthesis",
    text: result.summary_text,
    source_activity_ids: [] as any,
    created_at: now,
    updated_at: now,
  }).run();

  return { audit_entry_id: null, target_id: id, changed_fields: ["text"] };
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
      return applyMergeDuplicates(db, task, result as MergeDuplicatesResult);
    case "summarize_session":
      return applySummarizeSession(db, task, result as SummarizeSessionResult);
    case "synthesize_repo":
      return applySynthesizeRepo(db, task, result as SynthesizeRepoResult);
    default: {
      const never: never = task.kind;
      throw new ApplyError(`unknown kind ${never}`, "unsupported-kind");
    }
  }
}

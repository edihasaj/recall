import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { historySnippets, memories } from "../db/schema.js";
import { createMemory, getMemory, queryMemories } from "../models/memory.js";
import { recordAuditWithSnapshot } from "../audit/trail.js";
import { queueMemoryEmbeddingSync } from "../embeddings/embeddings.js";
import type { CaptureContext, MaintenanceTask, MemoryType } from "../types.js";
import { isHighRiskRule } from "../capture/correction.js";
import { getRepoQualityProfile, seedCandidateConfidence } from "../repo/quality.js";
import type {
  ExtractedRule,
  ExtractRulesFromPromptResult,
  MergeDuplicatesResult,
  RefineCandidateResult,
  SummarizeHistoryResult,
  SummarizeSessionResult,
  SynthesizeRepoResult,
  VerifyCaptureResult,
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

  const actor = `maintenance:${task.claimed_by ?? "unknown"}`;

  if (result.verdict === "reject") {
    return rejectMemoryFromTask(db, task, memoryId, before, actor, result.rationale);
  }

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
    actor,
    reason,
    before,
    after ?? null,
  );

  return { audit_entry_id: auditId, target_id: memoryId, changed_fields: changed };
}

// Phase E1 — verify_capture applier. Three verdicts:
//   * save    — leave the candidate as-is (LLM agrees with heuristic capture)
//   * rewrite — clean text/scope/path_scope, candidate stays candidate
//   * reject  — flip to rejected with audit reason from the LLM
// All paths are idempotent. The candidate's promotion path (B+F) is unaffected
// — verify_capture refines or kills, it never promotes. Promotion still
// requires repetition or explicit confirm.
export function applyVerifyCapture(
  db: RecallDb,
  task: MaintenanceTask,
  result: VerifyCaptureResult,
): ApplyOutcome {
  const memoryId = (task.payload as { memory_id?: string }).memory_id;
  if (!memoryId) throw new ApplyError("payload missing memory_id", "invalid-state");

  const before = getMemory(db, memoryId);
  if (!before) throw new ApplyError(`memory ${memoryId} not found`, "target-missing");

  const actor = `maintenance:${task.claimed_by ?? "unknown"}`;

  if (result.verdict === "reject") {
    return rejectMemoryFromTask(db, task, memoryId, before, actor, result.reason);
  }

  if (result.verdict === "save") {
    return { audit_entry_id: null, target_id: memoryId, changed_fields: [] };
  }

  // verdict === "rewrite"
  const newText = result.cleaned_text ?? before.text;
  const newScope = result.scope ?? before.scope;
  const newPathScope = result.path_scope ?? before.path_scope;

  const changed: string[] = [];
  if (before.text !== newText) changed.push("text");
  if (before.scope !== newScope) changed.push("scope");
  if (before.path_scope !== newPathScope) changed.push("path_scope");

  if (changed.length === 0) {
    return { audit_entry_id: null, target_id: memoryId, changed_fields: [] };
  }

  const now = new Date().toISOString();
  db.update(memories)
    .set({
      text: newText,
      scope: newScope,
      path_scope: newPathScope,
      updated_at: now,
      last_validated_at: now,
    })
    .where(eq(memories.id, memoryId))
    .run();

  queueMemoryEmbeddingSync(db, memoryId);

  const after = getMemory(db, memoryId);
  const reason = result.reason
    ? `verify:rewrite:${task.id}:${result.reason.slice(0, 200)}`
    : `verify:rewrite:${task.id}`;
  const auditId = recordAuditWithSnapshot(
    db,
    memoryId,
    "edited",
    actor,
    reason,
    before,
    after ?? null,
  );

  return { audit_entry_id: auditId, target_id: memoryId, changed_fields: changed };
}

function rejectMemoryFromTask(
  db: RecallDb,
  task: MaintenanceTask,
  memoryId: string,
  before: NonNullable<ReturnType<typeof getMemory>>,
  actor: string,
  reasonText: string | undefined,
): ApplyOutcome {
  if (before.status === "rejected") {
    return { audit_entry_id: null, target_id: memoryId, changed_fields: [] };
  }
  const now = new Date().toISOString();
  db.update(memories)
    .set({ status: "rejected", confidence: 0, dedupe_key: null, updated_at: now })
    .where(eq(memories.id, memoryId))
    .run();
  queueMemoryEmbeddingSync(db, memoryId);
  const after = getMemory(db, memoryId);
  const reason = reasonText
    ? `${task.kind}:reject:${task.id}:${reasonText.slice(0, 200)}`
    : `${task.kind}:reject:${task.id}`;
  const auditId = recordAuditWithSnapshot(
    db,
    memoryId,
    "rejected",
    actor,
    reason,
    before,
    after ?? null,
  );
  return { audit_entry_id: auditId, target_id: memoryId, changed_fields: ["status"] };
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

// LLM-primary capture applier. The LLM extracted zero or more rules from the
// raw user prompt; for each one we create a candidate memory (subject to
// dedup against existing same-repo memories). The applier never auto-promotes
// — promotion still flows through repetition or explicit user confirm, same
// as the regex path. Destructive-risky rules and trigger-template rules are
// always created as candidates, never active, regardless of confidence.
export function applyExtractRulesFromPrompt(
  db: RecallDb,
  task: MaintenanceTask,
  result: ExtractRulesFromPromptResult,
): ApplyOutcome {
  const payload = task.payload as {
    repo?: string | null;
    path?: string | null;
    agent?: string | null;
    session_id?: string;
    raw_prompt?: string;
  };
  const repo = payload.repo ?? null;
  const profile = getRepoQualityProfile(db, repo ?? undefined);

  if (!result.rules || result.rules.length === 0) {
    return { audit_entry_id: null, target_id: task.id, changed_fields: [] };
  }

  const captureContext: CaptureContext = {
    prev_assistant_text: undefined,
    recent_tool_calls: [],
    repo,
    path: payload.path ?? null,
    agent: payload.agent ?? undefined,
  };

  const createdIds: string[] = [];
  for (const rule of result.rules) {
    if (existsSimilar(db, repo, rule)) continue;

    const memoryType = (rule.type as MemoryType) ?? "rule";
    const id = createMemory(db, {
      type: memoryType,
      text: rule.text,
      scope: rule.scope,
      path_scope: rule.path_scope ?? null,
      repo,
      source: "user_correction",
      confidence: seedCandidateConfidence(rule.confidence, profile),
      evidence: [
        {
          type: "session_correction",
          session: payload.session_id ?? "unknown",
          timestamp: new Date().toISOString(),
          context: payload.raw_prompt ?? "",
        },
      ],
      capture_context: captureContext,
    });
    createdIds.push(id);

    const after = getMemory(db, id);
    recordAuditWithSnapshot(
      db,
      id,
      "created",
      `maintenance:${task.claimed_by ?? "llm"}`,
      `extract_rules_from_prompt:${task.id}${rule.rationale ? `:${rule.rationale.slice(0, 200)}` : ""}`,
      null,
      after ?? null,
    );

    // High-risk rules never auto-promote, even if LLM gives high confidence.
    // The existing maybePromoteGroupCandidate path (in correction.ts) skips
    // them; for parity we just rely on it remaining a candidate here.
    if (rule.is_destructive_risky || isHighRiskRule(rule.text)) {
      // No-op; candidate stays candidate until explicit confirm.
    }
  }

  return {
    audit_entry_id: null,
    target_id: createdIds[0] ?? task.id,
    changed_fields: createdIds.length > 0 ? ["created_memories"] : [],
  };
}

function existsSimilar(
  db: RecallDb,
  repo: string | null,
  rule: ExtractedRule,
): boolean {
  if (!repo) return false;
  const ruleIsHighRisk = rule.is_destructive_risky || isHighRiskRule(rule.text);
  const candidates = queryMemories(db, {
    repo: repo ?? undefined,
    ...(ruleIsHighRisk ? {} : { type: rule.type as MemoryType }),
  })
    .filter((memory) => memory.status !== "rejected");
  const normalized = rule.text.toLowerCase().trim();
  return candidates.some((memory) => {
    if (memory.text.toLowerCase().trim() === normalized) return true;
    if (ruleIsHighRisk && isHighRiskRule(memory.text)) {
      return containmentOverlap(memory.text, rule.text) >= 0.65;
    }
    return jaccard(memory.text, rule.text) >= 0.85;
  });
}

function jaccard(a: string, b: string): number {
  const wordsA = new Set(tokens(a));
  const wordsB = new Set(tokens(b));
  const intersection = [...wordsA].filter((w) => wordsB.has(w));
  const union = new Set([...wordsA, ...wordsB]);
  return union.size === 0 ? 0 : intersection.length / union.size;
}

function containmentOverlap(a: string, b: string): number {
  const wordsA = new Set(tokens(a));
  const wordsB = new Set(tokens(b));
  const intersection = [...wordsA].filter((w) => wordsB.has(w));
  const smaller = Math.min(wordsA.size, wordsB.size);
  return smaller === 0 ? 0 : intersection.length / smaller;
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9.]+/g) ?? [];
}

export function applyTaskResult(
  db: RecallDb,
  task: MaintenanceTask,
  result: unknown,
): ApplyOutcome {
  switch (task.kind) {
    case "verify_capture":
      return applyVerifyCapture(db, task, result as VerifyCaptureResult);
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
    case "extract_rules_from_prompt":
      return applyExtractRulesFromPrompt(db, task, result as ExtractRulesFromPromptResult);
    default: {
      const never: never = task.kind;
      throw new ApplyError(`unknown kind ${never}`, "unsupported-kind");
    }
  }
}

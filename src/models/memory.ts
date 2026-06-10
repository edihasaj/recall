import { eq, and, gte, inArray, like, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { memories, feedbackEvents } from "../db/schema.js";
import { memoryDedupeKey } from "./dedupe.js";
import { queueMemoryEmbeddingSync } from "../embeddings/embeddings.js";
import {
  CONFIDENCE,
  PROMOTION,
  type MemoryItem,
  type MemoryQuery,
  type MemoryStatus,
  type MemoryType,
  type MemoryScope,
  type MemorySource,
  type EvidenceEntry,
  type CaptureContext,
  type FeedbackOutcome,
} from "../types.js";

type MemoryRow = typeof memories.$inferSelect;

// --- Create ---

export interface CreateMemoryInput {
  type: MemoryType;
  text: string;
  scope: MemoryScope;
  path_scope?: string | null;
  repo?: string | null;
  source: MemorySource;
  confidence?: number;
  evidence?: EvidenceEntry[];
  capture_context?: CaptureContext | null;
  supersedes?: string | null;
  dedupe?: boolean;
}

export function statusFromConfidence(confidence: number): MemoryStatus {
  if (confidence < CONFIDENCE.TRANSIENT_MAX) return "transient";
  if (confidence < CONFIDENCE.CANDIDATE_MAX) return "candidate";
  return "active";
}

export function createMemory(db: RecallDb, input: CreateMemoryInput): string {
  const now = new Date().toISOString();
  const id = randomUUID();
  const confidence = input.confidence ?? 0.35; // default: low candidate
  const status = statusFromConfidence(confidence);
  const dedupeKey = input.dedupe === false
    ? null
    : memoryDedupeKey({
        type: input.type,
        scope: input.scope,
        repo: input.repo ?? null,
        path_scope: input.path_scope ?? null,
        text: input.text,
      });

  if (dedupeKey) {
    const existing = db.select().from(memories)
      .where(and(eq(memories.dedupe_key, dedupeKey), sql`${memories.status} != 'rejected'`))
      .get();
    if (existing) return existing.id;
  }

  // onConflictDoNothing closes the TOCTOU window between the pre-check SELECT
  // and this INSERT: when two writers race (e.g. concurrent Claude + Codex
  // session-start scans bootstrapping the same repo), both pass the SELECT
  // above, then one INSERT wins and the other previously threw
  // "UNIQUE constraint failed: memories.dedupe_key", crashing the whole hook.
  const result = db.insert(memories)
    .values({
      id,
      type: input.type,
      text: input.text,
      scope: input.scope,
      path_scope: input.path_scope ?? null,
      repo: input.repo ?? null,
      status,
      confidence,
      source: input.source,
      evidence: (input.evidence ?? []) as any,
      capture_context: input.capture_context ? input.capture_context as any : null,
      supersedes: input.supersedes ?? null,
      dedupe_key: dedupeKey,
      created_at: now,
      updated_at: now,
      last_validated_at: null,
      last_injected_at: null,
      injection_count: 0,
      override_count: 0,
      repetition_count: 0,
    })
    .onConflictDoNothing({ target: memories.dedupe_key })
    .run();

  if (dedupeKey && result.changes === 0) {
    // Lost the race (or a stale rejected row still holds the key): return the
    // existing memory's id rather than the uninserted one, and don't queue an
    // embedding for a row that was never written.
    const winner = db.select().from(memories)
      .where(eq(memories.dedupe_key, dedupeKey))
      .get();
    if (winner) return winner.id;
  }

  queueMemoryEmbeddingSync(db, id);
  return id;
}

// --- Read ---

export function getMemory(
  db: RecallDb,
  id: string,
): MemoryItem | undefined {
  const row = db.select().from(memories).where(eq(memories.id, id)).get();
  if (!row) return undefined;
  return rowToMemory(row);
}

export function queryMemories(
  db: RecallDb,
  query: MemoryQuery,
): MemoryItem[] {
  const conditions = [];

  if (query.repo) conditions.push(eq(memories.repo, query.repo));
  if (query.status) conditions.push(eq(memories.status, query.status));
  if (query.type) conditions.push(eq(memories.type, query.type));
  if (query.scope) conditions.push(eq(memories.scope, query.scope));
  if (query.min_confidence != null)
    conditions.push(gte(memories.confidence, query.min_confidence));
  if (query.path) conditions.push(like(memories.path_scope, `%${query.path}%`));
  if (query.auto_inject != null) conditions.push(eq(memories.auto_inject, query.auto_inject));

  let statement = db.select().from(memories).$dynamic();
  if (conditions.length > 0) {
    statement = statement.where(and(...conditions));
  }
  if (query.offset != null) {
    statement = statement.offset(query.offset);
  }
  if (query.limit != null) {
    statement = statement.limit(query.limit);
  }

  const rows = statement.all();

  return rows.map(rowToMemory);
}

export function listMemories(
  db: RecallDb,
  repo?: string,
  options: Pick<MemoryQuery, "limit" | "offset"> = {},
): MemoryItem[] {
  return queryMemories(db, {
    repo,
    limit: options.limit,
    offset: options.offset,
  });
}

export function listRepos(db: RecallDb): string[] {
  return [...new Set(
    db.select({ repo: memories.repo }).from(memories).all()
      .map((row) => row.repo)
      .filter((repo): repo is string => Boolean(repo)),
  )].sort();
}

// --- State transitions ---

export function promoteMemory(
  db: RecallDb,
  id: string,
  reason: "explicit_confirm" | "repeat_correction" | "review_feedback" | "passive_gain",
  evidence?: EvidenceEntry,
): boolean {
  const mem = getMemory(db, id);
  if (!mem) return false;
  if (mem.status === "rejected") return false; // must use reactivate

  let newConfidence: number;
  if (reason === "explicit_confirm") {
    newConfidence = Math.max(mem.confidence, PROMOTION.EXPLICIT_CONFIRM);
  } else if (reason === "repeat_correction") {
    newConfidence = Math.min(1, mem.confidence + PROMOTION.REPEAT_CORRECTION);
  } else if (reason === "review_feedback") {
    newConfidence = Math.min(1, mem.confidence + PROMOTION.REVIEW_FEEDBACK);
  } else {
    newConfidence = Math.min(1, mem.confidence + PROMOTION.PASSIVE_GAIN);
  }

  const newStatus = statusFromConfidence(newConfidence);
  const now = new Date().toISOString();

  const newEvidence = evidence
    ? [...mem.evidence, evidence]
    : mem.evidence;

  db.update(memories)
    .set({
      confidence: newConfidence,
      status: newStatus,
      evidence: newEvidence as any,
      updated_at: now,
      last_validated_at: now,
    })
    .where(eq(memories.id, id))
    .run();

  queueMemoryEmbeddingSync(db, id);
  return true;
}

export function demoteMemory(
  db: RecallDb,
  id: string,
  reason: string,
): boolean {
  const mem = getMemory(db, id);
  if (!mem) return false;

  const newConfidence = Math.max(0, mem.confidence - 0.3);
  const newStatus = statusFromConfidence(newConfidence);
  const now = new Date().toISOString();

  db.update(memories)
    .set({
      confidence: newConfidence,
      status: newStatus === "transient" ? "candidate" : newStatus, // don't lose it completely
      updated_at: now,
    })
    .where(eq(memories.id, id))
    .run();

  queueMemoryEmbeddingSync(db, id);
  return true;
}

export type DemoteGlobalResult =
  | { ok: true; outcome: "rescoped" | "rejected"; memory: MemoryItem }
  | { ok: false; reason: "not_found" | "not_global" };

export function demoteGlobalMemory(
  db: RecallDb,
  id: string,
  opts: { repo?: string | null } = {},
): DemoteGlobalResult {
  const mem = getMemory(db, id);
  if (!mem) return { ok: false, reason: "not_found" };
  if (mem.scope !== "global") return { ok: false, reason: "not_global" };

  const targetRepo = opts.repo?.trim() || null;
  const now = new Date().toISOString();

  if (targetRepo) {
    const newDedupe = memoryDedupeKey({
      type: mem.type,
      scope: "repo",
      repo: targetRepo,
      path_scope: mem.path_scope,
      text: mem.text,
    });
    db.update(memories)
      .set({
        scope: "repo",
        repo: targetRepo,
        dedupe_key: newDedupe,
        updated_at: now,
      })
      .where(eq(memories.id, id))
      .run();
  } else {
    db.update(memories)
      .set({
        status: "rejected",
        confidence: 0,
        dedupe_key: null,
        updated_at: now,
      })
      .where(eq(memories.id, id))
      .run();
  }

  queueMemoryEmbeddingSync(db, id);
  const updated = getMemory(db, id)!;
  return { ok: true, outcome: targetRepo ? "rescoped" : "rejected", memory: updated };
}

export function rejectMemory(db: RecallDb, id: string): boolean {
  const mem = getMemory(db, id);
  if (!mem) return false;

  db.update(memories)
    .set({
      status: "rejected",
      confidence: 0,
      dedupe_key: null,
      updated_at: new Date().toISOString(),
    })
    .where(eq(memories.id, id))
    .run();

  queueMemoryEmbeddingSync(db, id);
  return true;
}

export function confirmMemory(db: RecallDb, id: string): boolean {
  return promoteMemory(db, id, "explicit_confirm", {
    type: "session_correction",
    session: "cli",
    timestamp: new Date().toISOString(),
    context: "user explicitly confirmed",
  });
}

export function reactivateMemory(
  db: RecallDb,
  id: string,
  evidence: EvidenceEntry,
): boolean {
  const mem = getMemory(db, id);
  if (!mem) return false;
  if (mem.status !== "rejected") return false;

  const now = new Date().toISOString();
  const dedupeKey = memoryDedupeKey(mem);
  const existing = db.select().from(memories)
    .where(and(eq(memories.dedupe_key, dedupeKey), sql`${memories.status} != 'rejected'`))
    .get();
  if (existing && existing.id !== id) return false;

  db.update(memories)
    .set({
      status: "candidate",
      confidence: CONFIDENCE.TRANSIENT_MAX + 0.05,
      dedupe_key: dedupeKey,
      evidence: [...mem.evidence, evidence] as any,
      updated_at: now,
    })
    .where(eq(memories.id, id))
    .run();

  queueMemoryEmbeddingSync(db, id);
  return true;
}

export function appendEvidence(
  db: RecallDb,
  id: string,
  evidence: EvidenceEntry,
): boolean {
  const mem = getMemory(db, id);
  if (!mem) return false;
  if (hasEquivalentEvidence(mem.evidence, evidence)) return true;

  const now = new Date().toISOString();
  db.update(memories)
    .set({
      evidence: [...mem.evidence, evidence] as any,
      updated_at: now,
      last_validated_at: now,
    })
    .where(eq(memories.id, id))
    .run();

  return true;
}

export function updateMemoryCaptureContext(
  db: RecallDb,
  id: string,
  captureContext: CaptureContext,
): boolean {
  const mem = getMemory(db, id);
  if (!mem) return false;

  db.update(memories)
    .set({
      capture_context: captureContext as any,
      updated_at: new Date().toISOString(),
    })
    .where(eq(memories.id, id))
    .run();

  return true;
}

export function incrementMemoryRepetition(
  db: RecallDb,
  id: string,
): boolean {
  const mem = getMemory(db, id);
  if (!mem) return false;

  db.update(memories)
    .set({
      repetition_count: sql`repetition_count + 1`,
      updated_at: new Date().toISOString(),
    })
    .where(eq(memories.id, id))
    .run();

  return true;
}

export function countDistinctCorrectionSessions(mem: MemoryItem): number {
  const sessions = new Set<string>();

  for (const entry of mem.evidence) {
    if (entry.type === "session_correction") {
      sessions.add(entry.session);
    } else if (entry.type === "repeated_correction") {
      for (const session of entry.sessions) {
        sessions.add(session);
      }
    }
  }

  return sessions.size;
}

// --- Feedback ---

export function recordFeedback(
  db: RecallDb,
  memoryId: string,
  sessionId: string,
  injected: boolean,
  outcome: FeedbackOutcome,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();

  db.insert(feedbackEvents)
    .values({
      id,
      memory_id: memoryId,
      session_id: sessionId,
      injected,
      outcome,
      timestamp: now,
    })
    .run();

  const mem = getMemory(db, memoryId);
  if (!mem) return id;

  const delta = outcome === "followed"
    ? 0.05
    : outcome === "overridden"
      ? -0.15
      : outcome === "ignored"
        ? -0.02
        : -0.25;
  const nextConfidence = Math.max(0, Math.min(1, mem.confidence + delta));
  const nextStatus = statusFromConfidence(nextConfidence);

  // Update injection tracking
  if (injected) {
    db.update(memories)
      .set({
        confidence: nextConfidence,
        status: nextStatus === "transient" ? "candidate" : nextStatus,
        updated_at: now,
        last_injected_at: now,
        injection_count: sql`injection_count + 1`,
        ...(outcome === "overridden" || outcome === "contradicted"
          ? { override_count: sql`override_count + 1` }
          : {}),
      })
      .where(eq(memories.id, memoryId))
      .run();
  } else {
    db.update(memories)
      .set({
        confidence: nextConfidence,
        status: nextStatus === "transient" ? "candidate" : nextStatus,
        updated_at: now,
      })
      .where(eq(memories.id, memoryId))
      .run();
  }

  return id;
}

export function getMemoryFeedback(
  db: RecallDb,
  memoryId: string,
) {
  return db
    .select()
    .from(feedbackEvents)
    .where(eq(feedbackEvents.memory_id, memoryId))
    .all();
}

export interface FeedbackSummary {
  followed: number;
  overridden: number;
  contradicted: number;
  ignored: number;
  resolved: number;
}

/**
 * Aggregate feedback outcomes for a batch of memories in a single query.
 * `resolved` excludes `ignored` because the post-Phase-2.3 detector only
 * writes meaningful outcomes.
 */
export function getMemoryFeedbackSummaries(
  db: RecallDb,
  memoryIds: readonly string[],
): Map<string, FeedbackSummary> {
  const empty = (): FeedbackSummary => ({
    followed: 0,
    overridden: 0,
    contradicted: 0,
    ignored: 0,
    resolved: 0,
  });
  const result = new Map<string, FeedbackSummary>();
  if (memoryIds.length === 0) return result;
  for (const id of memoryIds) result.set(id, empty());

  const rows = db.select({
    memory_id: feedbackEvents.memory_id,
    outcome: feedbackEvents.outcome,
    count: sql<number>`count(*)`.as("count"),
  })
    .from(feedbackEvents)
    .where(inArray(feedbackEvents.memory_id, [...memoryIds]))
    .groupBy(feedbackEvents.memory_id, feedbackEvents.outcome)
    .all();

  for (const row of rows) {
    const entry = result.get(row.memory_id) ?? empty();
    if (row.outcome === "followed") entry.followed += row.count;
    else if (row.outcome === "overridden") entry.overridden += row.count;
    else if (row.outcome === "contradicted") entry.contradicted += row.count;
    else if (row.outcome === "ignored") entry.ignored += row.count;
    if (row.outcome !== "ignored") entry.resolved += row.count;
    result.set(row.memory_id, entry);
  }
  return result;
}

/**
 * Smoothed feedback-driven score in [0, 1]. Cold-start memories return their
 * confidence directly; as resolved samples accumulate, the score blends in
 * the empirical followed rate (Bayesian beta(1,1) prior, weight ramps to 1
 * at FEEDBACK_MATURITY resolved samples).
 */
export const FEEDBACK_MATURITY = 5;
export function feedbackWeightedScore(
  confidence: number,
  summary: FeedbackSummary,
): number {
  const total = summary.resolved;
  const maturity = Math.min(total, FEEDBACK_MATURITY) / FEEDBACK_MATURITY;
  if (maturity === 0) return confidence;
  // Penalize contradictions harder than overrides.
  const positive = summary.followed;
  const negative = summary.overridden + 2 * summary.contradicted;
  const numerator = Math.max(0, positive - negative + 1);
  const denominator = Math.max(1, total + 2);
  const empirical = Math.min(1, numerator / denominator);
  return (1 - maturity) * confidence + maturity * empirical;
}

// --- Helpers ---

function rowToMemory(row: MemoryRow): MemoryItem {
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

function hasEquivalentEvidence(
  existing: EvidenceEntry[],
  next: EvidenceEntry,
): boolean {
  return existing.some((entry) => {
    if (entry.type !== next.type) return false;

    if (entry.type === "session_correction" && next.type === "session_correction") {
      return entry.session === next.session;
    }

    if (entry.type === "review_feedback" && next.type === "review_feedback") {
      return entry.reviewer === next.reviewer && entry.context === next.context;
    }

    if (entry.type === "repo_scan" && next.type === "repo_scan") {
      return entry.file === next.file;
    }

    if (entry.type === "repeated_correction" && next.type === "repeated_correction") {
      return entry.sessions.join("|") === next.sessions.join("|");
    }

    return false;
  });
}

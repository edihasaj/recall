import { eq, and, gte, like, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { memories, feedbackEvents } from "../db/schema.js";
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
  supersedes?: string | null;
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

  db.insert(memories)
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
      supersedes: input.supersedes ?? null,
      created_at: now,
      updated_at: now,
      last_validated_at: null,
      last_injected_at: null,
      injection_count: 0,
      override_count: 0,
    })
    .run();

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

export function rejectMemory(db: RecallDb, id: string): boolean {
  const mem = getMemory(db, id);
  if (!mem) return false;

  db.update(memories)
    .set({
      status: "rejected",
      confidence: 0,
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
  db.update(memories)
    .set({
      status: "candidate",
      confidence: CONFIDENCE.TRANSIENT_MAX + 0.05,
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

  // Auto-adjust confidence based on outcome
  if (outcome === "followed") {
    promoteMemory(db, memoryId, "passive_gain");
  } else if (outcome === "overridden" || outcome === "contradicted") {
    demoteMemory(db, memoryId, outcome);
  }

  // Update injection tracking
  if (injected) {
    db.update(memories)
      .set({
        last_injected_at: now,
        injection_count: sql`injection_count + 1`,
        ...(outcome === "overridden"
          ? { override_count: sql`override_count + 1` }
          : {}),
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

// --- Helpers ---

function rowToMemory(row: MemoryRow): MemoryItem {
  const evidence =
    typeof row.evidence === "string"
      ? JSON.parse(row.evidence as string)
      : Array.isArray(row.evidence)
        ? row.evidence
        : [];
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
    supersedes: row.supersedes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_validated_at: row.last_validated_at,
    last_injected_at: row.last_injected_at,
    injection_count: row.injection_count,
    override_count: row.override_count,
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

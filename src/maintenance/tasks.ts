import { and, desc, eq, gt, inArray, lt, or, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RecallDb } from "../db/client.js";
import {
  activityEvents,
  historySnippets,
  memories,
  memoryMaintenanceTasks,
} from "../db/schema.js";
import {
  findSemanticDuplicates,
  loadEmbeddingConfigFromEnv,
} from "../embeddings/embeddings.js";
import { ApplyError, applyTaskResult } from "./appliers.js";
import type {
  MaintenanceTask,
  MaintenanceTaskKind,
  MaintenanceTaskStatus,
} from "../types.js";

const OPEN_STATUSES: MaintenanceTaskStatus[] = ["pending", "claimed", "submitted"];
const ACTIVE_STATUSES: MaintenanceTaskStatus[] = [...OPEN_STATUSES, "completed"];

const DEFAULT_LEASE_SECONDS = 600;

export const DEFAULT_PRIORITIES: Record<MaintenanceTaskKind, number> = {
  // extract_rules_from_prompt runs at higher priority than verify_capture
  // because it is the primary capture path when an LLM provider is
  // configured — its output IS the candidate creation. Without it, real
  // rules never enter the queue at all.
  extract_rules_from_prompt: 14,
  verify_capture: 12,
  refine_candidate: 10,
  merge_duplicates: 8,
  summarize_history: 5,
  summarize_session: 3,
  synthesize_repo: 1,
};

export interface EnqueueConfig {
  max_pending: number;
  max_per_kind: number;
  refine_min_repetition: number;
  summary_max_age_days: number;
  merge_similarity_threshold: number;
  session_min_activity_events: number;
  repo_synthesis_min_memories: number;
  repo_synthesis_refresh_days: number;
}

export const DEFAULT_ENQUEUE_CONFIG: EnqueueConfig = {
  max_pending: 50,
  max_per_kind: 10,
  refine_min_repetition: 1,
  summary_max_age_days: 7,
  merge_similarity_threshold: 0.9,
  session_min_activity_events: 5,
  repo_synthesis_min_memories: 20,
  repo_synthesis_refresh_days: 30,
};

export interface EnqueueCounts {
  tasks_enqueued: number;
  per_kind: Partial<Record<MaintenanceTaskKind, number>>;
  expired_leases_swept: number;
  dropped_over_cap: number;
  expired_pending_tasks: number;
}

type TaskRow = typeof memoryMaintenanceTasks.$inferSelect;

function rowToTask(row: TaskRow): MaintenanceTask {
  return {
    id: row.id,
    kind: row.kind as MaintenanceTaskKind,
    status: row.status as MaintenanceTaskStatus,
    priority: row.priority,
    repo: row.repo,
    target_key: row.target_key,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    result: (row.result ?? null) as Record<string, unknown> | null,
    failure_reason: row.failure_reason,
    claimed_by: row.claimed_by,
    claimed_at: row.claimed_at,
    claim_expires_at: row.claim_expires_at,
    submitted_at: row.submitted_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
  };
}

export function targetKey(kind: MaintenanceTaskKind, target: string): string {
  return `${kind}:${target}`;
}

export function hasActiveTaskForTarget(
  db: RecallDb,
  kind: MaintenanceTaskKind,
  target: string,
): boolean {
  const row = db.select({ id: memoryMaintenanceTasks.id })
    .from(memoryMaintenanceTasks)
    .where(and(
      eq(memoryMaintenanceTasks.kind, kind),
      eq(memoryMaintenanceTasks.target_key, targetKey(kind, target)),
      inArray(memoryMaintenanceTasks.status, ACTIVE_STATUSES),
    ))
    .limit(1)
    .get();
  return Boolean(row);
}

export interface InsertTaskInput {
  kind: MaintenanceTaskKind;
  target: string;
  repo?: string | null;
  payload: Record<string, unknown>;
  priority?: number;
  max_attempts?: number;
}

export function insertTaskIdempotent(
  db: RecallDb,
  input: InsertTaskInput,
): string | null {
  if (hasActiveTaskForTarget(db, input.kind, input.target)) return null;
  const id = randomUUID();
  db.insert(memoryMaintenanceTasks).values({
    id,
    kind: input.kind,
    status: "pending",
    priority: input.priority ?? DEFAULT_PRIORITIES[input.kind] ?? 0,
    repo: input.repo ?? null,
    target_key: targetKey(input.kind, input.target),
    payload: input.payload as any,
    result: null,
    failure_reason: null,
    claimed_by: null,
    claimed_at: null,
    claim_expires_at: null,
    submitted_at: null,
    completed_at: null,
    created_at: new Date().toISOString(),
    attempts: 0,
    max_attempts: input.max_attempts ?? 3,
  }).run();
  return id;
}

export function deleteTask(db: RecallDb, id: string): boolean {
  const result = db.delete(memoryMaintenanceTasks)
    .where(eq(memoryMaintenanceTasks.id, id))
    .run();
  return result.changes > 0;
}

export interface TaskStats {
  total: number;
  by_status: Record<MaintenanceTaskStatus, number>;
  by_kind: Record<MaintenanceTaskKind, number>;
  by_kind_status: Record<string, number>;
  pending_oldest_created_at: string | null;
  completed_last_24h: number;
  abandoned_last_24h: number;
  mean_completion_ms: number | null;
}

export function getTaskStats(db: RecallDb): TaskStats {
  const rows = db.select().from(memoryMaintenanceTasks).all();

  const by_status = { pending: 0, claimed: 0, submitted: 0, completed: 0, abandoned: 0 } as Record<MaintenanceTaskStatus, number>;
  const by_kind = { verify_capture: 0, refine_candidate: 0, merge_duplicates: 0, summarize_history: 0, summarize_session: 0, synthesize_repo: 0, extract_rules_from_prompt: 0 } as Record<MaintenanceTaskKind, number>;
  const by_kind_status: Record<string, number> = {};

  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  let completed_last_24h = 0;
  let abandoned_last_24h = 0;
  let pending_oldest: string | null = null;
  let completionDurations: number[] = [];

  for (const row of rows) {
    by_status[row.status as MaintenanceTaskStatus] += 1;
    by_kind[row.kind as MaintenanceTaskKind] += 1;
    const key = `${row.kind}:${row.status}`;
    by_kind_status[key] = (by_kind_status[key] ?? 0) + 1;

    if (row.status === "pending") {
      if (!pending_oldest || row.created_at < pending_oldest) pending_oldest = row.created_at;
    }
    if (row.completed_at && row.completed_at >= dayAgo) {
      if (row.status === "completed") completed_last_24h += 1;
      if (row.status === "abandoned") abandoned_last_24h += 1;
    }
    if (row.status === "completed" && row.completed_at) {
      const delta = new Date(row.completed_at).getTime() - new Date(row.created_at).getTime();
      if (Number.isFinite(delta) && delta >= 0) completionDurations.push(delta);
    }
  }

  const mean_completion_ms = completionDurations.length
    ? completionDurations.reduce((a, b) => a + b, 0) / completionDurations.length
    : null;

  return {
    total: rows.length,
    by_status,
    by_kind,
    by_kind_status,
    pending_oldest_created_at: pending_oldest,
    completed_last_24h,
    abandoned_last_24h,
    mean_completion_ms,
  };
}

export function getTask(db: RecallDb, id: string): MaintenanceTask | undefined {
  const row = db.select().from(memoryMaintenanceTasks)
    .where(eq(memoryMaintenanceTasks.id, id))
    .get();
  return row ? rowToTask(row) : undefined;
}

export interface ListTasksQuery {
  status?: MaintenanceTaskStatus | MaintenanceTaskStatus[];
  kinds?: MaintenanceTaskKind[];
  repo?: string;
  limit?: number;
}

export function listTasks(db: RecallDb, query: ListTasksQuery = {}): MaintenanceTask[] {
  const conditions = [];
  if (query.status) {
    const statuses = Array.isArray(query.status) ? query.status : [query.status];
    conditions.push(inArray(memoryMaintenanceTasks.status, statuses));
  }
  if (query.kinds?.length) {
    conditions.push(inArray(memoryMaintenanceTasks.kind, query.kinds));
  }
  if (query.repo) {
    conditions.push(eq(memoryMaintenanceTasks.repo, query.repo));
  }

  let stmt = db.select().from(memoryMaintenanceTasks).$dynamic();
  if (conditions.length) stmt = stmt.where(and(...conditions));
  stmt = stmt
    .orderBy(sql`${memoryMaintenanceTasks.priority} DESC`, memoryMaintenanceTasks.created_at)
    .limit(query.limit ?? 50);
  return stmt.all().map(rowToTask);
}

export function sweepExpiredLeases(db: RecallDb, now: Date = new Date()): number {
  const nowIso = now.toISOString();
  const result = db.update(memoryMaintenanceTasks)
    .set({
      status: "pending",
      claimed_by: null,
      claimed_at: null,
      claim_expires_at: null,
      attempts: sql`${memoryMaintenanceTasks.attempts} + 1`,
    })
    .where(and(
      eq(memoryMaintenanceTasks.status, "claimed"),
      lt(memoryMaintenanceTasks.claim_expires_at, nowIso),
    ))
    .run();
  return result.changes;
}

/**
 * Abandon pending tasks that have been waiting longer than `maxAgeDays`. The
 * usual cause is that no LLM provider is configured, so the dispatcher never
 * picked them up. Stale source data makes the eventual run useless anyway.
 */
export function expireStalePendingTasks(
  db: RecallDb,
  maxAgeDays: number,
  now: Date = new Date(),
): number {
  const cutoff = new Date(now.getTime() - maxAgeDays * 86_400_000).toISOString();
  const result = db.update(memoryMaintenanceTasks)
    .set({
      status: "abandoned",
      failure_reason: "expired_no_dispatcher",
      completed_at: now.toISOString(),
    })
    .where(and(
      eq(memoryMaintenanceTasks.status, "pending"),
      lt(memoryMaintenanceTasks.created_at, cutoff),
    ))
    .run();
  return result.changes;
}

export function abandonOverAttemptTasks(db: RecallDb): number {
  const nowIso = new Date().toISOString();
  const result = db.update(memoryMaintenanceTasks)
    .set({
      status: "abandoned",
      failure_reason: "max_attempts_exceeded",
      completed_at: nowIso,
    })
    .where(and(
      inArray(memoryMaintenanceTasks.status, ["pending", "claimed"] as MaintenanceTaskStatus[]),
      sql`${memoryMaintenanceTasks.attempts} >= ${memoryMaintenanceTasks.max_attempts}`,
    ))
    .run();
  return result.changes;
}

export function applyBacklogCaps(
  db: RecallDb,
  config: Pick<EnqueueConfig, "max_pending" | "max_per_kind">,
): number {
  let dropped = 0;

  const overKindRows = db.select({
    kind: memoryMaintenanceTasks.kind,
    count: sql<number>`count(*)`.as("count"),
  })
    .from(memoryMaintenanceTasks)
    .where(eq(memoryMaintenanceTasks.status, "pending"))
    .groupBy(memoryMaintenanceTasks.kind)
    .all();

  for (const { kind, count } of overKindRows) {
    if (count <= config.max_per_kind) continue;
    const toDrop = count - config.max_per_kind;
    dropped += dropLowestPriorityPending(db, toDrop, { kind: kind as MaintenanceTaskKind });
  }

  const pendingCount = db.select({ n: sql<number>`count(*)` })
    .from(memoryMaintenanceTasks)
    .where(eq(memoryMaintenanceTasks.status, "pending"))
    .get()?.n ?? 0;

  if (pendingCount > config.max_pending) {
    dropped += dropLowestPriorityPending(db, pendingCount - config.max_pending);
  }

  return dropped;
}

function dropLowestPriorityPending(
  db: RecallDb,
  limit: number,
  filter: { kind?: MaintenanceTaskKind } = {},
): number {
  const conditions = [eq(memoryMaintenanceTasks.status, "pending")];
  if (filter.kind) conditions.push(eq(memoryMaintenanceTasks.kind, filter.kind));

  const ids = db.select({ id: memoryMaintenanceTasks.id })
    .from(memoryMaintenanceTasks)
    .where(and(...conditions))
    .orderBy(memoryMaintenanceTasks.priority, sql`${memoryMaintenanceTasks.created_at} DESC`)
    .limit(limit)
    .all()
    .map((r) => r.id);

  if (!ids.length) return 0;

  const result = db.delete(memoryMaintenanceTasks)
    .where(inArray(memoryMaintenanceTasks.id, ids))
    .run();
  return result.changes;
}

// --- Producers ---

// LLM-primary capture enqueue: when a provider is configured, the prompt
// hook hands the raw user prompt to the LLM for extraction instead of the
// regex extractor. The LLM returns zero or more rules; the applier creates
// candidate memories from them. Idempotent on (kind, target_key) so a
// retried hook doesn't double-enqueue.
export function enqueueExtractRulesFromPrompt(
  db: RecallDb,
  payload: {
    prompt_id: string;
    raw_prompt: string;
    repo: string | null;
    path: string | null;
    agent: string | null;
    session_id: string;
    prev_assistant_turn?: string | null;
    recent_tool_calls?: unknown;
  },
): string | null {
  return insertTaskIdempotent(db, {
    kind: "extract_rules_from_prompt",
    target: payload.prompt_id,
    repo: payload.repo,
    payload: {
      prompt_id: payload.prompt_id,
      raw_prompt: payload.raw_prompt,
      repo: payload.repo,
      path: payload.path,
      agent: payload.agent,
      session_id: payload.session_id,
      prev_assistant_turn: payload.prev_assistant_turn ?? null,
      recent_tool_calls: payload.recent_tool_calls ?? null,
    },
  });
}

// Inline enqueue used by capture: every newly-created candidate gets a
// verify_capture task so the LLM (when configured) can second-guess the
// heuristics before the candidate accumulates evidence.
export function enqueueVerifyCapture(
  db: RecallDb,
  memory: { id: string; text: string; scope: string; path_scope: string | null; repo: string | null; capture_context: unknown },
): string | null {
  return insertTaskIdempotent(db, {
    kind: "verify_capture",
    target: memory.id,
    repo: memory.repo,
    payload: {
      memory_id: memory.id,
      text: memory.text,
      inferred_scope: memory.scope,
      inferred_path_scope: memory.path_scope,
      repo: memory.repo,
      capture_context: memory.capture_context ?? null,
    },
  });
}

export function produceRefineCandidateTasks(
  db: RecallDb,
  config: Pick<EnqueueConfig, "refine_min_repetition">,
): number {
  const candidates = db.select().from(memories)
    .where(and(
      eq(memories.status, "candidate"),
      or(eq(memories.scope, "repo"), isNull(memories.path_scope)),
    ))
    .all();

  let enqueued = 0;
  for (const row of candidates) {
    if (row.repetition_count < config.refine_min_repetition) continue;
    if (!row.repo) continue;

    const id = insertTaskIdempotent(db, {
      kind: "refine_candidate",
      target: row.id,
      repo: row.repo,
      payload: {
        memory_id: row.id,
        text: row.text,
        current_scope: row.scope,
        current_path_scope: row.path_scope,
        repo: row.repo,
        capture_context: row.capture_context ?? null,
        repetition_count: row.repetition_count,
      },
    });
    if (id) enqueued += 1;
  }
  return enqueued;
}

export function produceSummarizeHistoryTasks(
  db: RecallDb,
  config: Pick<EnqueueConfig, "summary_max_age_days">,
): number {
  const cutoff = new Date(Date.now() - config.summary_max_age_days * 86_400_000).toISOString();

  const snippets = db.select().from(historySnippets)
    .where(sql`${historySnippets.created_at} >= ${cutoff}`)
    .all();

  let enqueued = 0;
  for (const snippet of snippets) {
    if (!snippetHasMeaningfulContent(snippet.text)) continue;
    const id = insertTaskIdempotent(db, {
      kind: "summarize_history",
      target: snippet.id,
      repo: snippet.repo ?? null,
      payload: {
        snippet_id: snippet.id,
        kind: snippet.kind,
        repo: snippet.repo,
        session_id: snippet.session_id,
        current_text: snippet.text,
        source_activity_ids: snippet.source_activity_ids,
      },
    });
    if (id) enqueued += 1;
  }
  return enqueued;
}

// A deterministic summary of "Repo: X\nEvent types: Y" with no corrections,
// reviews, or compile markers has nothing an LLM can usefully tighten.
// Skip enqueueing — otherwise the dispatcher burns tokens to rewrite the
// same content into a near-identical paraphrase. See
// src/maintenance/lifecycle.ts::summarizeSessionEvents for the markers.
export function snippetHasMeaningfulContent(text: string): boolean {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  return lines.some((line) =>
    line.startsWith("Corrections:") ||
    line.startsWith("Reviews:") ||
    line.startsWith("Latest compile included") ||
    line.startsWith("Prompts:"),
  );
}

export async function produceMergeDuplicateTasks(
  db: RecallDb,
  config: Pick<EnqueueConfig, "merge_similarity_threshold">,
): Promise<number> {
  const embeddingConfig = loadEmbeddingConfigFromEnv();
  if (!embeddingConfig) return 0;

  const activeMemories = db.select().from(memories)
    .where(eq(memories.status, "active"))
    .all();

  const visited = new Set<string>();
  let enqueued = 0;

  for (const mem of activeMemories) {
    if (visited.has(mem.id)) continue;
    if (!mem.repo) continue;

    // Commands often differ only in punctuation/backticks ("test: vitest run"
    // vs "test: `vitest run`"), so cosine similarity at the default 0.9 misses
    // them. Lower the bar to 0.85 for commands; rules stay strict.
    const threshold = mem.type === "command"
      ? Math.min(config.merge_similarity_threshold, 0.85)
      : config.merge_similarity_threshold;

    const duplicates = await findSemanticDuplicates(
      db,
      mem.text,
      embeddingConfig,
      threshold,
      { repo: mem.repo, type: mem.type, limit: 10 },
    );

    // Strip the memory itself from the duplicate list.
    const peers = duplicates.filter((d) => d.id !== mem.id);
    if (peers.length === 0) continue;

    const cluster = [mem.id, ...peers.map((p) => p.id)].sort();
    // Dedupe symmetric clusters: only act from the anchor.
    if (cluster[0] !== mem.id) {
      for (const id of cluster) visited.add(id);
      continue;
    }

    const clusterRows = db.select().from(memories)
      .where(inArray(memories.id, cluster))
      .all();

    const candidates = clusterRows.map((row) => ({
      id: row.id,
      text: row.text,
      scope: row.scope,
      path_scope: row.path_scope,
      confidence: row.confidence,
    }));

    const id = insertTaskIdempotent(db, {
      kind: "merge_duplicates",
      target: cluster[0],
      repo: mem.repo,
      payload: {
        repo: mem.repo,
        type: mem.type,
        candidates,
      },
    });
    if (id) enqueued += 1;
    for (const memberId of cluster) visited.add(memberId);
  }

  return enqueued;
}

export function produceSummarizeSessionTasks(
  db: RecallDb,
  config: Pick<EnqueueConfig, "session_min_activity_events" | "summary_max_age_days">,
): number {
  const cutoff = new Date(Date.now() - config.summary_max_age_days * 86_400_000).toISOString();

  const sessionEnds = db.select().from(activityEvents)
    .where(and(
      eq(activityEvents.event_type, "session_end"),
      gt(activityEvents.created_at, cutoff),
    ))
    .orderBy(desc(activityEvents.created_at))
    .all();

  let enqueued = 0;
  for (const end of sessionEnds) {
    if (!end.session_id) continue;

    const events = db.select().from(activityEvents)
      .where(eq(activityEvents.session_id, end.session_id))
      .all();
    if (events.length < config.session_min_activity_events) continue;

    const existing = db.select().from(historySnippets)
      .where(and(
        eq(historySnippets.session_id, end.session_id),
        eq(historySnippets.kind, "session_summary"),
      ))
      .get();
    if (existing) continue;

    const repo = end.repo ?? events.find((e) => e.repo)?.repo ?? null;
    const eventTypes = [...new Set(events.map((e) => e.event_type))];

    const id = insertTaskIdempotent(db, {
      kind: "summarize_session",
      target: end.session_id,
      repo,
      payload: {
        session_id: end.session_id,
        repo,
        event_count: events.length,
        event_types: eventTypes,
        source_activity_ids: events.map((e) => e.id),
      },
    });
    if (id) enqueued += 1;
  }

  return enqueued;
}

export function produceSynthesizeRepoTasks(
  db: RecallDb,
  config: Pick<EnqueueConfig, "repo_synthesis_min_memories" | "repo_synthesis_refresh_days">,
): number {
  const rows = db.select({
    repo: memories.repo,
    count: sql<number>`count(*)`.as("count"),
  })
    .from(memories)
    .where(eq(memories.status, "active"))
    .groupBy(memories.repo)
    .all();

  const cutoff = new Date(Date.now() - config.repo_synthesis_refresh_days * 86_400_000).toISOString();
  let enqueued = 0;

  for (const { repo, count } of rows) {
    if (!repo) continue;
    if (count < config.repo_synthesis_min_memories) continue;

    const recent = db.select().from(historySnippets)
      .where(and(
        eq(historySnippets.repo, repo),
        eq(historySnippets.kind, "repo_synthesis"),
        gt(historySnippets.updated_at, cutoff),
      ))
      .get();
    if (recent) continue;

    const topMemories = db.select().from(memories)
      .where(and(
        eq(memories.repo, repo),
        eq(memories.status, "active"),
      ))
      .orderBy(desc(memories.confidence))
      .limit(20)
      .all()
      .map((row) => ({
        id: row.id,
        text: row.text,
        type: row.type,
        scope: row.scope,
        confidence: row.confidence,
      }));

    const id = insertTaskIdempotent(db, {
      kind: "synthesize_repo",
      target: repo,
      repo,
      payload: {
        repo,
        memory_count: count,
        top_memories: topMemories,
      },
    });
    if (id) enqueued += 1;
  }

  return enqueued;
}

// --- Orchestrator ---

export async function enqueueMaintenanceTasks(
  db: RecallDb,
  config: EnqueueConfig = DEFAULT_ENQUEUE_CONFIG,
): Promise<EnqueueCounts> {
  const expired = sweepExpiredLeases(db);
  abandonOverAttemptTasks(db);
  // Tasks older than 2x the summary window are almost certainly stuck because
  // no LLM provider is configured. Abandon them so the queue stays interpretable.
  const expiredPending = expireStalePendingTasks(db, config.summary_max_age_days * 2);

  const counts: Partial<Record<MaintenanceTaskKind, number>> = {};
  counts.refine_candidate = produceRefineCandidateTasks(db, config);
  counts.summarize_history = produceSummarizeHistoryTasks(db, config);
  counts.summarize_session = produceSummarizeSessionTasks(db, config);
  counts.synthesize_repo = produceSynthesizeRepoTasks(db, config);
  counts.merge_duplicates = await produceMergeDuplicateTasks(db, config);

  const dropped = applyBacklogCaps(db, config);

  const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);

  return {
    tasks_enqueued: total,
    per_kind: counts,
    expired_leases_swept: expired,
    dropped_over_cap: dropped,
    expired_pending_tasks: expiredPending,
  };
}

export { DEFAULT_LEASE_SECONDS };

// --- Peek / Claim / Submit / Release ---

const MemoryScope = z.enum(["session", "path", "repo", "team", "global"]);

const RefineCandidateResult = z.object({
  refined_text: z.string().min(1).max(4000),
  scope: MemoryScope,
  path_scope: z.string().max(512).nullable().optional(),
  rationale: z.string().max(2000).optional(),
  // Optional verdict — when present, the LLM may also reject a re-captured
  // fragment instead of refining it. Backwards-compatible: omitted means
  // "rewrite" (legacy refine behavior).
  verdict: z.enum(["rewrite", "reject"]).optional(),
});

const VerifyCaptureResult = z.object({
  verdict: z.enum(["save", "rewrite", "reject"]),
  cleaned_text: z.string().min(1).max(4000).optional(),
  scope: MemoryScope.optional(),
  path_scope: z.string().max(512).nullable().optional(),
  is_destructive_risky: z.boolean().optional(),
  reason: z.string().max(2000).optional(),
});

const SummarizeHistoryResult = z.object({
  summary_text: z.string().min(1).max(4000),
  tags: z.array(z.string().max(64)).max(20).optional(),
});

const MergeDuplicatesResult = z.object({
  winner_id: z.string().uuid(),
  winner_text: z.string().min(1).max(4000).optional(),
  winner_scope: MemoryScope.optional(),
  winner_path_scope: z.string().max(512).nullable().optional(),
  rationale: z.string().max(2000).optional(),
});

const SummarizeSessionResult = z.object({
  summary_text: z.string().min(1).max(4000),
});

const SynthesizeRepoResult = z.object({
  summary_text: z.string().min(1).max(8000),
});

// LLM-primary capture: extract zero or more durable rules from a raw user
// prompt. Empty list = "no rule worth saving here." This is the schema the
// LLM commits to when it judges the prompt instead of the regex extractor.
const ExtractedRule = z.object({
  text: z.string().min(1).max(2000),
  type: z.enum(["rule", "decision", "review_pattern", "command", "gotcha"]),
  scope: MemoryScope,
  path_scope: z.string().max(512).nullable().optional(),
  confidence: z.number().min(0).max(1),
  is_destructive_risky: z.boolean().optional(),
  rationale: z.string().max(500).optional(),
});

const ExtractRulesFromPromptResult = z.object({
  rules: z.array(ExtractedRule).max(10),
  dropped_reason: z.string().max(500).optional(),
});

const RESULT_SCHEMAS: Record<MaintenanceTaskKind, z.ZodTypeAny> = {
  verify_capture: VerifyCaptureResult,
  refine_candidate: RefineCandidateResult,
  summarize_history: SummarizeHistoryResult,
  merge_duplicates: MergeDuplicatesResult,
  summarize_session: SummarizeSessionResult,
  synthesize_repo: SynthesizeRepoResult,
  extract_rules_from_prompt: ExtractRulesFromPromptResult,
};

export type RefineCandidateResult = z.infer<typeof RefineCandidateResult>;
export type VerifyCaptureResult = z.infer<typeof VerifyCaptureResult>;
export type SummarizeHistoryResult = z.infer<typeof SummarizeHistoryResult>;
export type MergeDuplicatesResult = z.infer<typeof MergeDuplicatesResult>;
export type SummarizeSessionResult = z.infer<typeof SummarizeSessionResult>;
export type SynthesizeRepoResult = z.infer<typeof SynthesizeRepoResult>;
export type ExtractedRule = z.infer<typeof ExtractedRule>;
export type ExtractRulesFromPromptResult = z.infer<typeof ExtractRulesFromPromptResult>;

export interface PeekOptions {
  repo?: string;
  kinds?: MaintenanceTaskKind[];
  limit?: number;
}

export interface PeekedTask {
  id: string;
  kind: MaintenanceTaskKind;
  priority: number;
  repo: string | null;
  created_at: string;
  payload_summary: Record<string, unknown>;
}

function payloadSummary(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === "string") {
      out[k] = v.length > 160 ? `${v.slice(0, 157)}...` : v;
    } else if (Array.isArray(v)) {
      out[k] = `array(${v.length})`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function peekTasks(db: RecallDb, options: PeekOptions = {}): PeekedTask[] {
  const tasks = listTasks(db, {
    status: "pending",
    repo: options.repo,
    kinds: options.kinds,
    limit: Math.min(options.limit ?? 3, 10),
  });
  return tasks.map((t) => ({
    id: t.id,
    kind: t.kind,
    priority: t.priority,
    repo: t.repo,
    created_at: t.created_at,
    payload_summary: payloadSummary(t.payload),
  }));
}

export interface ClaimResult {
  task: MaintenanceTask;
  lease_expires_at: string;
}

export class TaskClaimConflictError extends Error {
  constructor(public readonly taskId: string, public readonly reason: "not-pending" | "not-found") {
    super(`Task ${taskId} cannot be claimed: ${reason}`);
    this.name = "TaskClaimConflictError";
  }
}

export function claimTask(
  db: RecallDb,
  taskId: string,
  agent: string,
  leaseSeconds: number = DEFAULT_LEASE_SECONDS,
): ClaimResult {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const nowIso = now.toISOString();

  const result = db.update(memoryMaintenanceTasks)
    .set({
      status: "claimed",
      claimed_by: agent,
      claimed_at: nowIso,
      claim_expires_at: expiresAt,
    })
    .where(and(
      eq(memoryMaintenanceTasks.id, taskId),
      eq(memoryMaintenanceTasks.status, "pending"),
    ))
    .run();

  if (result.changes === 0) {
    const existing = getTask(db, taskId);
    throw new TaskClaimConflictError(taskId, existing ? "not-pending" : "not-found");
  }

  const task = getTask(db, taskId)!;
  return { task, lease_expires_at: expiresAt };
}

export interface SubmitOk {
  status: "applied";
  task_id: string;
  kind: MaintenanceTaskKind;
  target_id: string;
  changed_fields: string[];
  audit_entry_id: string | null;
}

export interface SubmitRejected {
  status: "rejected";
  task_id: string;
  reason: string;
  attempts: number;
  abandoned: boolean;
}

export type SubmitResult = SubmitOk | SubmitRejected;

export function submitTask(
  db: RecallDb,
  taskId: string,
  agent: string,
  result: unknown,
): SubmitResult {
  const existing = getTask(db, taskId);
  if (!existing) return { status: "rejected", task_id: taskId, reason: "not-found", attempts: 0, abandoned: false };
  if (existing.status !== "claimed") {
    return { status: "rejected", task_id: taskId, reason: `not-claimed (status=${existing.status})`, attempts: existing.attempts, abandoned: false };
  }
  if (existing.claimed_by !== agent) {
    return { status: "rejected", task_id: taskId, reason: "not-claim-holder", attempts: existing.attempts, abandoned: false };
  }

  const schema = RESULT_SCHEMAS[existing.kind];
  const parsed = schema.safeParse(result);
  if (!parsed.success) {
    const attempts = existing.attempts + 1;
    const abandoned = attempts >= existing.max_attempts;
    const now = new Date().toISOString();
    db.update(memoryMaintenanceTasks)
      .set({
        status: abandoned ? "abandoned" : "pending",
        claimed_by: null,
        claimed_at: null,
        claim_expires_at: null,
        attempts,
        failure_reason: parsed.error.issues.map((i) => `${i.path.join(".")}:${i.message}`).join("; ").slice(0, 500),
        completed_at: abandoned ? now : null,
      })
      .where(eq(memoryMaintenanceTasks.id, taskId))
      .run();
    return {
      status: "rejected",
      task_id: taskId,
      reason: `validation-failed: ${parsed.error.issues[0]?.message ?? "shape mismatch"}`,
      attempts,
      abandoned,
    };
  }

  let applyOutcome;
  try {
    applyOutcome = applyTaskResult(db, existing, parsed.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = existing.attempts + 1;
    const code = err instanceof ApplyError ? err.code : "apply-error";
    // target-missing, invalid-state, and unsupported-kind are unfixable from
    // the same payload — abandon immediately rather than waste retries.
    const abandoned = code === "target-missing"
      || code === "invalid-state"
      || code === "unsupported-kind"
      || attempts >= existing.max_attempts;
    const now = new Date().toISOString();
    db.update(memoryMaintenanceTasks)
      .set({
        status: abandoned ? "abandoned" : "pending",
        claimed_by: null,
        claimed_at: null,
        claim_expires_at: null,
        attempts,
        failure_reason: `apply-failed: ${message}`.slice(0, 500),
        completed_at: abandoned ? now : null,
      })
      .where(eq(memoryMaintenanceTasks.id, taskId))
      .run();
    return {
      status: "rejected",
      task_id: taskId,
      reason: `apply-failed: ${message}`,
      attempts,
      abandoned,
    };
  }

  const now = new Date().toISOString();
  db.update(memoryMaintenanceTasks)
    .set({
      status: "completed",
      result: parsed.data as any,
      submitted_at: now,
      completed_at: now,
      failure_reason: null,
    })
    .where(eq(memoryMaintenanceTasks.id, taskId))
    .run();

  return {
    status: "applied",
    task_id: taskId,
    kind: existing.kind,
    target_id: applyOutcome.target_id,
    changed_fields: applyOutcome.changed_fields,
    audit_entry_id: applyOutcome.audit_entry_id,
  };
}

export interface ReleaseResult {
  status: "released" | "not-claimed" | "not-found";
}

export function releaseTask(
  db: RecallDb,
  taskId: string,
  agent: string,
  reason?: string,
): ReleaseResult {
  const existing = getTask(db, taskId);
  if (!existing) return { status: "not-found" };
  if (existing.status !== "claimed" || existing.claimed_by !== agent) {
    return { status: "not-claimed" };
  }
  db.update(memoryMaintenanceTasks)
    .set({
      status: "pending",
      claimed_by: null,
      claimed_at: null,
      claim_expires_at: null,
      failure_reason: reason ? reason.slice(0, 500) : null,
    })
    .where(eq(memoryMaintenanceTasks.id, taskId))
    .run();
  return { status: "released" };
}

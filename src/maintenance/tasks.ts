import { and, eq, inArray, lt, or, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RecallDb } from "../db/client.js";
import { memoryMaintenanceTasks, memories, historySnippets } from "../db/schema.js";
import type {
  MaintenanceTask,
  MaintenanceTaskKind,
  MaintenanceTaskStatus,
} from "../types.js";

const OPEN_STATUSES: MaintenanceTaskStatus[] = ["pending", "claimed", "submitted"];
const ACTIVE_STATUSES: MaintenanceTaskStatus[] = [...OPEN_STATUSES, "completed"];

const DEFAULT_LEASE_SECONDS = 600;

export const DEFAULT_PRIORITIES: Record<MaintenanceTaskKind, number> = {
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
}

export const DEFAULT_ENQUEUE_CONFIG: EnqueueConfig = {
  max_pending: 50,
  max_per_kind: 10,
  refine_min_repetition: 1,
  summary_max_age_days: 7,
};

export interface EnqueueCounts {
  tasks_enqueued: number;
  per_kind: Partial<Record<MaintenanceTaskKind, number>>;
  expired_leases_swept: number;
  dropped_over_cap: number;
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

// --- Orchestrator ---

export function enqueueMaintenanceTasks(
  db: RecallDb,
  config: EnqueueConfig = DEFAULT_ENQUEUE_CONFIG,
): EnqueueCounts {
  const expired = sweepExpiredLeases(db);
  abandonOverAttemptTasks(db);

  const counts: Partial<Record<MaintenanceTaskKind, number>> = {};
  counts.refine_candidate = produceRefineCandidateTasks(db, config);
  counts.summarize_history = produceSummarizeHistoryTasks(db, config);

  const dropped = applyBacklogCaps(db, config);

  const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);

  return {
    tasks_enqueued: total,
    per_kind: counts,
    expired_leases_swept: expired,
    dropped_over_cap: dropped,
  };
}

export { DEFAULT_LEASE_SECONDS };

// --- Peek / Claim / Submit / Release ---

const MemoryScope = z.enum(["session", "path", "repo", "team"]);

const RefineCandidateResult = z.object({
  refined_text: z.string().min(1).max(4000),
  scope: MemoryScope,
  path_scope: z.string().max(512).nullable().optional(),
  rationale: z.string().max(2000).optional(),
});

const SummarizeHistoryResult = z.object({
  summary_text: z.string().min(1).max(4000),
  tags: z.array(z.string().max(64)).max(20).optional(),
});

const MergeDuplicatesResult = z.object({
  winner_text: z.string().min(1).max(4000),
  winner_scope: MemoryScope,
  winner_path_scope: z.string().max(512).nullable().optional(),
  merged_ids: z.array(z.string().uuid()).min(1),
  rationale: z.string().max(2000).optional(),
});

const SummarizeSessionResult = z.object({
  summary_text: z.string().min(1).max(4000),
});

const SynthesizeRepoResult = z.object({
  summary_text: z.string().min(1).max(8000),
});

const RESULT_SCHEMAS: Record<MaintenanceTaskKind, z.ZodTypeAny> = {
  refine_candidate: RefineCandidateResult,
  summarize_history: SummarizeHistoryResult,
  merge_duplicates: MergeDuplicatesResult,
  summarize_session: SummarizeSessionResult,
  synthesize_repo: SynthesizeRepoResult,
};

export type RefineCandidateResult = z.infer<typeof RefineCandidateResult>;
export type SummarizeHistoryResult = z.infer<typeof SummarizeHistoryResult>;
export type MergeDuplicatesResult = z.infer<typeof MergeDuplicatesResult>;
export type SummarizeSessionResult = z.infer<typeof SummarizeSessionResult>;
export type SynthesizeRepoResult = z.infer<typeof SynthesizeRepoResult>;

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

  // Phase 2: accept and mark completed without applying effects. Phase 3 will
  // insert effect application before this status flip.
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

  return { status: "applied", task_id: taskId, kind: existing.kind };
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

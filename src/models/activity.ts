import { and, desc, eq, gte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { activityEvents } from "../db/schema.js";
import { activityEventDedupeKey } from "./dedupe.js";
import type {
  ActivityEvent,
  ActivityEventQuery,
  ActivityEventType,
  ActivitySource,
} from "../types.js";
import { redactSensitiveValue } from "../security/redaction.js";

type ActivityRow = typeof activityEvents.$inferSelect;

export interface CreateActivityEventInput {
  session_id?: string | null;
  repo?: string | null;
  path?: string | null;
  source: ActivitySource;
  event_type: ActivityEventType;
  memory_ids?: string[];
  request?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export function createActivityEvent(
  db: RecallDb,
  input: CreateActivityEventInput,
): string {
  const safeInput = {
    ...input,
    request: redactSensitiveValue(input.request ?? {}),
    result: redactSensitiveValue(input.result ?? {}),
  };
  const dedupeKey = activityEventDedupeKey(safeInput);

  if (dedupeKey) {
    const existingId = findActivityEventByDedupeKey(db, dedupeKey);
    if (existingId) return existingId;
  } else {
    const fuzzyId = findRecentDuplicateActivityEvent(db, safeInput);
    if (fuzzyId) return fuzzyId;
  }

  const id = randomUUID();
  const result = db.insert(activityEvents)
    .values({
      id,
      session_id: safeInput.session_id ?? null,
      repo: safeInput.repo ?? null,
      path: safeInput.path ?? null,
      source: safeInput.source,
      event_type: safeInput.event_type,
      memory_ids: safeInput.memory_ids ?? [],
      dedupe_key: dedupeKey,
      request: safeInput.request,
      result: safeInput.result,
      created_at: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: activityEvents.dedupe_key })
    .run();

  if (Number(result.changes ?? 0) === 0 && dedupeKey) {
    const existingId = findActivityEventByDedupeKey(db, dedupeKey);
    if (existingId) return existingId;
  }
  return id;
}

function findActivityEventByDedupeKey(
  db: RecallDb,
  dedupeKey: string,
): string | null {
  const row = db
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .where(eq(activityEvents.dedupe_key, dedupeKey))
    .get();
  return row?.id ?? null;
}

function findRecentDuplicateActivityEvent(
  db: RecallDb,
  input: CreateActivityEventInput,
): string | null {
  if (!input.session_id) return null;

  const since = new Date(Date.now() - 2_000).toISOString();
  const rows = db.select().from(activityEvents)
    .where(and(
      eq(activityEvents.session_id, input.session_id),
      eq(activityEvents.source, input.source),
      eq(activityEvents.event_type, input.event_type),
      gte(activityEvents.created_at, since),
    ))
    .all();

  const requestKey = JSON.stringify(input.request ?? {});
  const resultKey = JSON.stringify(input.result ?? {});
  const repo = input.repo ?? null;
  const path = input.path ?? null;

  for (const row of rows) {
    if (row.repo !== repo || row.path !== path) continue;
    const request =
      typeof row.request === "string"
        ? JSON.parse(row.request)
        : row.request ?? {};
    const result =
      typeof row.result === "string"
        ? JSON.parse(row.result)
        : row.result ?? {};
    if (
      JSON.stringify(request) === requestKey &&
      JSON.stringify(result) === resultKey
    ) {
      return row.id;
    }
  }

  return null;
}

export function getActivityEvent(
  db: RecallDb,
  id: string,
): ActivityEvent | undefined {
  const row = db.select().from(activityEvents).where(eq(activityEvents.id, id)).get();
  return row ? rowToActivityEvent(row) : undefined;
}

export function listActivityEvents(
  db: RecallDb,
  query: ActivityEventQuery = {},
): ActivityEvent[] {
  const conditions = [];

  if (query.repo) conditions.push(eq(activityEvents.repo, query.repo));
  if (query.session_id) conditions.push(eq(activityEvents.session_id, query.session_id));
  if (query.source) conditions.push(eq(activityEvents.source, query.source));
  if (query.event_type) conditions.push(eq(activityEvents.event_type, query.event_type));
  if (query.since) conditions.push(gte(activityEvents.created_at, query.since));

  const offset = query.offset ?? 0;
  const limit = query.limit ?? 1000;
  const base = db.select().from(activityEvents);
  const ordered = conditions.length > 0
    ? base.where(and(...conditions)).orderBy(desc(activityEvents.created_at))
    : base.orderBy(desc(activityEvents.created_at));
  const rows = ordered.limit(limit).offset(offset).all();
  return rows.map(rowToActivityEvent);
}

export function listActivitySessions(
  db: RecallDb,
  query: Omit<ActivityEventQuery, "session_id"> & { limit?: number } = {},
): Array<{
  session_id: string;
  repo: string | null;
  event_count: number;
  event_types: ActivityEventType[];
  first_at: string;
  last_at: string;
}> {
  const events = listActivityEvents(db, query).filter((event) => event.session_id);
  const grouped = new Map<string, ActivityEvent[]>();

  for (const event of events) {
    const sessionId = event.session_id!;
    const bucket = grouped.get(sessionId) ?? [];
    bucket.push(event);
    grouped.set(sessionId, bucket);
  }

  const sessions = [...grouped.entries()].map(([session_id, items]) => {
    const sorted = [...items].sort((a, b) => a.created_at.localeCompare(b.created_at));
    return {
      session_id,
      repo: sorted[0]?.repo ?? null,
      event_count: items.length,
      event_types: [...new Set(items.map((item) => item.event_type))],
      first_at: sorted[0]!.created_at,
      last_at: sorted[sorted.length - 1]!.created_at,
    };
  });

  sessions.sort((a, b) => b.last_at.localeCompare(a.last_at));
  return query.limit ? sessions.slice(0, query.limit) : sessions;
}

function rowToActivityEvent(row: ActivityRow): ActivityEvent {
  const memory_ids =
    typeof row.memory_ids === "string"
      ? JSON.parse(row.memory_ids)
      : Array.isArray(row.memory_ids)
        ? row.memory_ids
        : [];
  const request =
    typeof row.request === "string"
      ? JSON.parse(row.request)
      : row.request ?? {};
  const result =
    typeof row.result === "string"
      ? JSON.parse(row.result)
      : row.result ?? {};

  return {
    id: row.id,
    session_id: row.session_id,
    repo: row.repo,
    path: row.path,
    source: row.source,
    event_type: row.event_type,
    memory_ids,
    request: request as Record<string, unknown>,
    result: result as Record<string, unknown>,
    created_at: row.created_at,
  };
}

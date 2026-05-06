import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { hookCalls } from "../db/schema.js";
import type { HookCall, HookCallEvent, HookCallStatsQuery, HookCallStatsRow } from "../types.js";

type HookCallRow = typeof hookCalls.$inferSelect;

export function recordHookCall(
  db: RecallDb,
  input: {
    event: HookCallEvent;
    agent: string;
    duration_ms: number;
    ok: boolean;
    dedupe_key?: string | null;
  },
): string {
  if (input.dedupe_key) {
    const existingId = findHookCallByDedupeKey(db, input.dedupe_key);
    if (existingId) return existingId;
  }

  const id = randomUUID();
  const result = db.insert(hookCalls)
    .values({
      id,
      event: input.event,
      agent: input.agent,
      dedupe_key: input.dedupe_key ?? null,
      duration_ms: Math.max(0, Math.round(input.duration_ms)),
      ok: input.ok,
      created_at: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: hookCalls.dedupe_key })
    .run();

  if (Number(result.changes ?? 0) === 0 && input.dedupe_key) {
    const existingId = findHookCallByDedupeKey(db, input.dedupe_key);
    if (existingId) return existingId;
  }
  return id;
}

function findHookCallByDedupeKey(db: RecallDb, dedupeKey: string): string | null {
  const row = db
    .select({ id: hookCalls.id })
    .from(hookCalls)
    .where(eq(hookCalls.dedupe_key, dedupeKey))
    .limit(1)
    .get();
  return row?.id ?? null;
}

export function listHookCalls(
  db: RecallDb,
  query: HookCallStatsQuery = {},
): HookCall[] {
  const conditions = [];
  if (query.agent) conditions.push(eq(hookCalls.agent, query.agent));
  if (query.event) conditions.push(eq(hookCalls.event, query.event));

  const base = db.select().from(hookCalls);
  const rows = conditions.length > 0
    ? base.where(and(...conditions)).orderBy(desc(hookCalls.created_at)).all()
    : base.orderBy(desc(hookCalls.created_at)).all();

  const limited = query.limit ? rows.slice(0, query.limit) : rows;
  return limited.map((row) => rowToHookCall(row));
}

export function getHookCallStats(
  db: RecallDb,
  query: HookCallStatsQuery = {},
): HookCallStatsRow[] {
  const conditions = [];
  if (query.agent) conditions.push(eq(hookCalls.agent, query.agent));
  if (query.event) conditions.push(eq(hookCalls.event, query.event));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = db
    .select({
      event: hookCalls.event,
      agent: hookCalls.agent,
      total_calls: sql<number>`count(*)`,
      ok_calls: sql<number>`sum(case when ${hookCalls.ok} = 1 then 1 else 0 end)`,
      error_calls: sql<number>`sum(case when ${hookCalls.ok} = 0 then 1 else 0 end)`,
      avg_duration_ms: sql<number>`avg(${hookCalls.duration_ms})`,
      max_duration_ms: sql<number>`max(${hookCalls.duration_ms})`,
      last_called_at: sql<string>`max(${hookCalls.created_at})`,
    })
    .from(hookCalls)
    .where(whereClause)
    .groupBy(hookCalls.event, hookCalls.agent)
    .orderBy(desc(sql`max(${hookCalls.created_at})`))
    .all();

  const limited = query.limit ? rows.slice(0, query.limit) : rows;
  return limited.map((row) => ({
    event: row.event,
    agent: row.agent,
    total_calls: Number(row.total_calls ?? 0),
    ok_calls: Number(row.ok_calls ?? 0),
    error_calls: Number(row.error_calls ?? 0),
    avg_duration_ms: Number(row.avg_duration_ms ?? 0),
    max_duration_ms: Number(row.max_duration_ms ?? 0),
    last_called_at: row.last_called_at,
  }));
}

function rowToHookCall(row: HookCallRow): HookCall {
  return {
    id: row.id,
    event: row.event,
    agent: row.agent,
    duration_ms: row.duration_ms,
    ok: row.ok,
    created_at: row.created_at,
  };
}

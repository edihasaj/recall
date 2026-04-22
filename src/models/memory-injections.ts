import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { memoryInjections } from "../db/schema.js";
import type { FeedbackOutcome, MemoryInjection, MemoryItem } from "../types.js";
import { getMemory } from "./memory.js";
import type { RecentToolCall } from "../agents/types.js";

type MemoryInjectionRow = typeof memoryInjections.$inferSelect;

export function recordMemoryInjections(
  db: RecallDb,
  input: {
    memory_ids: readonly string[];
    session_id?: string;
    repo?: string | null;
  },
): number {
  if (!input.session_id || input.memory_ids.length === 0) return 0;

  const injectedAt = new Date().toISOString();
  let inserted = 0;
  for (const memoryId of input.memory_ids) {
    const result = db.insert(memoryInjections)
      .values({
        id: randomUUID(),
        memory_id: memoryId,
        session_id: input.session_id,
        repo: input.repo ?? null,
        injected_at: injectedAt,
        outcome: null,
        outcome_at: null,
      })
      .onConflictDoNothing({
        target: [memoryInjections.memory_id, memoryInjections.session_id],
      })
      .run();
    inserted += Number(result.changes ?? 0);
  }

  return inserted;
}

export function listInjectedMemoryIdsForSession(
  db: RecallDb,
  sessionId: string,
): Set<string> {
  const rows = db.select({ memory_id: memoryInjections.memory_id })
    .from(memoryInjections)
    .where(eq(memoryInjections.session_id, sessionId))
    .all();
  return new Set(rows.map((row) => row.memory_id));
}

export function listPendingMemoryInjections(
  db: RecallDb,
  sessionId: string,
): Array<MemoryInjection & { memory: MemoryItem | null }> {
  const rows = db.select()
    .from(memoryInjections)
    .where(and(
      eq(memoryInjections.session_id, sessionId),
      isNull(memoryInjections.outcome),
    ))
    .orderBy(asc(memoryInjections.injected_at))
    .all();

  return rows.map((row) => ({
    ...rowToMemoryInjection(row),
    memory: getMemory(db, row.memory_id) ?? null,
  }));
}

export function resolveMemoryInjectionOutcome(
  db: RecallDb,
  memoryId: string,
  sessionId: string,
  outcome: FeedbackOutcome,
): boolean {
  const outcomeAt = new Date().toISOString();
  const result = db.update(memoryInjections)
    .set({
      outcome,
      outcome_at: outcomeAt,
    })
    .where(and(
      eq(memoryInjections.memory_id, memoryId),
      eq(memoryInjections.session_id, sessionId),
      isNull(memoryInjections.outcome),
    ))
    .run();

  return Number(result.changes ?? 0) > 0;
}

export function listToolCallsSince(
  db: RecallDb,
  sessionId: string,
  injectedAt: string,
): RecentToolCall[] {
  const rows = db.select()
    .from(memoryInjections)
    .where(gt(memoryInjections.injected_at, injectedAt))
    .all();
  void rows;
  return [];
}

export function pathMatchesMemory(mem: MemoryItem, targetPath?: string): boolean {
  if (!targetPath) return mem.scope === "repo" || mem.scope === "team";
  if (mem.scope === "repo" || mem.scope === "team") return true;
  if (!mem.path_scope) return true;

  const pattern = mem.path_scope;
  if (pattern.endsWith("**")) {
    return targetPath.startsWith(pattern.slice(0, -2));
  }
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.replace(/\*/g, "[^/]*").replace(/\*\*/g, ".*") + "$",
    );
    return regex.test(targetPath);
  }
  return targetPath.startsWith(pattern);
}

export function toolCallTouchesMemory(
  mem: MemoryItem,
  toolCall: RecentToolCall,
): boolean {
  if (toolCall.path && pathMatchesMemory(mem, toolCall.path)) return true;
  if (toolCall.input_summary) {
    const inferredPath = extractPath(toolCall.input_summary);
    if (inferredPath && pathMatchesMemory(mem, inferredPath)) return true;
  }
  return mem.scope === "repo" || mem.scope === "team";
}

function rowToMemoryInjection(row: MemoryInjectionRow): MemoryInjection {
  return {
    id: row.id,
    memory_id: row.memory_id,
    session_id: row.session_id,
    repo: row.repo,
    injected_at: row.injected_at,
    outcome: row.outcome,
    outcome_at: row.outcome_at,
  };
}

function extractPath(text: string): string | undefined {
  const match = text.match(
    /\b((?:src|lib|app|components|utils|test|spec)\/[\w./-]+|[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|swift|java|rb|json|toml|ya?ml))\b/,
  );
  return match?.[1];
}

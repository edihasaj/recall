import { desc, eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { historySnippets } from "../db/schema.js";
import { historySnippetDedupeKey } from "../models/dedupe.js";
import type { HistorySnippet, HistorySnippetKind } from "../types.js";

type HistorySnippetRow = typeof historySnippets.$inferSelect;

export interface CreateHistorySnippetInput {
  repo?: string | null;
  session_id?: string | null;
  kind: HistorySnippetKind;
  text: string;
  source_activity_ids?: string[];
}

export function createHistorySnippet(
  db: RecallDb,
  input: CreateHistorySnippetInput,
): string {
  const dedupeKey = historySnippetDedupeKey(input);
  const existing = db.select().from(historySnippets)
    .where(eq(historySnippets.dedupe_key, dedupeKey))
    .get();
  if (existing) return existing.id;

  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(historySnippets)
    .values({
      id,
      repo: input.repo ?? null,
      session_id: input.session_id ?? null,
      kind: input.kind,
      text: input.text,
      dedupe_key: dedupeKey,
      source_activity_ids: input.source_activity_ids ?? [],
      created_at: now,
      updated_at: now,
    })
    .run();
  return id;
}

export function getHistorySnippet(
  db: RecallDb,
  id: string,
): HistorySnippet | undefined {
  const row = db.select().from(historySnippets).where(eq(historySnippets.id, id)).get();
  return row ? rowToHistorySnippet(row) : undefined;
}

export function listHistorySnippets(
  db: RecallDb,
  query: {
    repo?: string;
    session_id?: string;
    kind?: HistorySnippetKind;
    limit?: number;
  } = {},
): HistorySnippet[] {
  const conditions = [];
  if (query.repo) conditions.push(eq(historySnippets.repo, query.repo));
  if (query.session_id) conditions.push(eq(historySnippets.session_id, query.session_id));
  if (query.kind) conditions.push(eq(historySnippets.kind, query.kind));

  let stmt = db.select().from(historySnippets).$dynamic();
  if (conditions.length > 0) {
    stmt = stmt.where(and(...conditions));
  }
  stmt = stmt.orderBy(desc(historySnippets.updated_at));
  if (query.limit != null) {
    stmt = stmt.limit(query.limit);
  }

  return stmt.all().map(rowToHistorySnippet);
}

export function findHistorySnippetBySession(
  db: RecallDb,
  sessionId: string,
  kind: HistorySnippetKind = "session_summary",
): HistorySnippet | undefined {
  const row = db.select().from(historySnippets)
    .where(and(
      eq(historySnippets.session_id, sessionId),
      eq(historySnippets.kind, kind),
    ))
    .get();
  return row ? rowToHistorySnippet(row) : undefined;
}

export function findHistorySnippetByRepoKind(
  db: RecallDb,
  repo: string,
  kind: HistorySnippetKind,
): HistorySnippet | undefined {
  const row = db.select().from(historySnippets)
    .where(and(
      eq(historySnippets.repo, repo),
      eq(historySnippets.kind, kind),
    ))
    .get();
  return row ? rowToHistorySnippet(row) : undefined;
}

export function updateHistorySnippet(
  db: RecallDb,
  id: string,
  updates: Partial<Pick<HistorySnippet, "text">> & {
    source_activity_ids?: string[];
  },
) {
  const current = getHistorySnippet(db, id);
  if (!current) return;
  const nextText = updates.text ?? current.text;
  const dedupeKey = historySnippetDedupeKey({
    repo: current.repo,
    session_id: current.session_id,
    kind: current.kind,
    text: nextText,
  });
  const collision = db.select().from(historySnippets)
    .where(eq(historySnippets.dedupe_key, dedupeKey))
    .get();
  if (collision && collision.id !== id) return;

  db.update(historySnippets)
    .set({
      ...(updates.text != null ? { text: updates.text } : {}),
      dedupe_key: dedupeKey,
      ...(updates.source_activity_ids ? { source_activity_ids: updates.source_activity_ids as any } : {}),
      updated_at: new Date().toISOString(),
    })
    .where(eq(historySnippets.id, id))
    .run();
}

function rowToHistorySnippet(row: HistorySnippetRow): HistorySnippet {
  const sourceActivityIds =
    typeof row.source_activity_ids === "string"
      ? JSON.parse(row.source_activity_ids)
      : Array.isArray(row.source_activity_ids)
        ? row.source_activity_ids
        : [];

  return {
    id: row.id,
    repo: row.repo,
    session_id: row.session_id,
    kind: row.kind,
    text: row.text,
    source_activity_ids: sourceActivityIds,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

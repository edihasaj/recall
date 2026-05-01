import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { historyInjections } from "../db/schema.js";

export function recordHistoryInjections(
  db: RecallDb,
  input: {
    snippet_ids: readonly string[];
    session_id?: string;
    repo?: string | null;
  },
): number {
  if (!input.session_id || input.snippet_ids.length === 0) return 0;

  const injectedAt = new Date().toISOString();
  let inserted = 0;
  for (const snippetId of input.snippet_ids) {
    const result = db.insert(historyInjections)
      .values({
        id: randomUUID(),
        snippet_id: snippetId,
        session_id: input.session_id,
        repo: input.repo ?? null,
        injected_at: injectedAt,
      })
      .onConflictDoNothing({
        target: [historyInjections.snippet_id, historyInjections.session_id],
      })
      .run();
    inserted += Number(result.changes ?? 0);
  }

  return inserted;
}

export function listInjectedHistoryIdsForSession(
  db: RecallDb,
  sessionId: string,
): Set<string> {
  const rows = db.select({ snippet_id: historyInjections.snippet_id })
    .from(historyInjections)
    .where(eq(historyInjections.session_id, sessionId))
    .all();
  return new Set(rows.map((row) => row.snippet_id));
}

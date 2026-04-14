import { eq } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { historySnippets } from "../db/schema.js";

const FTS_HISTORY_INDEX = "fts_history_index";

function getSqlite(db: RecallDb) {
  return db.$client;
}

export function ensureHistoryFtsIndex(db: RecallDb) {
  getSqlite(db).exec(`
    create virtual table if not exists ${FTS_HISTORY_INDEX} using fts5(
      snippet_id UNINDEXED,
      text,
      repo UNINDEXED,
      kind UNINDEXED
    );
  `);
}

export function removeHistoryFtsRow(db: RecallDb, snippetId: string) {
  const sqlite = getSqlite(db);
  const exists = sqlite
    .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
    .get(FTS_HISTORY_INDEX);
  if (!exists) return;
  sqlite.prepare(`delete from ${FTS_HISTORY_INDEX} where snippet_id = ?`).run(snippetId);
}

export function upsertHistoryFtsRow(
  db: RecallDb,
  snippet: Pick<typeof historySnippets.$inferSelect, "id" | "text" | "repo" | "kind" | "archived_at">,
) {
  ensureHistoryFtsIndex(db);
  if (snippet.archived_at) {
    removeHistoryFtsRow(db, snippet.id);
    return;
  }
  const sqlite = getSqlite(db);
  sqlite.prepare(`delete from ${FTS_HISTORY_INDEX} where snippet_id = ?`).run(snippet.id);
  sqlite.prepare(`
    insert into ${FTS_HISTORY_INDEX} (
      snippet_id,
      text,
      repo,
      kind
    ) values (?, ?, ?, ?)
  `).run(snippet.id, snippet.text, snippet.repo ?? "", snippet.kind);
}

export function syncHistoryFtsIndex(db: RecallDb, snippetId: string) {
  const snippet = db.select().from(historySnippets).where(eq(historySnippets.id, snippetId)).get();
  if (!snippet) {
    removeHistoryFtsRow(db, snippetId);
    return "removed";
  }
  upsertHistoryFtsRow(db, snippet);
  return snippet.archived_at ? "removed" : "stored";
}

export function rebuildHistoryFtsIndex(
  db: RecallDb,
  options: { repo?: string } = {},
) {
  const sqlite = getSqlite(db);
  if (options.repo) {
    ensureHistoryFtsIndex(db);
    sqlite.prepare(`delete from ${FTS_HISTORY_INDEX} where repo = ?`).run(options.repo);
  } else {
    sqlite.exec(`drop table if exists ${FTS_HISTORY_INDEX};`);
    ensureHistoryFtsIndex(db);
  }

  const rows = db.select().from(historySnippets).all()
    .filter((row) => !options.repo || row.repo === options.repo)
    .filter((row) => !row.archived_at);

  const stmt = sqlite.prepare(`
    insert into ${FTS_HISTORY_INDEX} (
      snippet_id,
      text,
      repo,
      kind
    ) values (?, ?, ?, ?)
  `);
  const insertMany = sqlite.transaction((batch: typeof rows) => {
    for (const row of batch) {
      stmt.run(row.id, row.text, row.repo ?? "", row.kind);
    }
  });
  insertMany(rows);
  return rows.length;
}

export function verifyHistoryFtsIndex(
  db: RecallDb,
  options: { repo?: string } = {},
) {
  const sqlite = getSqlite(db);
  const exists = sqlite
    .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
    .get(FTS_HISTORY_INDEX);
  const expected = db.select().from(historySnippets).all()
    .filter((row) => !options.repo || row.repo === options.repo)
    .filter((row) => !row.archived_at).length;

  let indexed = 0;
  if (exists) {
    if (options.repo) {
      indexed = (sqlite.prepare(`select count(*) as count from ${FTS_HISTORY_INDEX} where repo = ?`).get(options.repo) as { count: number }).count;
    } else {
      indexed = (sqlite.prepare(`select count(*) as count from ${FTS_HISTORY_INDEX}`).get() as { count: number }).count;
    }
  }
  return { expected, indexed, drift: expected - indexed };
}

function buildFtsQuery(query: string) {
  const tokens = query
    .match(/[A-Za-z0-9_.:/-]+/g)
    ?.map((token) => token.replace(/"/g, '""'))
    .filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(" ");
}

export function searchHistoryFtsIndex(
  db: RecallDb,
  query: string,
  options: { repo?: string; limit?: number } = {},
): Array<{ snippet_id: string; lexical_rank: number }> {
  ensureHistoryFtsIndex(db);
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];
  const sqlite = getSqlite(db);
  const limit = options.limit ?? 10;

  if (options.repo) {
    return sqlite.prepare(`
      select snippet_id, bm25(${FTS_HISTORY_INDEX}) as lexical_rank
      from ${FTS_HISTORY_INDEX}
      where ${FTS_HISTORY_INDEX} match ?
        and repo = ?
      order by lexical_rank
      limit ?
    `).all(ftsQuery, options.repo, limit) as Array<{ snippet_id: string; lexical_rank: number }>;
  }

  return sqlite.prepare(`
    select snippet_id, bm25(${FTS_HISTORY_INDEX}) as lexical_rank
    from ${FTS_HISTORY_INDEX}
    where ${FTS_HISTORY_INDEX} match ?
    order by lexical_rank
    limit ?
  `).all(ftsQuery, limit) as Array<{ snippet_id: string; lexical_rank: number }>;
}

import { eq } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { historySnippets } from "../db/schema.js";
import { getSynonyms } from "./synonyms.js";

const FTS_HISTORY_INDEX = "fts_history_index";
const FTS_TOKENIZER = `porter unicode61 remove_diacritics 2`;

function getSqlite(db: RecallDb) {
  return db.$client;
}

function getFtsCreateSql(db: RecallDb, table: string): string | null {
  const row = getSqlite(db)
    .prepare("select sql from sqlite_master where type = 'table' and name = ?")
    .get(table) as { sql: string } | undefined;
  return row?.sql ?? null;
}

export function ensureHistoryFtsIndex(db: RecallDb) {
  const sqlite = getSqlite(db);
  const existing = getFtsCreateSql(db, FTS_HISTORY_INDEX);
  const needsMigration = existing !== null && !existing.includes("porter");
  if (needsMigration) {
    sqlite.exec(`drop table if exists ${FTS_HISTORY_INDEX};`);
  }
  sqlite.exec(`
    create virtual table if not exists ${FTS_HISTORY_INDEX} using fts5(
      snippet_id UNINDEXED,
      text,
      repo UNINDEXED,
      kind UNINDEXED,
      tokenize="${FTS_TOKENIZER}"
    );
  `);
  if (needsMigration) {
    rebuildHistoryFtsIndex(db);
  }
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
  snippet: Pick<typeof historySnippets.$inferSelect, "id" | "text" | "repo" | "kind">,
) {
  ensureHistoryFtsIndex(db);
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
  return "stored";
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
    .filter((row) => !options.repo || row.repo === options.repo);

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
    .filter((row) => !options.repo || row.repo === options.repo).length;

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

function isPrefixable(token: string) {
  return token.length >= 4 && /^[A-Za-z]+$/.test(token);
}

function emitToken(token: string, prefixDisabled: boolean): string {
  return !prefixDisabled && isPrefixable(token)
    ? `"${token}"*`
    : `"${token}"`;
}

function buildFtsQuery(query: string) {
  const tokens = query
    .match(/[A-Za-z0-9_.:/-]+/g)
    ?.map((token) => token.replace(/"/g, '""'))
    .filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  const prefixDisabled = process.env.RECALL_FTS_PREFIX === "false";
  const synonymsDisabled = process.env.RECALL_SYNONYMS === "false";
  return tokens
    .map((token) => {
      const base = emitToken(token, prefixDisabled);
      if (synonymsDisabled) return base;
      const syns = getSynonyms(token);
      if (syns.length === 0) return base;
      const alts = syns.map((s) => emitToken(s, prefixDisabled));
      return `(${[base, ...alts].join(" OR ")})`;
    })
    .join(" AND ");
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

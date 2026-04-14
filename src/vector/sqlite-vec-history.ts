import * as sqliteVec from "sqlite-vec";
import { eq } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { historySnippetEmbeddings, historySnippets } from "../db/schema.js";
import type { EmbeddingConfig } from "../types.js";

const VEC_HISTORY_INDEX = "vec_history_index";
const loadedClients = new WeakSet<object>();

function getSqlite(db: RecallDb) {
  return db.$client;
}

function ensureLoaded(db: RecallDb) {
  const sqlite = getSqlite(db);
  if (loadedClients.has(sqlite)) return;
  sqliteVec.load(sqlite);
  loadedClients.add(sqlite);
}

export function ensureHistoryVecIndex(db: RecallDb, config: EmbeddingConfig) {
  ensureLoaded(db);
  const sqlite = getSqlite(db);
  const existing = sqlite
    .prepare("select sql from sqlite_master where type = 'table' and name = ?")
    .get(VEC_HISTORY_INDEX) as { sql?: string } | undefined;

  const expectedDimension = `float[${config.dimensions}]`;
  if (existing?.sql && !existing.sql.includes(expectedDimension)) {
    throw new Error(
      `sqlite-vec history index dimension mismatch. Expected ${expectedDimension}. Run history index rebuild.`,
    );
  }

  sqlite.exec(`
    create virtual table if not exists ${VEC_HISTORY_INDEX} using vec0(
      embedding float[${config.dimensions}] distance_metric=cosine,
      snippet_id text,
      repo text,
      kind text
    );
  `);
}

export function removeHistoryVecRow(db: RecallDb, snippetId: string) {
  ensureLoaded(db);
  const sqlite = getSqlite(db);
  const exists = sqlite
    .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
    .get(VEC_HISTORY_INDEX);
  if (!exists) return;
  sqlite.prepare(`delete from ${VEC_HISTORY_INDEX} where snippet_id = ?`).run(snippetId);
}

export function upsertHistoryVecRow(
  db: RecallDb,
  snippet: Pick<typeof historySnippets.$inferSelect, "id" | "repo" | "kind">,
  embeddingRow: Pick<typeof historySnippetEmbeddings.$inferSelect, "embedding">,
  config: EmbeddingConfig,
) {
  ensureHistoryVecIndex(db, config);
  const sqlite = getSqlite(db);
  sqlite.prepare(`delete from ${VEC_HISTORY_INDEX} where snippet_id = ?`).run(snippet.id);
  sqlite.prepare(`
    insert into ${VEC_HISTORY_INDEX} (
      embedding,
      snippet_id,
      repo,
      kind
    ) values (?, ?, ?, ?)
  `).run(
    embeddingRow.embedding,
    snippet.id,
    snippet.repo ?? "",
    snippet.kind,
  );
}

export function rebuildHistoryVecIndex(
  db: RecallDb,
  config: EmbeddingConfig,
  options: { repo?: string } = {},
) {
  ensureHistoryVecIndex(db, config);
  const sqlite = getSqlite(db);
  if (options.repo) {
    sqlite.prepare(`delete from ${VEC_HISTORY_INDEX} where repo = ?`).run(options.repo);
  } else {
    sqlite.exec(`drop table if exists ${VEC_HISTORY_INDEX};`);
    ensureHistoryVecIndex(db, config);
  }

  const rows = db.select({
    id: historySnippets.id,
    repo: historySnippets.repo,
    kind: historySnippets.kind,
    embedding: historySnippetEmbeddings.embedding,
  })
    .from(historySnippets)
    .innerJoin(historySnippetEmbeddings, eq(historySnippetEmbeddings.snippet_id, historySnippets.id))
    .all()
    .filter((row) => !options.repo || row.repo === options.repo);

  const stmt = getSqlite(db).prepare(`
    insert into ${VEC_HISTORY_INDEX} (
      embedding,
      snippet_id,
      repo,
      kind
    ) values (?, ?, ?, ?)
  `);

  const insertMany = getSqlite(db).transaction((batch: typeof rows) => {
    for (const row of batch) {
      stmt.run(row.embedding, row.id, row.repo ?? "", row.kind);
    }
  });

  insertMany(rows);
  return rows.length;
}

export function verifyHistoryVecIndex(
  db: RecallDb,
  options: { repo?: string } = {},
) {
  ensureLoaded(db);
  const sqlite = getSqlite(db);
  const exists = sqlite
    .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
    .get(VEC_HISTORY_INDEX);

  const expected = db.select({
    snippet_id: historySnippetEmbeddings.snippet_id,
    repo: historySnippets.repo,
  })
    .from(historySnippetEmbeddings)
    .innerJoin(historySnippets, eq(historySnippets.id, historySnippetEmbeddings.snippet_id))
    .all()
    .filter((row) => !options.repo || row.repo === options.repo).length;

  let indexed = 0;
  if (exists) {
    if (options.repo) {
      indexed = (sqlite.prepare(`select count(*) as count from ${VEC_HISTORY_INDEX} where repo = ?`).get(options.repo) as { count: number }).count;
    } else {
      indexed = (sqlite.prepare(`select count(*) as count from ${VEC_HISTORY_INDEX}`).get() as { count: number }).count;
    }
  }

  return { expected, indexed, drift: expected - indexed };
}

export function searchHistoryVecIndex(
  db: RecallDb,
  queryEmbedding: Float32Array,
  options: { repo?: string; limit?: number } = {},
): Array<{ snippet_id: string; distance: number }> {
  ensureLoaded(db);
  const sqlite = getSqlite(db);
  const exists = sqlite
    .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
    .get(VEC_HISTORY_INDEX);
  if (!exists) return [];

  const limit = options.limit ?? 10;
  if (options.repo) {
    return sqlite.prepare(`
      select snippet_id, distance
      from ${VEC_HISTORY_INDEX}
      where embedding match ?
        and k = ?
        and repo = ?
      order by distance
    `).all(queryEmbedding, limit, options.repo) as Array<{ snippet_id: string; distance: number }>;
  }

  return sqlite.prepare(`
    select snippet_id, distance
    from ${VEC_HISTORY_INDEX}
    where embedding match ?
      and k = ?
    order by distance
  `).all(queryEmbedding, limit) as Array<{ snippet_id: string; distance: number }>;
}

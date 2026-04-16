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

function hasHistoryVecIndex(db: RecallDb): boolean {
  return Boolean(
    getSqlite(db)
      .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
      .get(VEC_HISTORY_INDEX),
  );
}

function ensureLoaded(db: RecallDb) {
  const sqlite = getSqlite(db);
  if (loadedClients.has(sqlite)) return;
  sqliteVec.load(sqlite);
  loadedClients.add(sqlite);
}

function getHistoryVecDimension(
  rows: Array<Pick<typeof historySnippetEmbeddings.$inferSelect, "index_dimensions">>,
): number | null {
  const dimensions = [...new Set(rows.map((row) => row.index_dimensions))];
  if (dimensions.length === 0) return null;
  if (dimensions.length > 1) {
    throw new Error(
      `sqlite-vec history index rebuild refused mixed history embedding dimensions: ${dimensions.join(", ")}.`,
    );
  }
  return dimensions[0];
}

export function ensureHistoryVecIndex(db: RecallDb, dimensions: number) {
  ensureLoaded(db);
  const sqlite = getSqlite(db);
  const existing = sqlite
    .prepare("select sql from sqlite_master where type = 'table' and name = ?")
    .get(VEC_HISTORY_INDEX) as { sql?: string } | undefined;

  const expectedDimension = `float[${dimensions}]`;
  if (existing?.sql && !existing.sql.includes(expectedDimension)) {
    throw new Error(
      `sqlite-vec history index dimension mismatch. Expected ${expectedDimension}. Run history index rebuild.`,
    );
  }

  sqlite.exec(`
    create virtual table if not exists ${VEC_HISTORY_INDEX} using vec0(
      embedding float[${dimensions}] distance_metric=cosine,
      snippet_id text,
      repo text,
      kind text
    );
  `);
}

export function removeHistoryVecRow(db: RecallDb, snippetId: string) {
  ensureLoaded(db);
  if (!hasHistoryVecIndex(db)) return;
  getSqlite(db).prepare(`delete from ${VEC_HISTORY_INDEX} where snippet_id = ?`).run(snippetId);
}

export function upsertHistoryVecRow(
  db: RecallDb,
  snippet: Pick<typeof historySnippets.$inferSelect, "id" | "repo" | "kind">,
  embeddingRow: Pick<typeof historySnippetEmbeddings.$inferSelect, "embedding" | "index_dimensions">,
) {
  ensureHistoryVecIndex(db, embeddingRow.index_dimensions);
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
    projectIndexBuffer(embeddingRow.embedding, embeddingRow.index_dimensions),
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
  const rows = db.select({
    id: historySnippets.id,
    repo: historySnippets.repo,
    kind: historySnippets.kind,
    index_dimensions: historySnippetEmbeddings.index_dimensions,
    embedding: historySnippetEmbeddings.embedding,
  })
    .from(historySnippets)
    .innerJoin(historySnippetEmbeddings, eq(historySnippetEmbeddings.snippet_id, historySnippets.id))
    .all()
    .filter((row) => !options.repo || row.repo === options.repo);

  const storedDimension = getHistoryVecDimension(rows);
  const targetDimension = storedDimension ?? config.dimensions;
  const sqlite = getSqlite(db);

  if (options.repo) {
    if (rows.length > 0) {
      ensureHistoryVecIndex(db, targetDimension);
    }
    if (!hasHistoryVecIndex(db)) return 0;
    sqlite.prepare(`delete from ${VEC_HISTORY_INDEX} where repo = ?`).run(options.repo);
    if (rows.length === 0) return 0;
  } else {
    sqlite.exec(`drop table if exists ${VEC_HISTORY_INDEX};`);
    ensureHistoryVecIndex(db, targetDimension);
  }

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
      stmt.run(projectIndexBuffer(row.embedding, row.index_dimensions), row.id, row.repo ?? "", row.kind);
    }
  });

  insertMany(rows);
  return rows.length;
}

function projectIndexBuffer(buffer: Buffer, indexDimensions: number): Buffer {
  const embedding = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  if (embedding.length === indexDimensions) {
    return buffer;
  }
  if (embedding.length < indexDimensions) {
    throw new Error(`Canonical history embedding width ${embedding.length} is smaller than index width ${indexDimensions}.`);
  }
  const sliced = embedding.slice(0, indexDimensions);
  let norm = 0;
  for (const value of sliced) norm += value * value;
  const scale = Math.sqrt(norm) || 1;
  for (let i = 0; i < sliced.length; i++) {
    sliced[i] /= scale;
  }
  return Buffer.from(sliced.buffer, sliced.byteOffset, sliced.byteLength);
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

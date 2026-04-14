import * as sqliteVec from "sqlite-vec";
import type { RecallDb } from "../db/client.js";
import { memories, memoryEmbeddings } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { EmbeddingConfig } from "../types.js";

const VEC_MEMORY_INDEX = "vec_memory_index";
const loadedClients = new WeakSet<object>();

type MemoryRow = typeof memories.$inferSelect;
type MemoryEmbeddingRow = typeof memoryEmbeddings.$inferSelect;

function getSqlite(db: RecallDb) {
  return db.$client;
}

export function ensureSqliteVecLoaded(db: RecallDb) {
  const sqlite = getSqlite(db);
  if (loadedClients.has(sqlite)) return;
  sqliteVec.load(sqlite);
  loadedClients.add(sqlite);
}

export function ensureMemoryVecIndex(
  db: RecallDb,
  config: EmbeddingConfig,
) {
  ensureSqliteVecLoaded(db);

  const sqlite = getSqlite(db);
  const existing = sqlite
    .prepare("select sql from sqlite_master where type = 'table' and name = ?")
    .get(VEC_MEMORY_INDEX) as { sql?: string } | undefined;

  const expectedDimension = `float[${config.dimensions}]`;
  if (existing?.sql && !existing.sql.includes(expectedDimension)) {
    throw new Error(
      `sqlite-vec index dimension mismatch. Expected ${expectedDimension}. Run \`recall embeddings rebuild-index\`.`,
    );
  }

  sqlite.exec(`
    create virtual table if not exists ${VEC_MEMORY_INDEX} using vec0(
      embedding float[${config.dimensions}] distance_metric=cosine,
      memory_id text,
      repo text,
      status text,
      type text,
      scope text
    );
  `);
}

export function dropMemoryVecIndex(db: RecallDb) {
  ensureSqliteVecLoaded(db);
  getSqlite(db).exec(`drop table if exists ${VEC_MEMORY_INDEX};`);
}

export function upsertMemoryVecRow(
  db: RecallDb,
  memory: Pick<MemoryRow, "id" | "repo" | "status" | "type" | "scope">,
  embeddingRow: Pick<MemoryEmbeddingRow, "embedding">,
  config: EmbeddingConfig,
) {
  ensureMemoryVecIndex(db, config);
  const sqlite = getSqlite(db);
  sqlite.prepare(`delete from ${VEC_MEMORY_INDEX} where memory_id = ?`).run(memory.id);
  sqlite.prepare(`
    insert into ${VEC_MEMORY_INDEX} (
      embedding,
      memory_id,
      repo,
      status,
      type,
      scope
    ) values (?, ?, ?, ?, ?, ?)
  `).run(
    embeddingRow.embedding,
    memory.id,
    memory.repo ?? "",
    memory.status,
    memory.type,
    memory.scope,
  );
}

export function removeMemoryVecRow(
  db: RecallDb,
  memoryId: string,
  config?: EmbeddingConfig,
) {
  ensureSqliteVecLoaded(db);
  const sqlite = getSqlite(db);
  const exists = sqlite
    .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
    .get(VEC_MEMORY_INDEX);
  if (!exists) return;
  sqlite.prepare(`delete from ${VEC_MEMORY_INDEX} where memory_id = ?`).run(memoryId);
}

export function rebuildMemoryVecIndex(
  db: RecallDb,
  config: EmbeddingConfig,
  options: { repo?: string } = {},
): number {
  if (options.repo) {
    ensureMemoryVecIndex(db, config);
    getSqlite(db)
      .prepare(`delete from ${VEC_MEMORY_INDEX} where repo = ?`)
      .run(options.repo);
  } else {
    dropMemoryVecIndex(db);
    ensureMemoryVecIndex(db, config);
  }

  const rows = db.select({
    id: memories.id,
    repo: memories.repo,
    status: memories.status,
    type: memories.type,
    scope: memories.scope,
    embedding: memoryEmbeddings.embedding,
  })
    .from(memories)
    .innerJoin(memoryEmbeddings, eq(memoryEmbeddings.memory_id, memories.id))
    .all()
    .filter((row) => !options.repo || row.repo === options.repo);

  const sqlite = getSqlite(db);
  const stmt = sqlite.prepare(`
    insert into ${VEC_MEMORY_INDEX} (
      embedding,
      memory_id,
      repo,
      status,
      type,
      scope
    ) values (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = sqlite.transaction((batch: typeof rows) => {
    for (const row of batch) {
      stmt.run(
        row.embedding,
        row.id,
        row.repo ?? "",
        row.status,
        row.type,
        row.scope,
      );
    }
  });

  insertMany(rows);
  return rows.length;
}

export function verifyMemoryVecIndex(
  db: RecallDb,
  options: { repo?: string } = {},
) {
  ensureSqliteVecLoaded(db);
  const sqlite = getSqlite(db);
  const exists = sqlite
    .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
    .get(VEC_MEMORY_INDEX);

  const expectedRows = db.select({
    memory_id: memoryEmbeddings.memory_id,
    repo: memories.repo,
  })
    .from(memoryEmbeddings)
    .innerJoin(memories, eq(memories.id, memoryEmbeddings.memory_id))
    .all()
    .filter((row) => !options.repo || row.repo === options.repo);

  let indexed = 0;
  if (exists) {
    if (options.repo) {
      const result = sqlite
        .prepare(`select count(*) as count from ${VEC_MEMORY_INDEX} where repo = ?`)
        .get(options.repo) as { count: number };
      indexed = result.count;
    } else {
      const result = sqlite
        .prepare(`select count(*) as count from ${VEC_MEMORY_INDEX}`)
        .get() as { count: number };
      indexed = result.count;
    }
  }

  return {
    expected: expectedRows.length,
    indexed,
    drift: expectedRows.length - indexed,
  };
}

export function searchMemoryVecIndex(
  db: RecallDb,
  queryEmbedding: Float32Array,
  options: { repo?: string; limit?: number } = {},
): Array<{ memory_id: string; distance: number }> {
  ensureSqliteVecLoaded(db);

  const sqlite = getSqlite(db);
  const exists = sqlite
    .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
    .get(VEC_MEMORY_INDEX);
  if (!exists) return [];

  const limit = options.limit ?? 10;
  if (options.repo) {
    return sqlite.prepare(`
      select memory_id, distance
      from ${VEC_MEMORY_INDEX}
      where embedding match ?
        and k = ?
        and repo = ?
      order by distance
    `).all(queryEmbedding, limit, options.repo) as Array<{ memory_id: string; distance: number }>;
  }

  return sqlite.prepare(`
    select memory_id, distance
    from ${VEC_MEMORY_INDEX}
    where embedding match ?
      and k = ?
    order by distance
  `).all(queryEmbedding, limit) as Array<{ memory_id: string; distance: number }>;
}

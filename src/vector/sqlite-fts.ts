import type { RecallDb } from "../db/client.js";
import { eq } from "drizzle-orm";
import { memories } from "../db/schema.js";
import { getSynonyms } from "./synonyms.js";

const FTS_MEMORY_INDEX = "fts_memory_index";

// Porter stemming so `degree`≈`degrees`, `graduate`≈`graduated`. Closes most
// of the single-session-user gap in LongMemEval-S. Coupled with unicode61 +
// diacritic folding so accented inputs match unaccented index rows.
const FTS_TOKENIZER = `porter unicode61 remove_diacritics 2`;

type MemoryRow = typeof memories.$inferSelect;

function getSqlite(db: RecallDb) {
  return db.$client;
}

function shouldIndexLexically(
  memory: Pick<MemoryRow, "status" | "confidence">,
) {
  return memory.status !== "rejected" && memory.status !== "transient";
}

// Stem-safe identifier shape: alphabetic only and ≥4 chars. Tokens with
// digits, dots, slashes, etc. are kept as exact phrases (no prefix '*').
function isPrefixable(token: string) {
  return token.length >= 4 && /^[A-Za-z]+$/.test(token);
}

function emitToken(token: string, prefixDisabled: boolean): string {
  return !prefixDisabled && isPrefixable(token)
    ? `"${token}"*`
    : `"${token}"`;
}

function expandTokenWithSynonyms(
  token: string,
  prefixDisabled: boolean,
  synonymsDisabled: boolean,
): string {
  const base = emitToken(token, prefixDisabled);
  if (synonymsDisabled) return base;
  const syns = getSynonyms(token);
  if (syns.length === 0) return base;
  const alts = syns.map((s) => emitToken(s, prefixDisabled));
  return `(${[base, ...alts].join(" OR ")})`;
}

function buildFtsQuery(query: string) {
  const tokens = query
    .match(/[A-Za-z0-9_.:/-]+/g)
    ?.map((token) => token.replace(/"/g, '""'))
    .filter(Boolean) ?? [];

  if (tokens.length === 0) return null;
  // Default is AND-of-phrase tokens, which is the right call for the short
  // coding-rule queries we ship for. Set RECALL_FTS_MODE=or for natural-
  // language haystacks (e.g. LongMemEval) where AND is too strict.
  // FTS5 needs an explicit `AND` keyword when joining a parenthesized
  // synonym group with the next token (implicit-AND via whitespace is only
  // valid between bare phrases) — use the keyword form universally so both
  // shapes work.
  const join = process.env.RECALL_FTS_MODE === "or" ? " OR " : " AND ";
  const prefixDisabled = process.env.RECALL_FTS_PREFIX === "false";
  const synonymsDisabled = process.env.RECALL_SYNONYMS === "false";
  return tokens
    .map((token) =>
      expandTokenWithSynonyms(token, prefixDisabled, synonymsDisabled),
    )
    .join(join);
}

function getFtsCreateSql(db: RecallDb, table: string): string | null {
  const row = getSqlite(db)
    .prepare("select sql from sqlite_master where type = 'table' and name = ?")
    .get(table) as { sql: string } | undefined;
  return row?.sql ?? null;
}

export function ensureMemoryFtsIndex(db: RecallDb) {
  const sqlite = getSqlite(db);
  const existing = getFtsCreateSql(db, FTS_MEMORY_INDEX);
  const needsMigration = existing !== null && !existing.includes("porter");
  if (needsMigration) {
    sqlite.exec(`drop table if exists ${FTS_MEMORY_INDEX};`);
  }
  sqlite.exec(`
    create virtual table if not exists ${FTS_MEMORY_INDEX} using fts5(
      memory_id UNINDEXED,
      text,
      repo UNINDEXED,
      status UNINDEXED,
      type UNINDEXED,
      scope UNINDEXED,
      path_scope UNINDEXED,
      tokenize="${FTS_TOKENIZER}"
    );
  `);
  if (needsMigration) {
    rebuildMemoryFtsIndex(db);
  }
}

export function dropMemoryFtsIndex(db: RecallDb) {
  getSqlite(db).exec(`drop table if exists ${FTS_MEMORY_INDEX};`);
}

export function removeMemoryFtsRow(
  db: RecallDb,
  memoryId: string,
) {
  const sqlite = getSqlite(db);
  const exists = sqlite
    .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
    .get(FTS_MEMORY_INDEX);
  if (!exists) return;
  sqlite.prepare(`delete from ${FTS_MEMORY_INDEX} where memory_id = ?`).run(memoryId);
}

export function upsertMemoryFtsRow(
  db: RecallDb,
  memory: Pick<MemoryRow, "id" | "text" | "repo" | "status" | "type" | "scope" | "path_scope" | "confidence">,
) {
  ensureMemoryFtsIndex(db);

  if (!shouldIndexLexically(memory)) {
    removeMemoryFtsRow(db, memory.id);
    return;
  }

  const sqlite = getSqlite(db);
  sqlite.prepare(`delete from ${FTS_MEMORY_INDEX} where memory_id = ?`).run(memory.id);
  sqlite.prepare(`
    insert into ${FTS_MEMORY_INDEX} (
      memory_id,
      text,
      repo,
      status,
      type,
      scope,
      path_scope
    ) values (?, ?, ?, ?, ?, ?, ?)
  `).run(
    memory.id,
    memory.text,
    memory.repo ?? "",
    memory.status,
    memory.type,
    memory.scope,
    memory.path_scope ?? "",
  );
}

export function syncMemoryFtsIndex(
  db: RecallDb,
  memoryId: string,
) {
  const memory = db
    .select()
    .from(memories)
    .where(eq(memories.id, memoryId))
    .get();

  if (!memory) {
    removeMemoryFtsRow(db, memoryId);
    return "removed";
  }

  upsertMemoryFtsRow(db, memory);
  return shouldIndexLexically(memory) ? "stored" : "removed";
}

export function rebuildMemoryFtsIndex(
  db: RecallDb,
  options: { repo?: string } = {},
): number {
  if (options.repo) {
    ensureMemoryFtsIndex(db);
    getSqlite(db)
      .prepare(`delete from ${FTS_MEMORY_INDEX} where repo = ?`)
      .run(options.repo);
  } else {
    dropMemoryFtsIndex(db);
    ensureMemoryFtsIndex(db);
  }

  const rows = db.select().from(memories).all()
    .filter((row) => !options.repo || row.repo === options.repo)
    .filter((row) => shouldIndexLexically(row));

  const sqlite = getSqlite(db);
  const stmt = sqlite.prepare(`
    insert into ${FTS_MEMORY_INDEX} (
      memory_id,
      text,
      repo,
      status,
      type,
      scope,
      path_scope
    ) values (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = sqlite.transaction((batch: typeof rows) => {
    for (const row of batch) {
      stmt.run(
        row.id,
        row.text,
        row.repo ?? "",
        row.status,
        row.type,
        row.scope,
        row.path_scope ?? "",
      );
    }
  });

  insertMany(rows);
  return rows.length;
}

export function verifyMemoryFtsIndex(
  db: RecallDb,
  options: { repo?: string } = {},
) {
  const sqlite = getSqlite(db);
  const exists = sqlite
    .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
    .get(FTS_MEMORY_INDEX);

  const expected = db.select().from(memories).all()
    .filter((row) => !options.repo || row.repo === options.repo)
    .filter((row) => shouldIndexLexically(row)).length;

  let indexed = 0;
  if (exists) {
    if (options.repo) {
      const result = sqlite
        .prepare(`select count(*) as count from ${FTS_MEMORY_INDEX} where repo = ?`)
        .get(options.repo) as { count: number };
      indexed = result.count;
    } else {
      const result = sqlite
        .prepare(`select count(*) as count from ${FTS_MEMORY_INDEX}`)
        .get() as { count: number };
      indexed = result.count;
    }
  }

  return {
    expected,
    indexed,
    drift: expected - indexed,
  };
}

export function searchMemoryFtsIndex(
  db: RecallDb,
  query: string,
  options: { repo?: string; limit?: number } = {},
): Array<{ memory_id: string; lexical_rank: number }> {
  ensureMemoryFtsIndex(db);

  const sqlite = getSqlite(db);
  const limit = options.limit ?? 10;
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  if (options.repo) {
    return sqlite.prepare(`
      select memory_id, bm25(${FTS_MEMORY_INDEX}) as lexical_rank
      from ${FTS_MEMORY_INDEX}
      where ${FTS_MEMORY_INDEX} match ?
        and repo = ?
      order by lexical_rank
      limit ?
    `).all(ftsQuery, options.repo, limit) as Array<{ memory_id: string; lexical_rank: number }>;
  }

  return sqlite.prepare(`
    select memory_id, bm25(${FTS_MEMORY_INDEX}) as lexical_rank
    from ${FTS_MEMORY_INDEX}
    where ${FTS_MEMORY_INDEX} match ?
    order by lexical_rank
    limit ?
  `).all(ftsQuery, limit) as Array<{ memory_id: string; lexical_rank: number }>;
}

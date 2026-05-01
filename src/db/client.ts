import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import { join, dirname } from "node:path";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getEmbeddingCacheRoot } from "../embeddings/cache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const RECALL_DB_USER_VERSION = 9;

export function getDbPath(): string {
  const dataDir =
    process.env.RECALL_DATA_DIR ??
    join(
      process.env.HOME ?? process.env.USERPROFILE ?? ".",
      ".recall",
    );
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, "recall.db");
}

function getMigrationsPath(): string {
  // Walk up from __dirname until we find drizzle/meta/_journal.json
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "drizzle");
    if (existsSync(join(candidate, "meta", "_journal.json"))) {
      return candidate;
    }
    dir = dirname(dir);
  }
  // Fallback: relative to __dirname (works in bundled dist/)
  return join(__dirname, "..", "drizzle");
}

let _sqlite: Database.Database | null = null;
let _db: ReturnType<typeof makeDb> | null = null;
let _dbPath: string | null = null;

function makeDb(sqlite: Database.Database) {
  return drizzle(sqlite, { schema });
}

function applyPragmas(sqlite: Database.Database) {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
}

function setDbUserVersion(sqlite: Database.Database, version = RECALL_DB_USER_VERSION) {
  sqlite.pragma(`user_version = ${version}`);
}

export type RecallDb = ReturnType<typeof makeDb>;

export function getDb(dbPath?: string): RecallDb {
  if (!_db) {
    const path = dbPath ?? getDbPath();
    _sqlite = new Database(path);
    applyPragmas(_sqlite);
    _db = makeDb(_sqlite);
    _dbPath = path;
  }
  return _db;
}

/** Create a standalone DB instance (useful for tests). */
export function createStandaloneDb(dbPath: string): { db: RecallDb; sqlite: Database.Database } {
  const sqlite = new Database(dbPath);
  applyPragmas(sqlite);
  const db = makeDb(sqlite);
  return { db, sqlite };
}

export function initDb(dbPath?: string): RecallDb {
  const db = getDb(dbPath);
  migrate(db, { migrationsFolder: getMigrationsPath() });
  setDbUserVersion(db.$client);
  return db;
}

/** Init a standalone DB (for tests — no module-level singleton). */
export function initStandaloneDb(dbPath: string): RecallDb {
  const { db, sqlite } = createStandaloneDb(dbPath);
  migrate(db, { migrationsFolder: getMigrationsPath() });
  setDbUserVersion(sqlite);
  return db;
}

export function closeDb() {
  if (_sqlite) {
    _sqlite.close();
  }
  _sqlite = null;
  _db = null;
  _dbPath = null;
}

export function getDbUserVersion(dbPath?: string): number {
  const path = dbPath ?? getDbPath();
  if (!existsSync(path)) return 0;

  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return Number(sqlite.pragma("user_version", { simple: true }) ?? 0);
  } finally {
    sqlite.close();
  }
}

export function resetDb(
  dbPath?: string,
  options: { purgeModels?: boolean } = {},
) {
  const path = dbPath ?? getDbPath();

  if (_dbPath === path) {
    closeDb();
  }

  for (const suffix of ["", "-shm", "-wal"]) {
    const candidate = `${path}${suffix}`;
    if (existsSync(candidate)) {
      rmSync(candidate, { force: true });
    }
  }

  if (options.purgeModels) {
    rmSync(getEmbeddingCacheRoot(), { recursive: true, force: true });
  }
}

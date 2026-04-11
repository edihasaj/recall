import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

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

let _sqlite: Database.Database | null = null;
let _db: ReturnType<typeof makeDb> | null = null;

function makeDb(sqlite: Database.Database) {
  return drizzle(sqlite, { schema });
}

export type RecallDb = ReturnType<typeof makeDb>;

export function getDb(dbPath?: string): RecallDb {
  if (!_db) {
    const path = dbPath ?? getDbPath();
    _sqlite = new Database(path);
    _sqlite.pragma("journal_mode = WAL");
    _sqlite.pragma("foreign_keys = ON");
    _db = makeDb(_sqlite);
  }
  return _db;
}

/** Create a standalone DB instance (useful for tests). */
export function createStandaloneDb(dbPath: string): { db: RecallDb; sqlite: Database.Database } {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = makeDb(sqlite);
  return { db, sqlite };
}

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    text TEXT NOT NULL,
    scope TEXT NOT NULL,
    path_scope TEXT,
    repo TEXT,
    status TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '[]',
    supersedes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_validated_at TEXT,
    last_injected_at TEXT,
    injection_count INTEGER NOT NULL DEFAULT 0,
    override_count INTEGER NOT NULL DEFAULT 0,
    team_id TEXT,
    sync_version INTEGER NOT NULL DEFAULT 0,
    embedding BLOB
  );

  CREATE TABLE IF NOT EXISTS feedback_events (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES memories(id),
    session_id TEXT NOT NULL,
    injected INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    id TEXT PRIMARY KEY,
    remote_url TEXT,
    team_id TEXT,
    last_push_at TEXT,
    last_pull_at TEXT,
    last_push_version INTEGER NOT NULL DEFAULT 0,
    last_pull_version INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS eval_sessions (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    memories_injected INTEGER NOT NULL DEFAULT 0,
    memories_followed INTEGER NOT NULL DEFAULT 0,
    memories_overridden INTEGER NOT NULL DEFAULT 0,
    user_corrections INTEGER NOT NULL DEFAULT 0,
    test_passes INTEGER NOT NULL DEFAULT 0,
    test_failures INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS implicit_signals (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES memories(id),
    session_id TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    context TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_memories_repo ON memories(repo);
  CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
  CREATE INDEX IF NOT EXISTS idx_memories_repo_status ON memories(repo, status);
  CREATE INDEX IF NOT EXISTS idx_memories_team ON memories(team_id);
  CREATE INDEX IF NOT EXISTS idx_feedback_memory ON feedback_events(memory_id);
  CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_eval_repo ON eval_sessions(repo);
  CREATE INDEX IF NOT EXISTS idx_implicit_memory ON implicit_signals(memory_id);
  CREATE INDEX IF NOT EXISTS idx_implicit_session ON implicit_signals(session_id);
`;

export function initDb(dbPath?: string): RecallDb {
  const db = getDb(dbPath);
  _sqlite!.exec(INIT_SQL);
  return db;
}

/** Init a standalone DB (for tests — no module-level singleton). */
export function initStandaloneDb(dbPath: string): RecallDb {
  const { db, sqlite } = createStandaloneDb(dbPath);
  sqlite.exec(INIT_SQL);
  return db;
}

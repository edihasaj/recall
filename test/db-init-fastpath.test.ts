import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { initStandaloneDb, RECALL_DB_USER_VERSION } from "../src/db/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("initDb fast path", () => {
  it("RECALL_DB_USER_VERSION matches the drizzle migration journal", () => {
    // The fast path skips migrate() when user_version is current, so the
    // constant MUST be bumped together with every new migration.
    const journal = JSON.parse(
      readFileSync(join(__dirname, "..", "drizzle", "meta", "_journal.json"), "utf8"),
    );
    expect(RECALL_DB_USER_VERSION).toBe(journal.entries.length);
  });

  it("re-init of a current DB succeeds while another connection holds the write lock", () => {
    process.env.RECALL_EMBEDDINGS_DISABLED = "true";
    const dir = mkdtempSync(join(tmpdir(), "recall-fastpath-"));
    const path = join(dir, "test.db");

    const first = initStandaloneDb(path);
    expect(
      Number(first.$client.pragma("user_version", { simple: true })),
    ).toBe(RECALL_DB_USER_VERSION);
    first.$client.close();

    // Simulate the daemon holding a long write transaction.
    const blocker = new Database(path);
    blocker.pragma("journal_mode = WAL");
    blocker.exec("BEGIN IMMEDIATE");

    try {
      // Before the fast path this hung on migrate()/user_version and threw
      // SqliteError: database is locked, dropping hook events.
      const db = initStandaloneDb(path);
      expect(
        Number(db.$client.pragma("user_version", { simple: true })),
      ).toBe(RECALL_DB_USER_VERSION);
      db.$client.close();
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });
});

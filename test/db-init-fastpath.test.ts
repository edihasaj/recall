import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { initStandaloneDb, RECALL_DB_USER_VERSION } from "../src/db/client.js";
import { compactDedupeKey } from "../src/models/dedupe.js";

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

  it("does not downgrade user_version when an older binary opens a newer DB", () => {
    process.env.RECALL_EMBEDDINGS_DISABLED = "true";
    const dir = mkdtempSync(join(tmpdir(), "recall-fastpath-newer-"));
    const path = join(dir, "test.db");

    const first = initStandaloneDb(path);
    first.$client.pragma(`user_version = ${RECALL_DB_USER_VERSION + 1}`);
    first.$client.close();

    const reopened = initStandaloneDb(path);
    expect(
      Number(reopened.$client.pragma("user_version", { simple: true })),
    ).toBe(RECALL_DB_USER_VERSION + 1);
    reopened.$client.close();
  });

  it("compacts legacy telemetry dedupe keys during migration", () => {
    process.env.RECALL_EMBEDDINGS_DISABLED = "true";
    const dir = mkdtempSync(join(tmpdir(), "recall-dedupe-migration-"));
    const path = join(dir, "test.db");
    const first = initStandaloneDb(path);
    const legacyActivityKey = "activity\u001flegacy-payload";
    const legacyHookKey = "hook\u001flegacy-payload";
    first.$client.prepare(`
      insert into activity_events (
        id, source, event_type, memory_ids, dedupe_key, request, result, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("activity-1", "cli", "query", "[]", legacyActivityKey, "{}", "{}", new Date().toISOString());
    first.$client.prepare(`
      insert into activity_events (
        id, source, event_type, memory_ids, dedupe_key, request, result, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "activity-compacted",
      "cli",
      "query",
      "[]",
      compactDedupeKey("activity", legacyActivityKey),
      "{}",
      "{}",
      new Date().toISOString(),
    );
    first.$client.prepare(`
      insert into hook_calls (
        id, event, agent, dedupe_key, duration_ms, ok, created_at
      ) values (?, ?, ?, ?, ?, ?, ?)
    `).run("hook-1", "prompt_submitted", "codex", legacyHookKey, 1, 1, new Date().toISOString());
    first.$client.prepare(`
      insert into hook_calls (
        id, event, agent, dedupe_key, duration_ms, ok, created_at
      ) values (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "hook-compacted",
      "prompt_submitted",
      "codex",
      compactDedupeKey("hook", legacyHookKey),
      1,
      1,
      new Date().toISOString(),
    );
    first.$client.prepare(`
      delete from __drizzle_migrations
      where created_at = (select max(created_at) from __drizzle_migrations)
    `).run();
    first.$client.pragma(`user_version = ${RECALL_DB_USER_VERSION - 1}`);
    first.$client.close();

    const migrated = initStandaloneDb(path);
    const activityKey = migrated.$client.prepare(
      "select dedupe_key from activity_events limit 1",
    ).pluck().get() as string;
    const hookKey = migrated.$client.prepare(
      "select dedupe_key from hook_calls limit 1",
    ).pluck().get() as string;

    expect(activityKey).toMatch(/^activity\u001fsha256:[a-f0-9]{64}$/);
    expect(hookKey).toMatch(/^hook\u001fsha256:[a-f0-9]{64}$/);
    expect(migrated.$client.prepare("select count(*) from activity_events").pluck().get()).toBe(1);
    expect(migrated.$client.prepare("select count(*) from hook_calls").pluck().get()).toBe(1);
    expect(Number(migrated.$client.pragma("user_version", { simple: true }))).toBe(RECALL_DB_USER_VERSION);
    migrated.$client.close();
  });
});

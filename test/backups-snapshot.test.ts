import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_BACKUP_RETENTION,
  ensureDailyBackup,
  getBackupsDir,
  listBackups,
  restoreBackup,
} from "../src/backups/snapshot.js";

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "recall-backup-"));
  const path = join(dir, "recall.db");
  writeFileSync(path, "original-db-bytes");
  return path;
}

describe("daily database snapshot", () => {
  it("creates today's backup when absent", () => {
    const dbPath = freshDbPath();
    const result = ensureDailyBackup({ dbPath, now: new Date("2026-04-17T12:00:00Z") });
    expect(result.created).toMatch(/recall-2026-04-17\.db$/);
    expect(result.retained).toHaveLength(1);
    expect(existsSync(result.created!)).toBe(true);
  });

  it("is idempotent within the same day", () => {
    const dbPath = freshDbPath();
    const first = ensureDailyBackup({ dbPath, now: new Date("2026-04-17T12:00:00Z") });

    writeFileSync(dbPath, "later-edit");
    const second = ensureDailyBackup({ dbPath, now: new Date("2026-04-17T23:59:00Z") });

    expect(second.created).toBeNull();
    expect(readFileSync(first.created!, "utf8")).toBe("original-db-bytes");
  });

  it("retains only the most recent N snapshots (default 2)", () => {
    const dbPath = freshDbPath();
    const dir = getBackupsDir(dbPath);

    for (let i = 0; i < 5; i++) {
      writeFileSync(dbPath, `day-${i}`);
      const stamp = new Date(Date.UTC(2026, 3, 10 + i, 12));
      ensureDailyBackup({ dbPath, now: stamp });
    }

    const listed = listBackups(dbPath);
    expect(listed).toHaveLength(DEFAULT_BACKUP_RETENTION);
    expect(listed[0].date).toBe("2026-04-14");
    expect(listed[1].date).toBe("2026-04-13");
    expect(existsSync(join(dir, "recall-2026-04-10.db"))).toBe(false);
  });

  it("returns no-op when db file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-backup-missing-"));
    const result = ensureDailyBackup({ dbPath: join(dir, "recall.db") });
    expect(result.created).toBeNull();
    expect(result.retained).toEqual([]);
  });

  it("restores a dated snapshot over the live db", () => {
    const dbPath = freshDbPath();
    ensureDailyBackup({ dbPath, now: new Date("2026-04-15T12:00:00Z") });

    writeFileSync(dbPath, "corrupted");
    const result = restoreBackup("2026-04-15", { dbPath });

    expect(result.restored).toBe(true);
    expect(readFileSync(dbPath, "utf8")).toBe("original-db-bytes");
  });

  it("fails cleanly when the requested backup is missing", () => {
    const dbPath = freshDbPath();
    const result = restoreBackup("1999-01-01", { dbPath });
    expect(result.restored).toBe(false);
  });
});

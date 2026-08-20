import { describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
  it("places backups beside the database", () => {
    const dbPath = freshDbPath();
    expect(getBackupsDir(dbPath)).toBe(join(dbPath, "..", "backups"));
  });

  it("creates today's backup when absent", () => {
    const dbPath = freshDbPath();
    const result = ensureDailyBackup({ dbPath, now: new Date("2026-04-17T12:00:00Z") });
    expect(result.created).toMatch(/recall-2026-04-17\.db$/);
    expect(result.retained).toHaveLength(1);
    expect(existsSync(result.created!)).toBe(true);
    if (process.platform !== "win32") {
      expect(lstatSync(result.created!).mode & 0o777).toBe(0o600);
    }
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

  it("rejects invalid or traversing restore dates", () => {
    const dbPath = freshDbPath();
    expect(() => restoreBackup("../../secret", { dbPath })).toThrow(/YYYY-MM-DD/);
    expect(() => restoreBackup("2026-02-31", { dbPath })).toThrow(/calendar date/);
  });

  it.runIf(process.platform !== "win32")("refuses symlinked backup sources", () => {
    const dbPath = freshDbPath();
    const dir = getBackupsDir(dbPath);
    const outside = join(dirname(dir), "outside.db");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(dir, "recall-2026-04-15.db"));

    expect(() => restoreBackup("2026-04-15", { dbPath })).toThrow(/unsafe backup/);
    expect(readFileSync(dbPath, "utf-8")).toBe("original-db-bytes");
  });
});

describe("one-off snapshot retention", () => {
  function seedOneOff(dbPath: string, name: string, ageDays: number): string {
    const dir = getBackupsDir(dbPath);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, "one-off-bytes");
    const when = new Date(Date.now() - ageDays * 86_400_000);
    utimesSync(path, when, when);
    return path;
  }

  it("ages out stale one-off snapshots the daily rotation never saw", () => {
    const dbPath = freshDbPath();
    // Real names taken from an install that had accumulated 3.8 GB of these.
    const stale = seedOneOff(dbPath, "before-cloud-convergence-20260723-2252.db", 60);
    const alsoStale = seedOneOff(dbPath, "recall-pre-scope-repair-20260725-140657.db", 45);
    const recent = seedOneOff(dbPath, "recall-pre-upgrade-today.db", 2);

    const result = ensureDailyBackup({ dbPath });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(alsoStale)).toBe(false);
    expect(result.removed).toContain(stale);
    expect(result.removed).toContain(alsoStale);

    // A snapshot taken days ago is still inside its grace period.
    expect(existsSync(recent)).toBe(true);
    expect(result.retained).toContain(recent);
  });

  it("catches snapshots whose name carries .db mid-string", () => {
    const dbPath = freshDbPath();
    // Verbatim shape from a real install: 366 MB, from May, invisible to a
    // suffix-only match and therefore immortal.
    const midString = seedOneOff(dbPath, "recall.db.pre-quality-prune-20260511-100432", 90);
    const recentMid = seedOneOff(dbPath, "recall.db.pre-upgrade-20260819-090000", 3);

    const result = ensureDailyBackup({ dbPath });

    expect(existsSync(midString)).toBe(false);
    expect(result.removed).toContain(midString);
    expect(existsSync(recentMid)).toBe(true);

    // And it is visible in the listing rather than silently consuming disk.
    seedOneOff(dbPath, "recall.db.pre-other-20260820-000000", 1);
    expect(listBackups(dbPath).some((b) => b.path.includes("pre-other"))).toBe(true);
  });

  it("never deletes one-off snapshots when the sweep is disabled", () => {
    const dbPath = freshDbPath();
    const ancient = seedOneOff(dbPath, "before-cloud-convergence-20260723-2252.db", 400);

    const result = ensureDailyBackup({ dbPath, one_off_max_age_days: 0 });

    expect(existsSync(ancient)).toBe(true);
    expect(result.removed).not.toContain(ancient);
  });

  it("keeps the daily rotation independent of one-off snapshots", () => {
    const dbPath = freshDbPath();
    seedOneOff(dbPath, "manual-safety-net.db", 1);
    const created = ensureDailyBackup({ dbPath }).created!;

    // The freshly created daily backup must survive its own run.
    expect(existsSync(created)).toBe(true);
    expect(created.endsWith(".db")).toBe(true);
  });

  it("listBackups reports one-off snapshots so disk usage is visible", () => {
    const dbPath = freshDbPath();
    seedOneOff(dbPath, "before-cloud-convergence-20260723-2252.db", 3);
    ensureDailyBackup({ dbPath });

    const listed = listBackups(dbPath);
    const kinds = listed.map((b) => b.kind).sort();
    expect(kinds).toEqual(["daily", "one_off"]);
  });
});

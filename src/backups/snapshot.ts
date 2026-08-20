import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { getDbPath } from "../db/client.js";

export const DEFAULT_BACKUP_RETENTION = 2;

// One-off snapshots (`recall-pre-migration.db`, `before-cloud-convergence.db`,
// anything a human or script named itself) sit in the same directory but do
// not match the daily rotation pattern, so retention never saw them and
// `db backups` never listed them. They accumulated silently — one real install
// carried 3.8 GB of July snapshots that nothing would ever reclaim. They are
// deliberate safety nets, so they get a much longer grace period than the
// dailies rather than immediate rotation.
export const DEFAULT_ONE_OFF_BACKUP_MAX_AGE_DAYS = 30;

const DAILY_BACKUP_RE = /^recall-(\d{4}-\d{2}-\d{2})\.db$/;

export interface BackupResult {
  created: string | null;
  retained: string[];
  removed: string[];
}

export function getBackupsDir(dbPath: string = getDbPath()): string {
  const dir = join(dirname(dbPath), "backups");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function todayStamp(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function ensureDailyBackup(
  options: {
    dbPath?: string;
    retention?: number;
    /** Days to keep non-daily snapshots. 0 disables the sweep entirely. */
    one_off_max_age_days?: number;
    now?: Date;
  } = {},
): BackupResult {
  const dbPath = options.dbPath ?? getDbPath();
  const retention = Math.max(1, options.retention ?? DEFAULT_BACKUP_RETENTION);
  const oneOffMaxAgeDays = Math.max(
    0,
    options.one_off_max_age_days ?? DEFAULT_ONE_OFF_BACKUP_MAX_AGE_DAYS,
  );
  const result: BackupResult = { created: null, retained: [], removed: [] };

  if (!existsSync(dbPath)) return result;

  const dir = getBackupsDir(dbPath);
  const stamp = todayStamp(options.now);
  const target = join(dir, `recall-${stamp}.db`);

  if (!existsSync(target)) {
    atomicCopyFile(dbPath, target);
    result.created = target;
  } else if (!isRegularFileWithoutSymlink(target)) {
    throw new Error(`Refusing unsafe backup path: ${target}`);
  }

  const all = readdirSync(dir)
    .filter((name) => name.endsWith(".db"))
    .filter((name) => isRegularFileWithoutSymlink(join(dir, name)))
    .map((name) => ({ name, path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }));

  const entries = all
    .filter((entry) => DAILY_BACKUP_RE.test(entry.name))
    .sort((a, b) => b.mtime - a.mtime);

  result.retained = entries.slice(0, retention).map((e) => e.path);
  for (const drop of entries.slice(retention)) {
    rmSync(drop.path, { force: true });
    result.removed.push(drop.path);
  }

  // Age-based sweep for one-off snapshots. Never touches the snapshot taken
  // in this run, and never touches anything when the sweep is disabled.
  if (oneOffMaxAgeDays > 0) {
    const cutoff = (options.now?.getTime() ?? Date.now()) - oneOffMaxAgeDays * 86_400_000;
    for (const entry of all) {
      if (DAILY_BACKUP_RE.test(entry.name)) continue;
      if (entry.path === result.created) continue;
      if (entry.mtime >= cutoff) {
        result.retained.push(entry.path);
        continue;
      }
      rmSync(entry.path, { force: true });
      result.removed.push(entry.path);
    }
  }

  return result;
}

export interface BackupListing {
  /** Rotation date for daily snapshots; the file's mtime date for one-offs. */
  date: string;
  path: string;
  size_bytes: number;
  /** "daily" rotates on a count; "one_off" ages out. */
  kind: "daily" | "one_off";
}

// Lists every snapshot, not just the daily rotation. One-off snapshots were
// previously omitted, which hid real disk usage: `db backups` reported a
// couple of gigabytes while the directory held several more.
export function listBackups(dbPath: string = getDbPath()): BackupListing[] {
  const dir = getBackupsDir(dbPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => {
      if (!name.endsWith(".db")) return null;
      const path = join(dir, name);
      if (!isRegularFileWithoutSymlink(path)) return null;
      const stat = statSync(path);
      const match = name.match(DAILY_BACKUP_RE);
      return {
        date: match ? match[1] : new Date(stat.mtimeMs).toISOString().slice(0, 10),
        path,
        size_bytes: stat.size,
        kind: match ? ("daily" as const) : ("one_off" as const),
      };
    })
    .filter((v): v is BackupListing => v !== null)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function restoreBackup(
  date: string,
  options: { dbPath?: string } = {},
): { restored: boolean; from: string; to: string } {
  validateBackupDate(date);
  const dbPath = options.dbPath ?? getDbPath();
  const dir = getBackupsDir(dbPath);
  const from = join(dir, `recall-${date}.db`);
  if (!existsSync(from)) {
    return { restored: false, from, to: dbPath };
  }
  if (!isRegularFileWithoutSymlink(from)) {
    throw new Error(`Refusing unsafe backup path: ${from}`);
  }
  for (const suffix of ["-shm", "-wal"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) rmSync(sidecar, { force: true });
  }
  atomicCopyFile(from, dbPath);
  return { restored: true, from, to: dbPath };
}

function validateBackupDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Backup date must use YYYY-MM-DD");
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("Backup date is not a real calendar date");
  }
}

function isRegularFileWithoutSymlink(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function atomicCopyFile(source: string, target: string): void {
  if (!isRegularFileWithoutSymlink(source)) {
    throw new Error(`Refusing unsafe backup source: ${source}`);
  }
  const temp = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    copyFileSync(source, temp, constants.COPYFILE_EXCL);
    chmodSync(temp, 0o600);
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch (cleanupError) {
      if (
        !(cleanupError instanceof Error) ||
        !("code" in cleanupError) ||
        cleanupError.code !== "ENOENT"
      ) {
        throw cleanupError;
      }
    }
    throw error;
  }
}

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
    now?: Date;
  } = {},
): BackupResult {
  const dbPath = options.dbPath ?? getDbPath();
  const retention = Math.max(1, options.retention ?? DEFAULT_BACKUP_RETENTION);
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

  const entries = readdirSync(dir)
    .filter((name) => /^recall-\d{4}-\d{2}-\d{2}\.db$/.test(name))
    .filter((name) => isRegularFileWithoutSymlink(join(dir, name)))
    .map((name) => ({ name, path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  result.retained = entries.slice(0, retention).map((e) => e.path);
  for (const drop of entries.slice(retention)) {
    rmSync(drop.path, { force: true });
    result.removed.push(drop.path);
  }

  return result;
}

export function listBackups(dbPath: string = getDbPath()): Array<{ date: string; path: string; size_bytes: number }> {
  const dir = getBackupsDir(dbPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => {
      const match = name.match(/^recall-(\d{4}-\d{2}-\d{2})\.db$/);
      if (!match) return null;
      const path = join(dir, name);
      if (!isRegularFileWithoutSymlink(path)) return null;
      return { date: match[1], path, size_bytes: statSync(path).size };
    })
    .filter((v): v is { date: string; path: string; size_bytes: number } => v !== null)
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

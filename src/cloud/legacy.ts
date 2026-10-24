import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, lstatSync, renameSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { validateApi } from "./config.js";
import { CloudError } from "./errors.js";
import { LEGACY_LAUNCHD_LABEL, type CloudPaths } from "./paths.js";
import { ensurePrivateDir } from "./private-files.js";

/** Settings recovered from the separate Recall Cloud Sync LaunchAgent, with identity intact. */
export interface LegacySettings {
  api: string;
  tokenFile: string;
  intervalSeconds: number;
  deviceId: string;
  deviceAliases: Record<string, string>;
  dbPath: string;
  stateFile: string;
  fullReconcileSeconds: number | null;
  statuses: string | null;
  limit: number | null;
  rejectedRetentionDays: number | null;
  e2ee: boolean;
  /** Held in memory only long enough to be written to a private file. */
  passphrase: string | null;
}

const VALUE_FLAGS = new Set([
  "api", "token-file", "interval", "device-id", "db", "device-alias", "state-file",
  "status", "full-reconcile-interval", "limit", "rejected-retention-days",
]);
const KNOWN_ENV = new Set([
  "RECALL_CLOUD_API", "RECALL_CLOUD_DEVICE_ID", "RECALL_CLOUD_E2EE_PASSPHRASE",
  "RECALL_CLOUD_TOKEN", "RECALL_DB", "RECALL_REJECTED_RETENTION_DAYS",
]);

function unsupported(message: string): CloudError {
  return new CloudError(message, "legacy-unsupported", 409);
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

function parseInt10(value: string, min: number, label: string): number {
  if (!/^\d{1,9}$/.test(value) || Number(value) < min) {
    throw unsupported(`The existing sync job has an invalid ${label}, so it was left unchanged`);
  }
  return Number(value);
}

function parseAliases(values: string[]): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const entry of values) {
    const at = entry.indexOf("=");
    const from = at > 0 ? entry.slice(0, at).trim() : "";
    const to = at > 0 ? entry.slice(at + 1).trim() : "";
    if (!from || !to || from.includes(":") || to.includes(":")) {
      throw unsupported("The existing sync job has an invalid device alias, so it was left unchanged");
    }
    aliases[from] = to;
  }
  return aliases;
}

/**
 * Reads a legacy LaunchAgent (as JSON from plutil) into explicit settings. Any
 * option Recall cannot reproduce exactly fails closed instead of being dropped:
 * dropping --e2ee or an alias would silently change what the cloud receives.
 */
export function parseLegacyPlist(plist: unknown, paths: CloudPaths, osHostname: () => string = hostname): LegacySettings {
  const root = plist && typeof plist === "object" ? (plist as Record<string, unknown>) : {};
  // bootout targets the expected label only, so a plist whose real Label differs would keep
  // running a second job. Require the exact label or leave everything unchanged.
  if (root.Label !== LEGACY_LAUNCHD_LABEL) {
    throw unsupported("The existing sync job does not have the standard Recall Cloud Sync label, so it was left unchanged");
  }
  const argv = Array.isArray(root.ProgramArguments) && root.ProgramArguments.every((v) => typeof v === "string")
    ? (root.ProgramArguments as string[])
    : null;
  if (!argv || argv.length < 3 || basename(argv[1]) !== "recall-sync.mjs" || argv[2] !== "watch") {
    throw unsupported("The existing sync job is not a standard Recall Cloud watch job, so it was left unchanged");
  }
  const flags = new Map<string, string[]>();
  let e2ee = false;
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.startsWith("--") ? arg.slice(2) : "";
    const label = /^[a-z0-9-]{1,40}$/.test(name) ? `--${name}` : "an unknown argument";
    if (name === "e2ee") {
      e2ee = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw unsupported(`The existing sync job uses an option Recall cannot migrate safely (${label}), so it was left unchanged`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw unsupported(`The existing sync job is missing a value for ${label}, so it was left unchanged`);
    }
    const existing = flags.get(name) ?? [];
    if (existing.length > 0 && name !== "device-alias") {
      throw unsupported(`The existing sync job repeats ${label}, so it was left unchanged`);
    }
    flags.set(name, [...existing, value]);
    i++;
  }

  const env: Record<string, string> = {};
  if (root.EnvironmentVariables && typeof root.EnvironmentVariables === "object") {
    for (const [key, value] of Object.entries(root.EnvironmentVariables as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      if ((key.startsWith("RECALL_CLOUD_") || key.startsWith("RECALL_")) && !KNOWN_ENV.has(key)) {
        throw unsupported("The existing sync job sets an environment option Recall cannot migrate safely, so it was left unchanged");
      }
      env[key] = value;
    }
  }

  const first = (name: string): string | undefined => flags.get(name)?.[0];
  const home = paths.home;
  // launchd resolves relative paths against WorkingDirectory and expands defaults from the
  // job's own HOME. The daemon has neither, so anything that would depend on them fails closed.
  const legacyHome = env.HOME;
  const homeDiffers = legacyHome !== undefined && resolve(legacyHome) !== resolve(home);
  const absolutePath = (value: string | undefined, fallback: string, label: string): string => {
    const raw = value ?? fallback;
    const usesHome = value === undefined || value === "~" || value.startsWith("~/");
    if (usesHome && homeDiffers) {
      throw unsupported(`The existing sync job runs with a different HOME, so its ${label} cannot be moved safely and it was left unchanged`);
    }
    const expanded = expandHome(raw, home);
    if (!isAbsolute(expanded)) {
      throw unsupported(`The existing sync job uses a relative ${label}, so it was left unchanged`);
    }
    return resolve(expanded);
  };
  const apiValue = first("api") ?? env.RECALL_CLOUD_API;
  const tokenFile = first("token-file");
  if (!apiValue) throw unsupported("The existing sync job has no API address, so it was left unchanged");
  if (!tokenFile) {
    throw unsupported("The existing sync job does not use a token file. Use Connect with a fresh token instead.");
  }
  let passphrase: string | null = null;
  if (e2ee) {
    passphrase = env.RECALL_CLOUD_E2EE_PASSPHRASE ?? null;
    if (!passphrase) {
      throw new CloudError(
        "The existing sync job uses end-to-end encryption but its passphrase is not recoverable. Nothing was changed; reconnect with your passphrase instead.",
        "encryption-required",
        409,
      );
    }
  }
  const retention = first("rejected-retention-days") ?? env.RECALL_REJECTED_RETENTION_DAYS;
  return {
    api: validateApi(apiValue),
    tokenFile: absolutePath(tokenFile, tokenFile, "token file"),
    intervalSeconds: first("interval") ? parseInt10(first("interval")!, 1, "interval") : 300,
    deviceId: first("device-id") ?? env.RECALL_CLOUD_DEVICE_ID ?? env.HOSTNAME ?? osHostname(),
    deviceAliases: parseAliases(flags.get("device-alias") ?? []),
    dbPath: absolutePath(first("db") ?? env.RECALL_DB, join(home, ".recall", "recall.db"), "database path"),
    stateFile: absolutePath(first("state-file"), join(home, ".config", "recall-cloud", "sync-state.json"), "sync state file"),
    fullReconcileSeconds: first("full-reconcile-interval") ? parseInt10(first("full-reconcile-interval")!, 1, "reconcile interval") : null,
    statuses: first("status") ?? null,
    limit: first("limit") ? parseInt10(first("limit")!, 1, "limit") : null,
    rejectedRetentionDays: retention != null ? parseInt10(retention, 0, "retention") : null,
    e2ee,
    passphrase,
  };
}

export type LaunchctlResult = { status: number | null; stdout: string; stderr: string };
export type LaunchctlFn = (args: string[]) => LaunchctlResult;
export type LegacyLoadedState = "loaded" | "absent" | "unknown";

export interface LegacyDeps {
  paths: CloudPaths;
  platform?: NodeJS.Platform;
  launchctl?: LaunchctlFn;
  readPlist?: (plistPath: string) => unknown;
  uid?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

function defaultLaunchctl(args: string[]): LaunchctlResult {
  const result = spawnSync("launchctl", args, { encoding: "utf8", timeout: 10_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function defaultReadPlist(plistPath: string): unknown {
  const stat = lstatSync(plistPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw unsupported("The existing sync job file is not a regular file");
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw unsupported("The existing sync job file could not be read");
  return JSON.parse(result.stdout);
}

/** Handles only the old dev.recallmemory.cloud-sync LaunchAgent. It never deletes the token. */
export class LegacyLaunchd {
  private readonly platform: NodeJS.Platform;
  private readonly launchctl: LaunchctlFn;
  private readonly readPlist: (plistPath: string) => unknown;
  private readonly uid: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly deps: LegacyDeps) {
    this.platform = deps.platform ?? process.platform;
    this.launchctl = deps.launchctl ?? defaultLaunchctl;
    this.readPlist = deps.readPlist ?? defaultReadPlist;
    this.uid = deps.uid ?? (() => (typeof process.getuid === "function" ? process.getuid() : 0));
    this.sleep = deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.now = deps.now ?? (() => new Date());
  }

  private get target(): string {
    return `gui/${this.uid()}/${LEGACY_LAUNCHD_LABEL}`;
  }

  plistExists(): boolean {
    if (this.platform !== "darwin") return false;
    try {
      lstatSync(this.deps.paths.legacyPlist);
      return true;
    } catch {
      return false;
    }
  }

  loadedState(): LegacyLoadedState {
    if (this.platform !== "darwin") return "absent";
    const result = this.launchctl(["print", this.target]);
    if (result.status === 0) return "loaded";
    if (result.status === 113 || /could not find service|not found/i.test(`${result.stderr}${result.stdout}`)) return "absent";
    return "unknown";
  }

  readSettings(): LegacySettings {
    return parseLegacyPlist(this.readPlist(this.deps.paths.legacyPlist), this.deps.paths);
  }

  /** Boots the old job out, then requires launchd to prove it is gone. Fails closed otherwise. */
  async bootoutAndProve(): Promise<void> {
    this.launchctl(["bootout", this.target]);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.loadedState() === "absent") return;
      await this.sleep(300);
    }
    throw new CloudError(
      "macOS did not stop the old Recall Cloud Sync item (it may be blocked in Login Items & Extensions). Nothing was started, so there is no duplicate sync. Allow or remove the old item, then try again.",
      "migration-blocked",
      409,
    );
  }

  /** Moves the old plist out of LaunchAgents (kept for rollback) so it cannot relaunch at login. */
  retirePlist(): string {
    const { legacyPlist, backupDir } = this.deps.paths;
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    const backup = join(backupDir, `${LEGACY_LAUNCHD_LABEL}.plist.${stamp}`);
    try {
      ensurePrivateDir(backupDir);
      try {
        renameSync(legacyPlist, backup);
      } catch {
        copyFileSync(legacyPlist, backup);
        rmSync(legacyPlist, { force: true });
      }
      chmodSync(backup, 0o600);
      return backup;
    } catch {
      throw new CloudError(
        "The old sync job was stopped but its LaunchAgent file could not be moved aside, so cloud sync was not started.",
        "migration-blocked",
        409,
      );
    }
  }
}

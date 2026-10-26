import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { CloudError } from "./errors.js";
import { type CloudPaths } from "./paths.js";
import { writePrivateFile } from "./private-files.js";

/**
 * Non-secret cloud settings. The file is absent on a fresh install, and absent or
 * `enabled: false` means no worker and no network traffic. Secrets (token,
 * E2EE passphrase) live in separate 0600 files referenced here.
 */
export interface CloudConfig {
  version: 1;
  enabled: boolean;
  /** Separate consent to send question text for bounded online retrieval. */
  queryEnrichment?: boolean;
  /** ISO time of the user's explicit opt-in; `enabled` is refused without it. */
  optInAt: string | null;
  api: string;
  deviceId: string;
  deviceAliases: Record<string, string>;
  intervalSeconds: number;
  fullReconcileSeconds: number | null;
  statuses: string | null;
  limit: number | null;
  rejectedRetentionDays: number | null;
  dbPath: string;
  stateFile: string;
  tokenFile: string;
  e2ee: boolean;
  passphraseFile: string | null;
  migratedFrom: "legacy-launchd" | null;
  /** Migration staged but legacy job not yet proven stopped. Never runs a worker. */
  migrationPending: boolean;
}

export function loadCloudConfig(paths: CloudPaths): CloudConfig | null {
  if (!existsSync(paths.configFile)) return null;
  const stat = lstatSync(paths.configFile);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CloudError("Cloud settings file is not a regular file", "config-invalid");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.configFile, "utf8"));
  } catch {
    throw new CloudError("Cloud settings file is not valid JSON", "config-invalid");
  }
  return validateConfig(raw);
}

export function saveCloudConfig(paths: CloudPaths, config: CloudConfig): void {
  validateConfig(config);
  writePrivateFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
}

export function validateConfig(value: unknown): CloudConfig {
  const bad = (field: string): never => {
    throw new CloudError(`Cloud settings are invalid (${field})`, "config-invalid");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad("root");
  const c = value as Record<string, unknown>;
  if (c.version !== 1) bad("version");
  const str = (key: string): string => (typeof c[key] === "string" && c[key] ? (c[key] as string) : bad(key));
  const optStr = (key: string): string | null => (c[key] == null ? null : typeof c[key] === "string" ? (c[key] as string) : bad(key));
  const optInt = (key: string, min: number): number | null => {
    if (c[key] == null) return null;
    const n = c[key];
    return typeof n === "number" && Number.isInteger(n) && n >= min ? n : bad(key);
  };
  const bool = (key: string): boolean => (typeof c[key] === "boolean" ? (c[key] as boolean) : bad(key));
  const aliases = c.deviceAliases ?? {};
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) bad("deviceAliases");
  for (const [from, to] of Object.entries(aliases as Record<string, unknown>)) {
    if (!from || typeof to !== "string" || !to || from.includes(":") || to.includes(":")) bad("deviceAliases");
  }
  const config: CloudConfig = {
    version: 1,
    enabled: bool("enabled"),
    optInAt: optStr("optInAt"),
    api: str("api"),
    deviceId: str("deviceId"),
    deviceAliases: { ...(aliases as Record<string, string>) },
    intervalSeconds: optInt("intervalSeconds", 1) ?? bad("intervalSeconds"),
    fullReconcileSeconds: optInt("fullReconcileSeconds", 1),
    statuses: optStr("statuses"),
    limit: optInt("limit", 1),
    rejectedRetentionDays: optInt("rejectedRetentionDays", 0),
    dbPath: str("dbPath"),
    stateFile: str("stateFile"),
    tokenFile: str("tokenFile"),
    e2ee: bool("e2ee"),
    passphraseFile: optStr("passphraseFile"),
    migratedFrom: c.migratedFrom == null ? null : c.migratedFrom === "legacy-launchd" ? "legacy-launchd" : bad("migratedFrom"),
    migrationPending: c.migrationPending === true,
    ...(c.queryEnrichment === undefined ? {} : {
      queryEnrichment: typeof c.queryEnrichment === "boolean" ? c.queryEnrichment : bad("queryEnrichment"),
    }),
  };
  for (const key of ["dbPath", "stateFile", "tokenFile"] as const) {
    if (!isAbsolute(config[key])) bad(key);
  }
  if (config.passphraseFile && !isAbsolute(config.passphraseFile)) bad("passphraseFile");
  if (config.e2ee && !config.passphraseFile) bad("passphraseFile");
  if (config.enabled && !config.optInAt) bad("optInAt");
  if (config.enabled && config.migrationPending) bad("migrationPending");
  return config;
}

/**
 * Arguments for the vendored engine's `watch` command. Every identity input
 * (api, device id, db path) is passed explicitly, so inherited environment
 * can never change the sync-state cursor key. The token and passphrase are never
 * arguments: the token is read from a private file, the passphrase is
 * handed over through the child's environment.
 */
export function buildEngineArgs(config: CloudConfig, enginePath: string): string[] {
  const args = [
    enginePath,
    "watch",
    "--api", config.api,
    "--token-file", config.tokenFile,
    "--interval", String(config.intervalSeconds),
    "--device-id", config.deviceId,
    "--db", config.dbPath,
    "--state-file", config.stateFile,
  ];
  for (const [from, to] of Object.entries(config.deviceAliases).sort(([a], [b]) => a.localeCompare(b))) {
    args.push("--device-alias", `${from}=${to}`);
  }
  if (config.fullReconcileSeconds != null) args.push("--full-reconcile-interval", String(config.fullReconcileSeconds));
  if (config.statuses) args.push("--status", config.statuses);
  if (config.limit != null) args.push("--limit", String(config.limit));
  if (config.rejectedRetentionDays != null) args.push("--rejected-retention-days", String(config.rejectedRetentionDays));
  if (config.e2ee) args.push("--e2ee");
  return args;
}

const CHILD_ENV_ALLOW = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "TEMP", "TMP", "USERPROFILE",
  "SystemRoot", "windir", "APPDATA", "LOCALAPPDATA", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "no_proxy", "all_proxy",
]);

/**
 * Child environment: an allowlist, so inherited RECALL_*, NODE_OPTIONS and any
 * other variable the engine could read (db, device, status, e2ee overrides)
 * never reach it. The E2EE passphrase is added only when encryption is on.
 */
export function buildChildEnv(base: NodeJS.ProcessEnv, passphrase: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && (CHILD_ENV_ALLOW.has(key) || key.startsWith("LC_"))) env[key] = value;
  }
  if (passphrase) env.RECALL_CLOUD_E2EE_PASSPHRASE = passphrase;
  return env;
}

/** Same rule as the sync engine: HTTPS, or loopback HTTP, without URL credentials. */
export function validateApi(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new CloudError("Recall Cloud API URL is invalid", "invalid");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password) {
    throw new CloudError("Recall Cloud API must use HTTPS (or loopback HTTP) without URL credentials", "invalid");
  }
  return url.href.replace(/\/$/, "");
}

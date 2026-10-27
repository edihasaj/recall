import { realpathSync, statSync } from "node:fs";
import type { RecallDb } from "../db/client.js";
import { loadCloudConfig, saveCloudConfig, validateApi } from "./config.js";
import { CloudError } from "./errors.js";
import { resolveCloudPaths } from "./paths.js";
import { readPrivateSecret, validatePrivateFile } from "./private-files.js";

export interface CloudQueryConnection {
  api: string;
  token: string;
  /** Atomic config replacement changes this even when consent is re-enabled. */
  consentVersion: string;
}

/** Reading an unavailable or invalid optional connection must not break local recall. */
export function loadCloudQueryConnection(
  db: RecallDb, env: NodeJS.ProcessEnv = process.env,
): CloudQueryConnection | null {
  if (env.RECALL_DISTRIBUTION === "mac-app-store") return null;
  try {
    const paths = resolveCloudPaths(env);
    const config = loadCloudConfig(paths);
    if (!config?.enabled || !config.optInAt || !config.queryEnrichment
      || config.e2ee || config.migrationPending) return null;
    validatePrivateFile(paths.configFile);
    // Standalone benchmark/test databases and a second installation must never
    // borrow credentials merely because they share the process environment.
    if (realpathSync(config.dbPath) !== realpathSync(db.$client.name)) return null;
    const stat = statSync(paths.configFile);
    return { api: validateApi(config.api), token: readPrivateSecret(config.tokenFile, "Cloud token"),
      consentVersion: `${stat.ino}:${stat.mtimeMs}` };
  } catch {
    return null;
  }
}

export function cloudQueryStatus(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean; connected: boolean; available: boolean;
} {
  const config = loadCloudConfig(resolveCloudPaths(env));
  return {
    enabled: config?.queryEnrichment === true,
    connected: config?.enabled === true && Boolean(config.optInAt) && !config.migrationPending,
    available: env.RECALL_DISTRIBUTION !== "mac-app-store" && !config?.e2ee,
  };
}

export function setCloudQueryEnabled(enabled: boolean, env: NodeJS.ProcessEnv = process.env): void {
  const paths = resolveCloudPaths(env);
  const config = loadCloudConfig(paths);
  if (!config) {
    if (!enabled) return;
    throw new CloudError("Connect Recall Cloud before enabling online retrieval", "unavailable");
  }
  if (enabled) {
    if (env.RECALL_DISTRIBUTION === "mac-app-store" || config.e2ee) {
      throw new CloudError("Online retrieval requires the direct edition and server-readable Cloud sync", "unavailable");
    }
    if (!config.enabled || !config.optInAt || config.migrationPending) {
      throw new CloudError("Connect Recall Cloud before enabling online retrieval", "unavailable");
    }
    validatePrivateFile(paths.configFile);
    validateApi(config.api);
    readPrivateSecret(config.tokenFile, "Cloud token");
  }
  saveCloudConfig(paths, { ...config, queryEnrichment: enabled });
}

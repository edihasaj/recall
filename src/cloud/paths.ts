import { homedir } from "node:os";
import { join } from "node:path";

export const LEGACY_LAUNCHD_LABEL = "dev.recallmemory.cloud-sync";
export const DEFAULT_CLOUD_API = "https://api.recallmemory.dev";

export interface CloudPaths {
  home: string;
  /** Recall data directory (holds recall.db, cloud.json). */
  dataDir: string;
  /** Non-secret cloud settings and the explicit opt-in record. */
  configFile: string;
  dbFile: string;
  /** PID record of the running sync child, used to reap orphans after a daemon crash. */
  pidFile: string;
  /** ~/.config/recall-cloud: same private directory the legacy installer used. */
  cloudDir: string;
  tokenFile: string;
  passphraseFile: string;
  stateFile: string;
  /** Where a retired legacy LaunchAgent plist is kept for rollback. */
  backupDir: string;
  legacyPlist: string;
}

export function resolveCloudPaths(env: NodeJS.ProcessEnv = process.env): CloudPaths {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const dataDir = env.RECALL_DATA_DIR ?? join(home, ".recall");
  const cloudDir = join(home, ".config", "recall-cloud");
  return {
    home,
    dataDir,
    configFile: join(dataDir, "cloud.json"),
    dbFile: join(dataDir, "recall.db"),
    pidFile: join(dataDir, "cloud-worker.pid"),
    cloudDir,
    tokenFile: join(cloudDir, "token"),
    passphraseFile: join(cloudDir, "e2ee-passphrase"),
    stateFile: join(cloudDir, "sync-state.json"),
    backupDir: join(cloudDir, "legacy-backup"),
    legacyPlist: join(home, "Library", "LaunchAgents", `${LEGACY_LAUNCHD_LABEL}.plist`),
  };
}

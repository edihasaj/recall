import { existsSync } from "node:fs";
import { bootstrapEmbeddings, flushEmbeddingJobs, loadEmbeddingConfigFromEnv } from "../embeddings/embeddings.js";
import { bootstrapHistoryEmbeddings } from "../history/retrieval.js";
import { closeDb, getDbPath, getDbUserVersion, initDb, RECALL_DB_USER_VERSION, resetDb, type RecallDb } from "../db/client.js";
import { discoverLocalRepos } from "../repo/discovery.js";
import { scanAndStore } from "../scanner/repo.js";

export interface DestructiveResetRolloutResult {
  performed: boolean;
  reason: "fresh_install" | "schema_upgrade" | "current";
  previous_user_version: number;
  target_user_version: number;
  repos_scanned: number;
  memories_created: number;
  embeddings_bootstrapped: number;
  history_embeddings_bootstrapped: number;
}

export function needsDestructiveReset(dbPath = getDbPath()): boolean {
  if (!existsSync(dbPath)) return true;
  return getDbUserVersion(dbPath) < RECALL_DB_USER_VERSION;
}

export async function runDestructiveResetRollout(
  options: {
    dbPath?: string;
    searchRoots?: string[];
    purgeModels?: boolean;
    logger?: (message: string) => void;
  } = {},
): Promise<{ db: RecallDb; result: DestructiveResetRolloutResult }> {
  const dbPath = options.dbPath ?? getDbPath();
  const previousUserVersion = existsSync(dbPath) ? getDbUserVersion(dbPath) : 0;
  const reason: DestructiveResetRolloutResult["reason"] = !existsSync(dbPath)
    ? "fresh_install"
    : previousUserVersion < RECALL_DB_USER_VERSION
      ? "schema_upgrade"
      : "current";

  if (reason === "current") {
    return {
      db: initDb(dbPath),
      result: {
        performed: false,
        reason,
        previous_user_version: previousUserVersion,
        target_user_version: RECALL_DB_USER_VERSION,
        repos_scanned: 0,
        memories_created: 0,
        embeddings_bootstrapped: 0,
        history_embeddings_bootstrapped: 0,
      },
    };
  }

  options.logger?.("[recall] rollout: resetting local memory store");
  resetDb(dbPath, { purgeModels: options.purgeModels });
  closeDb();
  const db = initDb(dbPath);

  const repos = discoverLocalRepos(options.searchRoots);
  options.logger?.(`[recall] rollout: scanning ${repos.length} local repos`);
  const previousEmbeddingsDisabled = process.env.RECALL_EMBEDDINGS_DISABLED;
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  let memoriesCreated = 0;
  try {
    for (const repo of repos) {
      memoriesCreated += scanAndStore(db, repo.repo_path).length;
    }
  } finally {
    if (previousEmbeddingsDisabled == null) {
      delete process.env.RECALL_EMBEDDINGS_DISABLED;
    } else {
      process.env.RECALL_EMBEDDINGS_DISABLED = previousEmbeddingsDisabled;
    }
  }

  await flushEmbeddingJobs();

  const embeddingConfig = loadEmbeddingConfigFromEnv();
  if (embeddingConfig) {
    options.logger?.("[recall] rollout: bootstrapping memory embeddings");
  }
  const embeddingsBootstrapped = embeddingConfig
    ? await bootstrapEmbeddings(db, embeddingConfig)
    : 0;
  if (embeddingConfig) {
    options.logger?.("[recall] rollout: bootstrapping history embeddings");
  }
  const historyEmbeddingsBootstrapped = embeddingConfig
    ? await bootstrapHistoryEmbeddings(db, embeddingConfig)
    : 0;

  return {
    db,
    result: {
      performed: true,
      reason,
      previous_user_version: previousUserVersion,
      target_user_version: RECALL_DB_USER_VERSION,
      repos_scanned: repos.length,
      memories_created: memoriesCreated,
      embeddings_bootstrapped: embeddingsBootstrapped,
      history_embeddings_bootstrapped: historyEmbeddingsBootstrapped,
    },
  };
}

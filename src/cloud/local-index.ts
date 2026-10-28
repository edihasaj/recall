import { realpathSync } from "node:fs";
import type { RecallDb } from "../db/client.js";
import {
  bootstrapEmbeddings, loadEmbeddingConfigFromEnv,
  rebuildEmbeddingIndexResponsive, verifyEmbeddings,
} from "../embeddings/embeddings.js";
import { rebuildMemoryFtsIndexResponsive, verifyMemoryFtsIndex } from "../vector/sqlite-fts.js";
import { withMemoryIndexLock } from "../embeddings/index-lock.js";

/** Runs only local embedding providers, after a successful device pull. */
export function createCloudIndexRefresher(
  db: RecallDb, onError: () => void = () => {},
): (dbPath: string) => Promise<void> {
  let pending = false;
  let running: Promise<void> | null = null;
  return (dbPath) => {
    // A second store must not refresh this daemon's unrelated database.
    try {
      if (realpathSync(dbPath) !== realpathSync(db.$client.name)) return Promise.resolve();
    } catch { return Promise.resolve(); }
    pending = true;
    if (running) return running;
    running = (async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      do {
        pending = false;
        await withMemoryIndexLock(db, async () => {
          // Build keyword retrieval before inference on a fresh/offline device.
          if (verifyMemoryFtsIndex(db).drift !== 0) await rebuildMemoryFtsIndexResponsive(db);
          const config = loadEmbeddingConfigFromEnv();
          if (!config) return;
          const state = verifyEmbeddings(db, config);
          if (state.stale > 0) await bootstrapEmbeddings(db, config);
          else if (state.index_drift !== 0 || state.lexical_drift !== 0) {
            await rebuildEmbeddingIndexResponsive(db, config);
          }
        });
      } while (pending);
    })().catch(onError).finally(() => { running = null; });
    return running;
  };
}

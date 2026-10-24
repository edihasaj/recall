import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudError } from "./errors.js";

const ENGINE_DIR = join("vendor", "recall-cloud-sync");

export interface EngineFiles {
  /** Unmodified upstream recall-sync.mjs. */
  engine: string;
  /** Recall-authored wrapper that binds the engine's lifetime to the daemon. */
  wrapper: string;
}

/**
 * Locates the bundled sync engine. It ships as a plain resource directory
 * (vendor/recall-cloud-sync) next to dist/ in the npm package and in the app's
 * Runtime, and two levels above src/cloud when running from source.
 */
export function resolveEngineFiles(fromUrl: string = import.meta.url): EngineFiles {
  const here = dirname(fileURLToPath(fromUrl));
  for (const up of ["..", join("..", "..")]) {
    const dir = join(here, up, ENGINE_DIR);
    const engine = join(dir, "recall-sync.mjs");
    const wrapper = join(dir, "managed-worker.mjs");
    if (existsSync(engine) && existsSync(wrapper)) return { engine, wrapper };
  }
  throw new CloudError("The Recall Cloud sync engine is not bundled with this install", "engine-missing", 500);
}

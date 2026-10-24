import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "@huggingface/transformers";
import { getEmbeddingCacheRoot } from "./cache.js";

/**
 * Point the library-wide Transformers.js cache at the user cache root.
 *
 * Transformers.js defaults `env.cacheDir` to `.cache` inside its own package
 * directory. `pipeline()` resolves the file list (and therefore `config.json`)
 * without the per-model `cache_dir` option, and the wasm cache uses the same
 * default, so those files were written into `Recall.app/.../node_modules`.
 * That invalidates the app's code signature. Every provider and the reranker
 * call this before loading anything; the per-model `cache_dir` options still
 * select the model directories.
 */
export function configureTransformersCache(): string {
  const cacheDir = join(getEmbeddingCacheRoot(), "shared");
  mkdirSync(cacheDir, { recursive: true });
  env.cacheDir = cacheDir;
  return cacheDir;
}

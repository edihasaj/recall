import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EmbeddingConfig } from "../types.js";

export function getEmbeddingCacheRoot(): string {
  if (process.platform === "linux" && process.env.XDG_CACHE_HOME) {
    return join(process.env.XDG_CACHE_HOME, "recall", "models");
  }
  return join(homedir(), ".recall", "models");
}

export function getEmbeddingCachePath(
  config: Pick<EmbeddingConfig, "provider" | "model">,
): string {
  return join(getEmbeddingCacheRoot(), config.provider, ...config.model.split("/"));
}

export function ensureEmbeddingCachePath(
  config: Pick<EmbeddingConfig, "provider" | "model">,
): string {
  const cachePath = getEmbeddingCachePath(config);
  mkdirSync(cachePath, { recursive: true });
  return cachePath;
}

export function getDirectorySize(path: string): number {
  if (!existsSync(path)) return 0;

  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;

  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    total += getDirectorySize(join(path, entry.name));
  }
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { AutoConfig, env } from "@huggingface/transformers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureTransformersCache } from "../src/embeddings/transformers-cache.js";

const originalCacheDir = env.cacheDir;
const originalFetch = env.fetch;
const originalRemote = env.allowRemoteModels;
const originalLocal = env.allowLocalModels;

beforeEach(() => {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
});

afterEach(() => {
  env.cacheDir = originalCacheDir;
  env.fetch = originalFetch;
  env.allowRemoteModels = originalRemote;
  env.allowLocalModels = originalLocal;
  vi.unstubAllEnvs();
});

function packageDir(): string {
  return join(dirname(fileURLToPath(import.meta.resolve("@huggingface/transformers"))), "..");
}

it("moves the library-wide cache out of the Transformers.js package directory", () => {
  const root = mkdtempSync(join(tmpdir(), "recall-tf-cache-"));
  vi.stubEnv("RECALL_EMBEDDING_CACHE_DIR", root);

  const cacheDir = configureTransformersCache();

  expect(env.cacheDir).toBe(cacheDir);
  expect(existsSync(cacheDir)).toBe(true);
  const fromRoot = relative(root, cacheDir);
  expect(fromRoot.startsWith("..") || isAbsolute(fromRoot)).toBe(false);
  const fromPackage = relative(packageDir(), cacheDir);
  expect(fromPackage.startsWith("..") || isAbsolute(fromPackage)).toBe(true);
});

it("writes a config fetched without a per-model cache_dir under the user cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "recall-tf-cache-"));
  vi.stubEnv("RECALL_EMBEDDING_CACHE_DIR", root);
  const packageCache = join(packageDir(), ".cache");
  const before = existsSync(packageCache) ? readdirSync(packageCache, { recursive: true }).length : 0;

  configureTransformersCache();
  env.fetch = (async () =>
    new Response(JSON.stringify({ model_type: "bert" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  // pipeline() loads config.json this way: no cache_dir reaches the call.
  const config = await AutoConfig.from_pretrained("recall-test/cache-location");
  expect(config.model_type).toBe("bert");

  const files = readdirSync(root, { recursive: true }).map(String);
  expect(files.some((file) => file.endsWith("config.json"))).toBe(true);
  const after = existsSync(packageCache) ? readdirSync(packageCache, { recursive: true }).length : 0;
  expect(after).toBe(before);
});

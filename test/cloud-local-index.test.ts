import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { initStandaloneDb } from "../src/db/client.js";
import { createCloudIndexRefresher } from "../src/cloud/local-index.js";
import { loadCloudQueryConnection } from "../src/cloud/query-settings.js";
import { semanticSearch, verifyEmbeddings } from "../src/embeddings/embeddings.js";
import { installMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";
import { makeService } from "./helpers/cloud-fakes.js";
import { resolveCloudPaths } from "../src/cloud/paths.js";
import { loadMaintenanceConfigFromEnv, runMaintenanceCycle } from "../src/maintenance/lifecycle.js";

const engineUrl = pathToFileURL(resolve("vendor/recall-cloud-sync/recall-sync.mjs")).href;
const { applyPulledRecords, e2eeKey, e2eeEncrypt, e2eeDecrypt } = await import(/* @vite-ignore */ engineUrl);
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const home = mkdtempSync("/tmp/recall-private-index-");
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, RECALL_DATA_DIR: join(home, ".recall") };
  mkdirSync(env.RECALL_DATA_DIR);
  const db = initStandaloneDb(resolveCloudPaths(env).dbFile);
  cleanups.push(() => db.$client.close());
  return { db, env };
}

function encryptedRecord(text: string, note: string, updatedAt = "2026-10-27T00:00:00Z") {
  const key = e2eeKey("test-only recovery words");
  const sealed = e2eeEncrypt(key, JSON.stringify({ text, recall: {
    type: "rule", scope: "repo", repo: "private/project", source: "user_correction", note,
  } }));
  return {
    key, record: {
      externalId: "device-a:private-rule", encryptionMode: "e2ee", contentCiphertext: sealed.ciphertext,
      contentNonce: sealed.nonce, kind: "rule", status: "active", confidence: 0.95,
      metadata: { localMemoryId: "private-rule", deviceId: "device-a" },
      createdAt: "2026-10-26T00:00:00Z", updatedAt,
    },
  };
}

it("restores encrypted content, builds vectors locally, searches offline, and reindexes changed notes", async () => {
  const { db, env } = fixture();
  await makeService(env).service.connect({ token: "fixture-token", optIn: true,
    privacyMode: "private", e2eePassphrase: "test-only recovery words" });
  expect(loadCloudQueryConnection(db, env)).toBeNull();
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "false");
  vi.stubEnv("RECALL_EMBEDDING_DIMS", "3");
  vi.stubEnv("RECALL_EMBEDDING_VERSION", "private-test");
  const vectors = installMockEmbeddingProvider((text) => text.includes("Python") ? [1, 0, 0] : [0, 1, 0]);
  const network = vi.fn(() => { throw new Error("offline"); });
  vi.stubGlobal("fetch", network);
  const { record, key } = encryptedRecord("Use uv for dependencies.", "Python package manager");
  const apply = (r: typeof record) => applyPulledRecords(db.$client.name, [r], {
    deviceId: "device-b", e2ee: { key }, decrypt: e2eeDecrypt,
  });
  apply(record);
  const config = { provider: "nomic" as const, model: "nomic-ai/nomic-embed-text-v1.5", dimensions: 3,
    version: "private-test", similarity_threshold: 0.8 };
  const refresh = createCloudIndexRefresher(db);
  await refresh(db.$client.name);
  expect(db.$client.prepare("SELECT count(*) AS n FROM fts_memory_index WHERE text MATCH 'Python'").get()).toEqual({ n: 1 });
  expect(verifyEmbeddings(db, config)).toMatchObject({ stale: 0, indexed: 1, index_drift: 0 });
  expect((await semanticSearch(db, "Python tooling", config))[0]?.memory.text).toBe("Use uv for dependencies.");
  expect(vectors).toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
  // An applicability note is part of semantic content, not just display metadata.
  const newer = encryptedRecord("Use uv for dependencies.", "JavaScript workflow", "2026-10-28T00:00:00Z");
  apply(newer.record);
  expect(verifyEmbeddings(db, config).stale).toBe(1);
  await refresh(db.$client.name);
  expect(await semanticSearch(db, "Python tooling", config)).toEqual([]);
  expect((await semanticSearch(db, "JavaScript", config))[0]?.memory.note).toBe("JavaScript workflow");
});

it("coalesces repeated notifications and leaves other databases alone", async () => {
  const { db } = fixture();
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
  const { record, key } = encryptedRecord("Use uv.", "Python package manager");
  applyPulledRecords(db.$client.name, [record], { deviceId: "b", e2ee: { key }, decrypt: e2eeDecrypt });
  const refresh = createCloudIndexRefresher(db);
  const first = refresh(db.$client.name);
  expect(refresh(db.$client.name)).toBe(first);
  await first;
  expect(db.$client.prepare("SELECT count(*) AS n FROM fts_memory_index WHERE text MATCH 'Python'").get()).toEqual({ n: 1 });
  await expect(refresh("/nonexistent/other.db")).resolves.toBeUndefined();
});

it("contains background failures so local queries stay available and a later pull can retry", async () => {
  const { db } = fixture();
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "false");
  const errors = vi.fn();
  const refresh = createCloudIndexRefresher(db, errors);
  const { record, key } = encryptedRecord("Use uv.", "Python");
  applyPulledRecords(db.$client.name, [record], { deviceId: "b", e2ee: { key }, decrypt: e2eeDecrypt });
  installMockEmbeddingProvider(() => { throw new Error("model unavailable"); });
  await expect(refresh(db.$client.name)).resolves.toBeUndefined();
  expect(errors).toHaveBeenCalledOnce();
  expect(db.$client.prepare("SELECT count(*) AS n FROM fts_memory_index WHERE text MATCH 'Python'").get()).toEqual({ n: 1 });
  vi.restoreAllMocks();
  vi.stubEnv("RECALL_EMBEDDING_DIMS", "3");
  installMockEmbeddingProvider(() => [1, 0, 0]);
  await refresh(db.$client.name);
  expect(errors).toHaveBeenCalledOnce();
  expect(db.$client.prepare("SELECT count(*) AS n FROM memory_embeddings").get()).toEqual({ n: 1 });
});

it("runs another pass when a new pull changes content during inference", async () => {
  const { db } = fixture();
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "false");
  vi.stubEnv("RECALL_EMBEDDING_DIMS", "3");
  const refresh = createCloudIndexRefresher(db);
  const original = encryptedRecord("Use uv.", "Python");
  const updated = encryptedRecord("Use uv.", "JavaScript", "2026-10-28T00:00:00Z");
  const apply = (record: typeof original.record) => applyPulledRecords(db.$client.name, [record], {
    deviceId: "b", e2ee: { key: original.key }, decrypt: e2eeDecrypt,
  });
  apply(original.record);
  let changed = false;
  installMockEmbeddingProvider((text) => {
    if (!changed) {
      changed = true;
      apply(updated.record);
      void refresh(db.$client.name);
    }
    return text.includes("Python") ? [1, 0, 0] : [0, 1, 0];
  });
  await refresh(db.$client.name);
  const config = { provider: "nomic" as const, model: "nomic-ai/nomic-embed-text-v1.5", dimensions: 3,
    version: "v1", similarity_threshold: 0.8 };
  expect(verifyEmbeddings(db, config).stale).toBe(0);
  expect(await semanticSearch(db, "Python", config)).toEqual([]);
  expect((await semanticSearch(db, "JavaScript", config))[0]?.memory.note).toBe("JavaScript");
});

it("serializes Cloud indexing with scheduled maintenance and keeps unique search rows", async () => {
  const { db } = fixture();
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "false");
  vi.stubEnv("RECALL_EMBEDDING_DIMS", "3");
  const { record, key } = encryptedRecord("Use uv.", "Python");
  const records = Array.from({ length: 100 }, (_, i) => ({ ...record,
    externalId: `device-a:overlap-${i}`, metadata: { ...record.metadata, localMemoryId: `overlap-${i}` },
  }));
  applyPulledRecords(db.$client.name, records, { deviceId: "b", e2ee: { key }, decrypt: e2eeDecrypt });
  let maintenance: ReturnType<typeof runMaintenanceCycle> | undefined;
  let startedMaintenance = false;
  let embeddedDocuments = 0;
  const refresh = createCloudIndexRefresher(db);
  installMockEmbeddingProvider(() => {
    embeddedDocuments++;
    if (!startedMaintenance) {
      startedMaintenance = true;
      maintenance = runMaintenanceCycle(db, { ...loadMaintenanceConfigFromEnv(),
        stale_days: 100000, candidate_unconfirmed_days: 100000, llm_tasks_enabled: false });
    }
    return [1, 0, 0];
  });
  await refresh(db.$client.name);
  expect(maintenance).toBeDefined();
  await maintenance;
  expect(embeddedDocuments).toBe(100);
  for (const table of ["fts_memory_index", "vec_memory_index"]) {
    expect(db.$client.prepare(`SELECT count(*) AS n, count(DISTINCT memory_id) AS unique_n FROM ${table}`).get())
      .toEqual({ n: 100, unique_n: 100 });
  }
});

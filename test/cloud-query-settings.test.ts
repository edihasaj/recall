import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createStandaloneDb } from "../src/db/client.js";
import { loadCloudConfig, saveCloudConfig, validateConfig } from "../src/cloud/config.js";
import { resolveCloudPaths } from "../src/cloud/paths.js";
import { cloudQueryStatus, loadCloudQueryConnection, setCloudQueryEnabled } from "../src/cloud/query-settings.js";
import { makeService, TOKEN } from "./helpers/cloud-fakes.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

async function configured() {
  const home = mkdtempSync("/tmp/recall-cloud-query-settings-");
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, RECALL_DATA_DIR: join(home, ".recall"), PATH: "/usr/bin" };
  const paths = resolveCloudPaths(env);
  const { service } = makeService(env);
  await service.connect({ token: TOKEN, optIn: true });
  const { db, sqlite } = createStandaloneDb(paths.dbFile);
  cleanup.push(() => sqlite.close());
  return { home, env, paths, db, service };
}

it("requires separate query consent, preserves it on reconnect, and supports opt-out", async () => {
  const { env, db, service } = await configured();
  expect(loadCloudQueryConnection(db, env)).toBeNull();
  setCloudQueryEnabled(true, env);
  expect(loadCloudQueryConnection(db, env)).toEqual({ api: "https://api.recallmemory.dev", token: TOKEN });
  await service.connect({ token: TOKEN, optIn: true });
  expect(cloudQueryStatus(env)).toEqual({ enabled: true, connected: true, available: true });
  setCloudQueryEnabled(false, env);
  expect(loadCloudQueryConnection(db, env)).toBeNull();
});

it("never borrows another database's credentials or operates after disconnect", async () => {
  const { home, env, db, service } = await configured();
  setCloudQueryEnabled(true, env);
  const other = createStandaloneDb(join(home, "other.db"));
  cleanup.push(() => other.sqlite.close());
  expect(loadCloudQueryConnection(other.db, env)).toBeNull();
  await service.disconnect();
  expect(loadCloudQueryConnection(db, env)).toBeNull();
});

it("clears query consent when reconnecting with a different token or endpoint", async () => {
  const { env, db, service } = await configured();
  setCloudQueryEnabled(true, env);
  await service.connect({ token: "tok_another_account", optIn: true });
  expect(loadCloudQueryConnection(db, env)).toBeNull();
  setCloudQueryEnabled(true, env);
  await service.connect({ token: "tok_another_account", api: "https://other.example", optIn: true });
  expect(loadCloudQueryConnection(db, env)).toBeNull();
});

it("keeps MAS, E2EE, migrations and invalid credentials local", async () => {
  const { env, paths, db } = await configured();
  setCloudQueryEnabled(true, env);
  expect(loadCloudQueryConnection(db, { ...env, RECALL_DISTRIBUTION: "mac-app-store" })).toBeNull();
  const config = loadCloudConfig(paths)!;
  saveCloudConfig(paths, { ...config, e2ee: true, passphraseFile: paths.passphraseFile });
  expect(loadCloudQueryConnection(db, env)).toBeNull();
  expect(() => setCloudQueryEnabled(true, env)).toThrow(/server-readable/);
  saveCloudConfig(paths, { ...config, enabled: false, migrationPending: true });
  expect(loadCloudQueryConnection(db, env)).toBeNull();
  saveCloudConfig(paths, config);
  chmodSync(paths.tokenFile, 0o644);
  expect(loadCloudQueryConnection(db, env)).toBeNull();
});

it("rejects invalid query consent and does not create configuration on an off/status check", async () => {
  const { env, paths } = await configured();
  expect(() => validateConfig({ ...loadCloudConfig(paths), queryEnrichment: "true" })).toThrow(/queryEnrichment/);
  const empty = { HOME: join(env.HOME, "fresh"), RECALL_DATA_DIR: join(env.HOME, "fresh", ".recall") };
  setCloudQueryEnabled(false, empty);
  expect(cloudQueryStatus(empty).enabled).toBe(false);
  expect(() => setCloudQueryEnabled(true, empty)).toThrow(/Connect Recall Cloud/);
});

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildChildEnv } from "../src/cloud/config.js";
import { engineStateKey } from "../src/cloud/state.js";
import { CloudWorker } from "../src/cloud/worker.js";
import { FakeChild, FakeLegacy, FakeWorker, TOKEN, makeHome, makeService } from "./helpers/cloud-fakes.js";

const homes: string[] = [];
const workers: CloudWorker[] = [];
function home(extra: NodeJS.ProcessEnv = {}) {
  const h = makeHome(extra);
  homes.push(h.home);
  return h;
}
afterEach(() => {
  for (const w of workers.splice(0)) w.killSync();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("fresh install", () => {
  it("starts nothing, writes nothing and reports disconnected", async () => {
    const { env, paths } = home();
    const { service, worker } = makeService(env);
    await service.startIfEnabled();
    expect(worker.launches).toHaveLength(0);
    expect(existsSync(paths.configFile)).toBe(false);
    expect(existsSync(paths.cloudDir)).toBe(false);
    const status = service.status();
    expect(status.state).toBe("disconnected");
    expect(status.enabled).toBe(false);
  });

  it("a disabled config never launches", async () => {
    const { env } = home();
    const first = makeService(env);
    await first.service.connect({ token: TOKEN, optIn: true });
    await first.service.disconnect();
    const second = makeService(env);
    await second.service.startIfEnabled();
    expect(second.worker.launches).toHaveLength(0);
  });
});

describe("connect / disconnect", () => {
  it("requires an explicit opt-in and changes nothing without it", async () => {
    const { env, paths } = home();
    const { service, worker } = makeService(env);
    await expect(service.connect({ token: TOKEN })).rejects.toMatchObject({ code: "opt-in-required" });
    expect(worker.launches).toHaveLength(0);
    expect(existsSync(paths.tokenFile)).toBe(false);
    expect(existsSync(paths.configFile)).toBe(false);
  });

  it("stores the token privately and never exposes it in args, env or status", async () => {
    const { env, paths } = home({ RECALL_CLOUD_API: "https://evil.example", RECALL_DB: "/tmp/other.db", NODE_OPTIONS: "--inspect" });
    const { service, worker } = makeService(env);
    const status = await service.connect({ token: `  ${TOKEN}\n`, optIn: true });
    expect(readFileSync(paths.tokenFile, "utf8")).toBe(TOKEN);
    expect(statSync(paths.tokenFile).mode & 0o777).toBe(0o600);
    expect(statSync(paths.cloudDir).mode & 0o777).toBe(0o700);
    expect(worker.launches).toHaveLength(1);
    const launch = worker.launches[0];
    expect(launch.args[0]).toBe("/engine/managed-worker.mjs");
    expect(launch.args).toContain("--token-file");
    expect(launch.args).toContain(paths.tokenFile);
    expect(JSON.stringify(launch)).not.toContain(TOKEN);
    expect(Object.keys(launch.env)).not.toContain("RECALL_CLOUD_API");
    expect(Object.keys(launch.env)).not.toContain("RECALL_DB");
    expect(Object.keys(launch.env)).not.toContain("NODE_OPTIONS");
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(readFileSync(paths.configFile, "utf8")).not.toContain(TOKEN);
    expect(status.enabled).toBe(true);
    expect(status.config?.api).toBe("https://api.recallmemory.dev");
    expect(launch.args).toContain("test-mac");
  });

  it("passes the E2EE passphrase only through the child environment", async () => {
    const { env, paths } = home();
    const { service, worker } = makeService(env);
    await service.connect({ token: TOKEN, e2eePassphrase: "correct horse battery", optIn: true });
    const launch = worker.launches[0];
    expect(launch.args).toContain("--e2ee");
    expect(launch.args.join(" ")).not.toContain("correct horse");
    expect(launch.env.RECALL_CLOUD_E2EE_PASSPHRASE).toBe("correct horse battery");
    expect(statSync(paths.passphraseFile).mode & 0o777).toBe(0o600);
    expect(service.status().config?.e2ee).toBe(true);
  });

  it("removes secrets on disconnect but keeps the device identity", async () => {
    const { env, paths } = home();
    const { service, worker } = makeService(env);
    await service.connect({ token: TOKEN, e2eePassphrase: "pass", optIn: true });
    const status = await service.disconnect();
    expect(worker.state).toBe("stopped");
    expect(existsSync(paths.tokenFile)).toBe(false);
    expect(existsSync(paths.passphraseFile)).toBe(false);
    expect(status.state).toBe("disconnected");
    const saved = JSON.parse(readFileSync(paths.configFile, "utf8"));
    expect(saved.enabled).toBe(false);
    expect(saved.deviceId).toBe("test-mac");
  });

  it("does not report disconnected when the sync process will not stop", async () => {
    const { env, paths } = home();
    const { service, worker } = makeService(env);
    await service.connect({ token: TOKEN, optIn: true });
    worker.stopError = new Error("did not stop");
    await expect(service.disconnect()).rejects.toMatchObject({ code: "unavailable" });
    expect(JSON.parse(readFileSync(paths.configFile, "utf8")).enabled).toBe(true);
    expect(existsSync(paths.tokenFile)).toBe(true);
  });

  it("never reconnects an encrypted device without its passphrase", async () => {
    const { env, paths } = home();
    const first = makeService(env);
    await first.service.connect({ token: TOKEN, e2eePassphrase: "pass", optIn: true });
    await first.service.disconnect();
    const second = makeService(env);
    await expect(second.service.connect({ token: TOKEN, optIn: true })).rejects.toMatchObject({ code: "encryption-required" });
    expect(second.worker.launches).toHaveLength(0);
    expect(JSON.parse(readFileSync(paths.configFile, "utf8")).e2ee).toBe(true);
    await second.service.connect({ token: TOKEN, e2eePassphrase: "pass", optIn: true });
    expect(second.worker.launches[0].args).toContain("--e2ee");
  });

  it("leaves the config disabled if replacing credentials fails", async () => {
    const { env, paths } = home();
    const { service } = makeService(env);
    await service.connect({ token: TOKEN, optIn: true });
    unlinkSync(paths.tokenFile);
    mkdirSync(paths.tokenFile);
    await expect(service.connect({ token: "another_token", optIn: true })).rejects.toBeTruthy();
    expect(JSON.parse(readFileSync(paths.configFile, "utf8")).enabled).toBe(false);
  });

  it("forces one full reconcile on connect but keeps cursors and other devices", async () => {
    const { env, paths } = home();
    const key = engineStateKey({ api: "https://api.recallmemory.dev", deviceId: "test-mac", dbPath: paths.dbFile });
    mkdirSync(paths.cloudDir, { recursive: true, mode: 0o700 });
    const push = { updatedAt: "2026-01-01", id: "a" };
    writeFileSync(paths.stateFile, JSON.stringify({
      version: 1,
      entries: {
        [key]: { push, pull: push, fullReconciledAt: "2026-01-01T00:00:00.000Z" },
        other: { push: null, pull: null, fullReconciledAt: "keep" },
      },
    }), { mode: 0o600 });
    const { service } = makeService(env);
    await service.connect({ token: TOKEN, optIn: true });
    const state = JSON.parse(readFileSync(paths.stateFile, "utf8"));
    expect(state.entries[key].fullReconciledAt).toBeNull();
    expect(state.entries[key].push).toEqual(push);
    expect(state.entries.other.fullReconciledAt).toBe("keep");
  });
});

describe("full reconcile request", () => {
  it("fails Connect closed, leaving sync disabled, when the reset cannot be written", async () => {
    const { env, paths, home: root } = home();
    // Seed a disconnected config whose state file lives in a directory we can make read-only.
    const seed = makeService(env);
    await seed.service.connect({ token: TOKEN, optIn: true });
    await seed.service.disconnect();
    const stateDir = join(root, "state-ro");
    mkdirSync(stateDir, { recursive: true });
    const stateFile = join(stateDir, "sync-state.json");
    const saved = JSON.parse(readFileSync(paths.configFile, "utf8"));
    const key = engineStateKey({ api: saved.api, deviceId: saved.deviceId, dbPath: saved.dbPath });
    writeFileSync(stateFile, JSON.stringify({ version: 1, entries: { [key]: { fullReconciledAt: "2026-01-01" } } }), { mode: 0o600 });
    writeFileSync(paths.configFile, JSON.stringify({ ...saved, stateFile }), { mode: 0o600 });
    chmodSync(stateDir, 0o500);
    const { service, worker } = makeService(env);
    try {
      await expect(service.connect({ token: TOKEN, optIn: true })).rejects.toBeTruthy();
    } finally {
      chmodSync(stateDir, 0o700);
    }
    expect(worker.launches).toHaveLength(0);
    expect(service.status().enabled).toBe(false);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).entries[key].fullReconciledAt).toBe("2026-01-01");
  });
});

describe("edition and duplicate guards", () => {
  it("the Mac App Store edition is cloud-disabled even with an enabled config on disk", async () => {
    const { env } = home();
    await makeService(env).service.connect({ token: TOKEN, optIn: true });
    const store = makeService({ ...env, RECALL_DISTRIBUTION: "mac-app-store" });
    await store.service.startIfEnabled();
    expect(store.worker.launches).toHaveLength(0);
    expect(store.service.status().state).toBe("unavailable");
    await expect(store.service.connect({ token: TOKEN, optIn: true })).rejects.toMatchObject({ code: "unavailable" });
    await expect(store.service.migrateLegacy({ optIn: true })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("refuses to run beside a legacy job, including when its state is uncertain", async () => {
    const { env } = home();
    const legacy = new FakeLegacy();
    legacy.exists = true;
    const a = makeService(env, { legacy });
    await expect(a.service.connect({ token: TOKEN, optIn: true })).rejects.toMatchObject({ code: "legacy-active" });
    legacy.exists = false;
    legacy.loaded = "unknown";
    await expect(a.service.connect({ token: TOKEN, optIn: true })).rejects.toMatchObject({ code: "legacy-active" });
    expect(a.worker.launches).toHaveLength(0);
  });

  it("does not start an enabled config while the legacy job is loaded", async () => {
    const { env } = home();
    await makeService(env).service.connect({ token: TOKEN, optIn: true });
    const legacy = new FakeLegacy();
    legacy.loaded = "loaded";
    const b = makeService(env, { legacy });
    await b.service.startIfEnabled();
    expect(b.worker.launches).toHaveLength(0);
    const status = b.service.status();
    expect(status.state).toBe("failed");
    expect(status.error).toContain("still running");
  });

  it("connect plus startup spawns exactly one child", async () => {
    const { env } = home();
    const children: FakeChild[] = [];
    const worker = new CloudWorker({ spawn: () => { const c = new FakeChild(); children.push(c); return c as never; } });
    workers.push(worker);
    const { service } = makeService(env, { worker });
    await service.connect({ token: TOKEN, optIn: true });
    await service.startIfEnabled();
    await service.startIfEnabled();
    expect(children).toHaveLength(1);
  });
});

describe("child environment", () => {
  it("is an allowlist", () => {
    const env = buildChildEnv({ PATH: "/bin", HOME: "/h", LC_ALL: "C", RECALL_DB: "x", RECALL_CLOUD_TOKEN: "t", NODE_OPTIONS: "y", HOSTNAME: "z" }, null);
    expect(Object.keys(env).sort()).toEqual(["HOME", "LC_ALL", "PATH"]);
  });
});

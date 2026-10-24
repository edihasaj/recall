import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LegacyLaunchd, parseLegacyPlist, type LaunchctlResult } from "../src/cloud/legacy.js";
import { engineStateKey } from "../src/cloud/state.js";
import { buildEngineArgs, loadCloudConfig } from "../src/cloud/config.js";
import { FakeWorker, TOKEN, makeHome, makeService } from "./helpers/cloud-fakes.js";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function setup(opts: { passphrase?: string | null; bootoutWorks?: boolean; plistExtra?: Record<string, unknown>; args?: (h: string) => string[] } = {}) {
  const h = makeHome();
  homes.push(h.home);
  const { paths, env, home } = h;
  mkdirSync(paths.cloudDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.tokenFile, TOKEN, { mode: 0o600 });
  writeFileSync(paths.stateFile, JSON.stringify({ version: 1, entries: { keep: { push: { id: "a" } } } }), { mode: 0o600 });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(paths.legacyPlist, "placeholder");
  const args = opts.args?.(home) ?? [
    "/x/node", "/x/recall-sync.mjs", "watch",
    "--api", "https://api.recallmemory.dev", "--token-file", paths.tokenFile,
    "--interval", "300", "--device-id", "Edis-Mac.local", "--db", paths.dbFile,
    "--device-alias", "old-mac=Edis-Mac.local", "--e2ee",
  ];
  const plist: Record<string, unknown> = {
    Label: "dev.recallmemory.cloud-sync",
    ProgramArguments: args,
    EnvironmentVariables: opts.passphrase === null ? {} : { RECALL_CLOUD_E2EE_PASSPHRASE: opts.passphrase ?? "legacy pass phrase" },
    ...opts.plistExtra,
  };
  const events: string[] = [];
  let loaded = true;
  const launchctl = (a: string[]): LaunchctlResult => {
    events.push(`launchctl:${a[0]}`);
    if (a[0] === "bootout") { if (opts.bootoutWorks !== false) loaded = false; return { status: opts.bootoutWorks === false ? 5 : 0, stdout: "", stderr: "" }; }
    if (a[0] === "print") return loaded ? { status: 0, stdout: "x", stderr: "" } : { status: 113, stdout: "", stderr: "Could not find service" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const legacy = new LegacyLaunchd({ paths, platform: "darwin", launchctl, readPlist: () => plist, uid: () => 501, sleep: async () => {} });
  const worker = new FakeWorker(events);
  const made = makeService(env, { worker, legacy });
  return { ...made, paths, events, plist, home, legacy };
}

describe("explicit legacy migration", () => {
  it("moves sync in with identity, cursor, encryption and token preserved", async () => {
    const { service, worker, paths, events } = setup();
    const before = readFileSync(paths.stateFile, "utf8");
    const status = await service.migrateLegacy({ optIn: true });
    expect(status.state).toBe("running");
    // the old job is stopped and proven absent before the new worker starts
    expect(events.indexOf("launchctl:bootout")).toBeLessThan(events.indexOf("start"));
    expect(events.lastIndexOf("launchctl:print")).toBeLessThan(events.indexOf("start"));
    expect(events.filter((e) => e === "start")).toHaveLength(1);
    expect(existsSync(paths.legacyPlist)).toBe(false);
    expect(readdirSync(paths.backupDir)).toHaveLength(1);
    expect(readFileSync(paths.tokenFile, "utf8")).toBe(TOKEN);
    expect(readFileSync(paths.stateFile, "utf8")).toBe(before);
    const config = loadCloudConfig(paths)!;
    expect(config).toMatchObject({ enabled: true, deviceId: "Edis-Mac.local", e2ee: true, migratedFrom: "legacy-launchd", migrationPending: false, dbPath: paths.dbFile, tokenFile: paths.tokenFile, stateFile: paths.stateFile });
    expect(config.deviceAliases).toEqual({ "old-mac": "Edis-Mac.local" });
    // same engine arguments as the legacy job, so the same cursor key and the same encryption mode
    const launch = worker.launches[0];
    expect(launch.args).toEqual(expect.arrayContaining(["--e2ee", "--device-alias", "old-mac=Edis-Mac.local", "--device-id", "Edis-Mac.local"]));
    expect(launch.args.join(" ")).not.toContain("legacy pass phrase");
    expect(launch.env.RECALL_CLOUD_E2EE_PASSPHRASE).toBe("legacy pass phrase");
    expect(engineStateKey(config)).toBe(engineStateKey({ api: "https://api.recallmemory.dev", deviceId: "Edis-Mac.local", dbPath: paths.dbFile }));
    expect(buildEngineArgs(config, "/engine/recall-sync.mjs")).toEqual(launch.args.slice(1));
  });

  it("a second migration finds nothing and starts no duplicate", async () => {
    const { service, worker } = setup();
    await service.migrateLegacy({ optIn: true });
    await expect(service.migrateLegacy({ optIn: true })).rejects.toMatchObject({ code: "legacy-missing" });
    expect(worker.launches).toHaveLength(1);
  });

  it("is blocked, with no worker, when macOS keeps the old job loaded", async () => {
    const { service, worker, paths } = setup({ bootoutWorks: false });
    await expect(service.migrateLegacy({ optIn: true })).rejects.toMatchObject({ code: "migration-blocked" });
    expect(worker.launches).toHaveLength(0);
    expect(existsSync(paths.legacyPlist)).toBe(true);
    const config = loadCloudConfig(paths)!;
    expect(config).toMatchObject({ enabled: false, migrationPending: true });
    expect(service.status().state).toBe("migration-pending");
    // restart: nothing starts and nothing syncs
    const restarted = makeService({ HOME: paths.home, RECALL_DATA_DIR: paths.dataDir, PATH: "/usr/bin" });
    await restarted.service.startIfEnabled();
    expect(restarted.worker.launches).toHaveLength(0);
  });

  it("fails closed, without a worker, when the old plist cannot be moved aside", async () => {
    const { service, worker, paths } = setup();
    writeFileSync(paths.backupDir, "not a directory");
    await expect(service.migrateLegacy({ optIn: true })).rejects.toMatchObject({ code: "migration-blocked" });
    expect(worker.launches).toHaveLength(0);
    expect(loadCloudConfig(paths)).toMatchObject({ enabled: false, migrationPending: true });
    expect(existsSync(paths.legacyPlist)).toBe(true);
    expect(readFileSync(paths.tokenFile, "utf8")).toBe(TOKEN);
  });

  it("refuses E2EE without a recoverable passphrase and changes nothing", async () => {
    const { service, worker, paths, events } = setup({ passphrase: null });
    await expect(service.migrateLegacy({ optIn: true })).rejects.toMatchObject({ code: "encryption-required" });
    expect(events).not.toContain("launchctl:bootout");
    expect(worker.launches).toHaveLength(0);
    expect(existsSync(paths.configFile)).toBe(false);
    expect(existsSync(paths.legacyPlist)).toBe(true);
  });

  it("requires an explicit opt-in", async () => {
    const { service, events, paths } = setup();
    await expect(service.migrateLegacy({})).rejects.toMatchObject({ code: "opt-in-required" });
    expect(events).toEqual([]);
    expect(existsSync(paths.configFile)).toBe(false);
  });

  it("never deletes the legacy token itself; only an explicit disconnect removes it", async () => {
    const { service, paths } = setup();
    await service.migrateLegacy({ optIn: true });
    expect(existsSync(paths.tokenFile)).toBe(true);
    await service.disconnect();
    expect(existsSync(paths.tokenFile)).toBe(false);
    expect(existsSync(paths.stateFile)).toBe(true);
  });
});

describe("legacy plist parsing fails closed", () => {
  const paths = makeHome().paths;
  const base = (args: string[], extra: Record<string, unknown> = {}) => ({
    Label: "dev.recallmemory.cloud-sync",
    ProgramArguments: ["/n", "/x/recall-sync.mjs", "watch", "--api", "https://api.recallmemory.dev", "--token-file", "/t/token", ...args],
    ...extra,
  });
  it("rejects a different Label", () => {
    expect(() => parseLegacyPlist(base([], { Label: "custom.job" }), paths)).toThrow(/label/);
    expect(() => parseLegacyPlist({ ...base([]), Label: undefined }, paths)).toThrow(/label/);
  });
  it("rejects relative paths and a different HOME", () => {
    expect(() => parseLegacyPlist(base(["--db", "recall.db"]), paths)).toThrow(/relative/);
    expect(() => parseLegacyPlist(base([], { EnvironmentVariables: { HOME: "/other" } }), paths)).toThrow(/HOME/);
  });
  it("rejects options it cannot reproduce", () => {
    expect(() => parseLegacyPlist(base(["--e2ee-passphrase", "secret"]), paths)).toThrow(/cannot migrate safely/);
    expect(() => parseLegacyPlist(base(["--token", "secret"]), paths)).toThrow(/cannot migrate safely/);
    try { parseLegacyPlist(base(["--token", "secret"]), paths); } catch (e) { expect(String(e)).not.toContain("secret"); }
  });
  it("accepts a standard job", () => {
    expect(parseLegacyPlist(base(["--device-id", "m"]), paths)).toMatchObject({ deviceId: "m", intervalSeconds: 300, e2ee: false });
  });
});

import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCloudPaths } from "../../src/cloud/paths.js";
import { CloudService, type CloudServiceDeps, type LegacyLike } from "../../src/cloud/service.js";
import type { LegacyLoadedState, LegacySettings } from "../../src/cloud/legacy.js";
import type { WorkerLaunch, WorkerLike, WorkerState, WorkerStatus } from "../../src/cloud/worker.js";

export const TOKEN = "tok_test_secret_123";

export class FakeWorker implements WorkerLike {
  launches: WorkerLaunch[] = [];
  state: WorkerState = "stopped";
  stopError: Error | null = null;
  constructor(public events: string[] = []) {}
  start(launch: WorkerLaunch) { this.launches.push(launch); this.state = "running"; this.events.push("start"); }
  async stop() {
    if (this.stopError) throw this.stopError;
    this.state = "stopped";
    this.events.push("stop");
  }
  killSync() { this.state = "stopped"; }
  status(): WorkerStatus {
    return { state: this.state, pid: this.state === "running" ? 99 : null, startedAt: null, restarts: 0, lastError: null, lastSyncAt: null, lastExit: null };
  }
}

export class FakeLegacy implements LegacyLike {
  exists = false;
  loaded: LegacyLoadedState = "absent";
  plistExists() { return this.exists; }
  loadedState() { return this.loaded; }
  readSettings(): LegacySettings { throw new Error("not used"); }
  async bootoutAndProve() {}
  retirePlist() { return ""; }
}

export class FakeChild extends EventEmitter {
  pid: number | undefined = 777;
  connected = true;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  send() { return true; }
  kill(signal: string) { queueMicrotask(() => this.emit("exit", null, signal)); return true; }
}

export function makeHome(extraEnv: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "recall-cloud-test-"));
  const env: NodeJS.ProcessEnv = { HOME: home, RECALL_DATA_DIR: join(home, ".recall"), PATH: "/usr/bin", ...extraEnv };
  return { home, env, paths: resolveCloudPaths(env) };
}

export const fakeEngine = () => ({ engine: "/engine/recall-sync.mjs", wrapper: "/engine/managed-worker.mjs" });

export function makeService(env: NodeJS.ProcessEnv, deps: CloudServiceDeps = {}) {
  const worker = (deps.worker as FakeWorker | undefined) ?? new FakeWorker();
  const legacy = (deps.legacy as LegacyLike | undefined) ?? new FakeLegacy();
  const service = new CloudService({
    env, worker, legacy, engine: fakeEngine, nodePath: "node", osHostname: () => "test-mac",
    ...deps,
  });
  return { service, worker, legacy };
}

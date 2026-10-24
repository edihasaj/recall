import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CloudWorker } from "../src/cloud/worker.js";

const wrapper = resolve(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "recall-cloud-sync", "managed-worker.mjs");
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "recall-managed-worker-"));
  dirs.push(dir);
  return dir;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return check();
}

// Stand-in for recall-sync.mjs: only runs when invoked directly, like the real engine.
const IDLE_ENGINE = `
console.log("[recall-cloud] watch started api=fake");
setInterval(() => {}, 1000);
`;

describe("managed-worker wrapper", () => {
  it("runs the engine in-process and stops cleanly via CloudWorker", async () => {
    const dir = scratch();
    const engine = join(dir, "engine.mjs");
    writeFileSync(engine, IDLE_ENGINE);
    const worker = new CloudWorker({ stopGraceMs: 2000 });
    cleanups.push(() => worker.killSync());
    worker.start({ command: process.execPath, args: [wrapper, engine, "watch"], env: { PATH: process.env.PATH } });
    expect(await waitFor(() => worker.status().state === "running")).toBe(true);
    const pid = worker.status().pid!;
    await worker.stop();
    expect(worker.status().state).toBe("stopped");
    expect(await waitFor(() => !alive(pid))).toBe(true);
  });

  it("exits on its own when the daemon is SIGKILLed (no orphan)", async () => {
    const dir = scratch();
    const engine = join(dir, "engine.mjs");
    writeFileSync(engine, IDLE_ENGINE);
    // Stand-in daemon: forks the wrapper over IPC, reports its pid, then idles.
    const daemon = join(dir, "daemon.mjs");
    writeFileSync(daemon, `
      import { fork } from "node:child_process";
      const child = fork(${JSON.stringify(wrapper)}, [${JSON.stringify(engine)}, "watch"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      console.log("CHILD:" + child.pid);
      setInterval(() => {}, 1000);
    `);
    const parent: ChildProcess = fork(daemon, [], { stdio: ["ignore", "pipe", "ignore", "ipc"] });
    cleanups.push(() => parent.kill("SIGKILL"));
    const childPid = await new Promise<number>((resolvePid, reject) => {
      parent.stdout!.on("data", (d: Buffer) => {
        const m = /CHILD:(\d+)/.exec(d.toString());
        if (m) resolvePid(Number(m[1]));
      });
      setTimeout(() => reject(new Error("no child pid")), 5000);
    });
    cleanups.push(() => { try { process.kill(childPid, "SIGKILL"); } catch { /* gone */ } });
    expect(alive(childPid)).toBe(true);
    parent.kill("SIGKILL");
    expect(await waitFor(() => !alive(childPid), 8000)).toBe(true);
  });

  it("aborts a request that never answers instead of outliving a stop", async () => {
    const dir = scratch();
    const sockets = new Set<Socket>();
    const server: Server = createServer(() => { /* never respond */ });
    server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => { for (const s of sockets) s.destroy(); server.close(); });
    const { port } = server.address() as { port: number };
    const engine = join(dir, "engine.mjs");
    writeFileSync(engine, `
      try { await fetch(process.argv[3]); } catch (e) { console.log("fetch-ended:" + e.name); }
      process.exit(0);
    `);
    const child = fork(wrapper, [engine, "watch", `http://127.0.0.1:${port}/`], {
      stdio: ["ignore", "pipe", "ignore", "ipc"],
      env: { PATH: process.env.PATH, RECALL_CLOUD_REQUEST_TIMEOUT_MS: "300" },
    });
    cleanups.push(() => child.kill("SIGKILL"));
    let out = "";
    child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    expect(await waitFor(() => out.includes("fetch-ended:TimeoutError"), 6000)).toBe(true);
  });
});

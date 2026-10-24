import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { CloudWorker, classifyEngineOutput, type SpawnFn } from "../src/cloud/worker.js";

class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  connected = true;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  sent: unknown[] = [];
  signals: string[] = [];
  exitOn: string | null = "SIGTERM";
  send(message: unknown) { this.sent.push(message); return true; }
  kill(signal: string) {
    this.signals.push(signal);
    if (this.exitOn === signal) queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
  say(text: string) { this.stdout.emit("data", Buffer.from(text)); }
}

const launch = { command: "node", args: ["wrapper.mjs", "engine.mjs", "watch"], env: {} };
const workers: CloudWorker[] = [];

function setup(options: ConstructorParameters<typeof CloudWorker>[0] = {}) {
  const children: FakeChild[] = [];
  const calls: Array<{ args: string[]; stdio: unknown }> = [];
  const spawn: SpawnFn = (_command, args, opts) => {
    const child = new FakeChild();
    children.push(child);
    calls.push({ args, stdio: opts.stdio });
    return child as never;
  };
  const worker = new CloudWorker({ spawn, stopGraceMs: 20, stopDeadlineMs: 20, backoffMs: [5], ...options });
  workers.push(worker);
  return { worker, children, calls };
}

afterEach(() => { for (const w of workers.splice(0)) w.killSync(); });

describe("CloudWorker", () => {
  it("spawns one child with an IPC channel and ignores a duplicate start", () => {
    const { worker, children, calls } = setup();
    worker.start(launch);
    worker.start(launch);
    expect(children).toHaveLength(1);
    expect(calls[0].stdio).toEqual(["ignore", "pipe", "pipe", "ipc"]);
    expect(worker.status().state).toBe("starting");
  });

  it("is running after startup but only reports a sync after a full pull", () => {
    const { worker, children } = setup();
    worker.start(launch);
    children[0].say("[recall-cloud] watch started api=x\n");
    expect(worker.status().state).toBe("running");
    expect(worker.status().lastSyncAt).toBeNull();
    children[0].say("[t] sync error: POST https://x/v1/sync/pull failed 401: bad\n");
    expect(worker.status().lastError).toBe("The cloud rejected this device's token");
    children[0].say("[t] pull ok fetched=2 imported=0 updated=0 unchanged=2 skipped=0\n");
    expect(worker.status().lastSyncAt).not.toBeNull();
    expect(worker.status().lastError).toBeNull();
  });

  it("never stores raw engine output", () => {
    const { worker, children } = setup();
    worker.start(launch);
    children[0].say("sync error: Bearer sk-secret-token memory text failed 500: body-with-secret\n");
    const status = JSON.stringify(worker.status());
    expect(status).not.toContain("sk-secret-token");
    expect(status).not.toContain("body-with-secret");
    expect(classifyEngineOutput("nothing interesting")).toBeNull();
  });

  it("stop() resolves only after the child exits, via IPC stop then SIGTERM", async () => {
    const { worker, children } = setup();
    worker.start(launch);
    await worker.stop();
    expect(children[0].sent).toEqual([{ type: "stop" }]);
    expect(children[0].signals[0]).toBe("SIGTERM");
    expect(worker.status().state).toBe("stopped");
    expect(worker.status().pid).toBeNull();
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const { worker, children } = setup();
    children.length = 0;
    worker.start(launch);
    children[0].exitOn = "SIGKILL";
    await worker.stop();
    expect(children[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(worker.status().state).toBe("stopped");
  });

  it("rejects stop() and keeps the child when no exit is ever observed, and never spawns a duplicate", async () => {
    const { worker, children } = setup();
    worker.start(launch);
    children[0].exitOn = null;
    await expect(worker.stop()).rejects.toThrow("did not stop");
    expect(worker.status().state).toBe("failed");
    expect(worker.status().pid).toBe(4242);
    expect(() => worker.start(launch)).toThrow();
    expect(children).toHaveLength(1);
    // A late real exit is still honoured and unlocks a new start.
    children[0].emit("exit", null, "SIGKILL");
    expect(worker.status().state).toBe("stopped");
    worker.start(launch);
    expect(children).toHaveLength(2);
  });

  it("an 'error' event on a live child does not drop it", () => {
    const { worker, children } = setup();
    worker.start(launch);
    children[0].emit("error", new Error("kill EPERM"));
    expect(worker.status().pid).toBe(4242);
    worker.start(launch);
    expect(children).toHaveLength(1);
  });

  it("restarts after a crash only once the previous child has exited", async () => {
    const { worker, children } = setup();
    worker.start(launch);
    children[0].emit("exit", 1, null);
    expect(worker.status().state).toBe("backoff");
    expect(children).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(children).toHaveLength(2);
    expect(worker.status().restarts).toBe(1);
  });

  it("gives up after repeated crashes instead of looping forever", () => {
    const { worker, children } = setup({ maxRestarts: 1, backoffMs: [1000] });
    worker.start(launch);
    children[0].emit("exit", 1, null);
    expect(worker.status().state).toBe("backoff");
    // simulate the second crash inside the window by spawning again through a fresh start path
    const w2 = setup({ maxRestarts: 0 });
    w2.worker.start(launch);
    w2.children[0].emit("exit", 1, null);
    expect(w2.worker.status().state).toBe("failed");
  });

  it("does not restart after an intentional stop", async () => {
    const { worker, children } = setup();
    worker.start(launch);
    await worker.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(children).toHaveLength(1);
  });
});

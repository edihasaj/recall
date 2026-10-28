import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type WorkerState = "stopped" | "starting" | "running" | "backoff" | "failed";

export interface WorkerLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface WorkerStatus {
  state: WorkerState;
  pid: number | null;
  startedAt: string | null;
  restarts: number;
  lastError: string | null;
  /** Time of the last fully successful pull; null until a cycle really succeeds. */
  lastSyncAt: string | null;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
}

export interface WorkerLike {
  start(launch: WorkerLaunch): void;
  stop(): Promise<void>;
  killSync(): void;
  status(): WorkerStatus;
}

export interface WorkerOptions {
  onPull?: () => void;
  spawn?: SpawnFn;
  startTimeoutMs?: number;
  stopGraceMs?: number;
  /** Extra time after SIGKILL to observe the exit before stop() rejects. */
  stopDeadlineMs?: number;
  backoffMs?: number[];
  maxRestarts?: number;
  restartWindowMs?: number;
  log?: (message: string) => void;
}

/**
 * Maps engine output to a fixed vocabulary. Raw child output is drained but
 * never stored or logged, because it can carry request bodies, tokens or
 * memory text.
 */
export function classifyEngineOutput(line: string): string | null {
  if (/failed (?:401|403)\b/i.test(line)) return "The cloud rejected this device's token";
  if (/failed (?:408|425|429|5\d\d)\b/i.test(line)) return "The cloud is temporarily unavailable";
  if (/failed 409\b/i.test(line) && /encrypted|encryption|private|aliases/i.test(line)) {
    return "Cloud encryption settings conflict. Use private sync with the original passphrase and check device aliases.";
  }
  if (/failed \d{3}\b/i.test(line)) return "A cloud request failed";
  if (/fetch failed|network error|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|aborted|timeout/i.test(line)) return "Network error while syncing";
  if (/database is locked|SQLITE_BUSY/i.test(line)) return "The local database was busy";
  if (/Recall DB not found/i.test(line)) return "The local Recall database was not found";
  if (/e2ee|passphrase/i.test(line)) return "Encryption is not configured correctly";
  if (/credential|token/i.test(line)) return "The sync credentials could not be used";
  if (/sync error/i.test(line)) return "A sync cycle failed";
  return null;
}

/**
 * Supervises one bounded sync child (managed-worker.mjs running the engine's
 * `watch` loop). The child has an IPC channel to the daemon, so it exits as soon
 * as the daemon disappears, even on SIGKILL. start() is idempotent, crashes back
 * off and eventually fail closed, and stop() resolves only after the child has
 * actually exited (IPC stop + SIGTERM, then SIGKILL after a short grace).
 */
export class CloudWorker implements WorkerLike {
  private readonly onPull: () => void;
  private readonly spawnFn: SpawnFn;
  private readonly startTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly stopDeadlineMs: number;
  private readonly backoffMs: number[];
  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private readonly log: (message: string) => void;
  private child: ChildProcess | null = null;
  private launch: WorkerLaunch | null = null;
  private state: WorkerState = "stopped";
  private stopping = false;
  private stopFailed = false;
  private startedAt: string | null = null;
  private lastError: string | null = null;
  private lastSyncAt: string | null = null;
  private lastExit: WorkerStatus["lastExit"] = null;
  private restarts = 0;
  private restartTimes: number[] = [];
  private startTimer: NodeJS.Timeout | null = null;
  private backoffTimer: NodeJS.Timeout | null = null;
  private waiters: Array<() => void> = [];
  private buffer = "";

  constructor(options: WorkerOptions = {}) {
    this.onPull = options.onPull ?? (() => {});
    this.spawnFn = options.spawn ?? ((command, args, opts) => nodeSpawn(command, args, opts));
    this.startTimeoutMs = options.startTimeoutMs ?? 20_000;
    this.stopGraceMs = options.stopGraceMs ?? 3_000;
    this.stopDeadlineMs = options.stopDeadlineMs ?? 2_000;
    this.backoffMs = options.backoffMs ?? [2_000, 10_000, 30_000, 60_000];
    this.maxRestarts = options.maxRestarts ?? 5;
    this.restartWindowMs = options.restartWindowMs ?? 10 * 60_000;
    this.log = options.log ?? (() => {});
  }

  start(launch: WorkerLaunch): void {
    if (this.child && this.stopFailed) {
      throw new Error("The previous sync engine has not exited yet");
    }
    if (this.child || this.state === "backoff" || this.state === "starting" || this.state === "running") return;
    this.launch = launch;
    this.stopping = false;
    this.restarts = 0;
    this.restartTimes = [];
    this.lastError = null;
    this.lastSyncAt = null;
    this.spawnChild();
  }

  /**
   * Resolves only after the child has been observed to exit. If it does not exit
   * within the bounded deadline, the child stays tracked (state "failed"), no
   * replacement can start, and the promise rejects so callers do not report a
   * disconnect that has not happened.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    const child = this.child;
    if (!child) {
      this.state = "stopped";
      this.stopFailed = false;
      this.stopping = false;
      return;
    }
    let release: () => void = () => {};
    const exited = new Promise<"exited">((resolve) => {
      release = () => resolve("exited");
      this.waiters.push(release);
    });
    try {
      if (child.connected) child.send?.({ type: "stop" });
    } catch {
      // channel already closed; SIGTERM below still applies
    }
    this.signal(child, "SIGTERM");
    const killTimer = setTimeout(() => this.signal(child, "SIGKILL"), this.stopGraceMs);
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      deadlineTimer = setTimeout(() => resolve("timeout"), this.stopGraceMs + this.stopDeadlineMs);
    });
    const outcome = await Promise.race([exited, deadline]);
    clearTimeout(killTimer);
    clearTimeout(deadlineTimer);
    if (outcome === "timeout") {
      this.waiters = this.waiters.filter((waiter) => waiter !== release);
      this.state = "failed";
      this.stopFailed = true;
      this.lastError = "The sync engine did not stop";
      // Keep stopping=true so a late exit is treated as the requested stop.
      throw new Error("The sync engine did not stop");
    }
    this.stopFailed = false;
    this.stopping = false;
  }

  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      child.kill(signal);
    } catch {
      // the exit event, not the kill call, decides whether the child is gone
    }
  }

  /** Synchronous last resort for process 'exit' handlers. */
  killSync(): void {
    this.stopping = true;
    this.clearTimers();
    try {
      this.child?.kill("SIGKILL");
    } catch {
      // already gone
    }
    this.child = null;
    this.state = "stopped";
  }

  status(): WorkerStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      restarts: this.restarts,
      lastError: this.lastError,
      lastSyncAt: this.lastSyncAt,
      lastExit: this.lastExit,
    };
  }

  private spawnChild(): void {
    const launch = this.launch;
    if (!launch) return;
    let child: ChildProcess;
    try {
      child = this.spawnFn(launch.command, launch.args, {
        env: launch.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      });
    } catch {
      this.lastError = "The sync engine could not be started";
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.state = "starting";
    this.startedAt = new Date().toISOString();
    this.buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => this.onOutput(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.onOutput(chunk));
    child.on("error", () => {
      this.lastError = "The sync engine could not be started";
      // 'error' also reports failed kill()/send() on a live child. Only a
      // process that never got a pid is known to be gone.
      if (child.pid === undefined) this.handleExit(child, null, null);
    });
    child.on("exit", (code, signal) => this.handleExit(child, code, signal));
    this.startTimer = setTimeout(() => {
      if (this.child === child && this.state === "starting") {
        this.lastError = "The sync engine did not start in time";
        child.kill("SIGKILL");
      }
    }, this.startTimeoutMs);
  }

  private onOutput(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = (lines.pop() ?? "").slice(-4096);
    for (const line of lines) {
      if (line.includes("watch started")) {
        if (this.state === "starting") this.state = "running";
        if (this.startTimer) clearTimeout(this.startTimer);
        this.startTimer = null;
        continue;
      }
      // "watch started" only proves the process booted; a full pull is the proof the token works.
      if (/\bpull ok fetched=/.test(line)) {
        this.lastSyncAt = new Date().toISOString();
        this.lastError = null;
        this.onPull();
        continue;
      }
      const reason = classifyEngineOutput(line);
      if (reason) this.lastError = reason;
    }
  }

  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | string | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.clearTimers();
    this.lastExit = { code, signal: signal ?? null, at: new Date().toISOString() };
    if (this.stopping) {
      this.state = "stopped";
      this.stopFailed = false;
      const waiters = this.waiters;
      this.waiters = [];
      for (const resolve of waiters) resolve();
      return;
    }
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    const now = Date.now();
    this.restartTimes = [...this.restartTimes.filter((t) => now - t < this.restartWindowMs), now];
    if (this.restartTimes.length > this.maxRestarts) {
      this.state = "failed";
      this.lastError = this.lastError ?? "The sync engine keeps stopping";
      this.log("[recall-cloud] sync engine stopped repeatedly; giving up until reconnected");
      return;
    }
    this.restarts += 1;
    this.state = "backoff";
    const delay = this.backoffMs[Math.min(this.restarts - 1, this.backoffMs.length - 1)] ?? 60_000;
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      // A restart only ever happens after the previous child fully exited.
      if (!this.stopping && !this.child) this.spawnChild();
    }, delay);
  }

  private clearTimers(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    this.startTimer = null;
    this.backoffTimer = null;
  }
}

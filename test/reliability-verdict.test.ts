import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { closeDb, initStandaloneDb as openStandaloneDb, type RecallDb } from "../src/db/client.js";
import { createActivityEvent } from "../src/models/activity.js";
import { formatDoctorReport } from "../src/doctor/report.js";
import {
  computeReliabilityVerdict,
  deriveReliabilityVerdict,
  formatReliabilityVerdictSection,
  loadReliabilityVerdictConfigFromEnv,
  persistReliabilityVerdict,
  readReliabilityVerdict,
  reliabilityVerdictPath,
  runReliabilityVerdictCycle,
  type ReliabilityVerdict,
} from "../src/reliability/verdict.js";

const DAY = 86_400_000;
const BASE = new Date("2026-10-10T08:00:00.000Z");
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs);

const failing = {
  overall: "fail" as const,
  checks: [
    { name: "repo_attribution", status: "fail" as const, value: 0.112, target: ">=95%" },
    { name: "retrieval_observations", status: "fail" as const, value: 0, target: ">=20" },
    { name: "candidate_backlog", status: "pass" as const, value: 12, target: "<=50" },
  ],
};
const passing = {
  overall: "pass" as const,
  checks: [{ name: "repo_attribution", status: "pass" as const, value: 1, target: ">=95%" }],
};
const warning = {
  overall: "warn" as const,
  checks: [{ name: "retrieval_observations", status: "warn" as const, value: 7, target: ">=20" }],
};

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Close standalone handles explicitly: leaving them to GC finalization inside
// a vitest worker can abort the worker in better-sqlite3's destructor.
const openDbs: RecallDb[] = [];
function initStandaloneDb(path: string): RecallDb {
  const db = openStandaloneDb(path);
  openDbs.push(db);
  return db;
}

function sustainedVerdict(overrides: Partial<ReliabilityVerdict> = {}): ReliabilityVerdict {
  return {
    ...deriveReliabilityVerdict(failing, { now: at(0) }),
    computed_at: at(9 * DAY).toISOString(),
    first_fail_at: at(0).toISOString(),
    consecutive_fail_days: 10,
    sustained_fail: true,
    ...overrides,
  };
}

beforeEach(() => { process.env.RECALL_EMBEDDINGS_DISABLED = "true"; });
afterEach(() => {
  for (const db of openDbs.splice(0)) {
    if (db.$client.open) db.$client.close();
  }
  closeDb();
  delete process.env.RECALL_EMBEDDINGS_DISABLED;
});

describe("reliability verdict carry-over", () => {
  it("keeps first_fail_at and counts one day per UTC calendar day of FAIL", () => {
    const day1 = deriveReliabilityVerdict(failing, { now: at(0) });
    const day2 = deriveReliabilityVerdict(failing, { now: at(DAY), previous: day1 });
    const day3 = deriveReliabilityVerdict(failing, { now: at(2 * DAY), previous: day2 });

    expect(day1).toMatchObject({ first_fail_at: BASE.toISOString(), consecutive_fail_days: 1, sustained_fail: false });
    expect(day3.first_fail_at).toBe(BASE.toISOString());
    expect(day3.consecutive_fail_days).toBe(3);
    expect(day3.sustained_fail).toBe(false);
    expect(day3.checks.map((check) => check.name)).toEqual(failing.checks.map((check) => check.name));
  });

  it("starts a new streak when a different check fails", () => {
    const previous = sustainedVerdict();
    const changed = { overall: "fail" as const, checks: [
      { name: "emission_coverage", status: "fail" as const, value: 0.5, target: ">=99%" },
    ] };
    const next = deriveReliabilityVerdict(changed, { now: at(10 * DAY), previous });
    expect(next).toMatchObject({ first_fail_at: at(10 * DAY).toISOString(), consecutive_fail_days: 1, sustained_fail: false });
    const reordered = deriveReliabilityVerdict({ ...failing, checks: [...failing.checks].reverse() }, { now: at(10 * DAY), previous });
    expect(reordered.first_fail_at).toBe(previous.first_fail_at);
  });

  it("does not count a second FAIL on the same UTC day", () => {
    const morning = deriveReliabilityVerdict(failing, { now: at(0) });
    const evening = deriveReliabilityVerdict(failing, { now: at(10 * 3_600_000), previous: morning });
    expect(evening.consecutive_fail_days).toBe(1);
    expect(evening.first_fail_at).toBe(morning.first_fail_at);
  });

  it("resets the streak on PASS or WARN", () => {
    const fail = deriveReliabilityVerdict(failing, { now: at(0) });
    for (const measured of [passing, warning]) {
      const next = deriveReliabilityVerdict(measured, { now: at(DAY), previous: fail });
      expect(next).toMatchObject({ first_fail_at: null, consecutive_fail_days: 0, sustained_fail: false });
      const again = deriveReliabilityVerdict(failing, { now: at(2 * DAY), previous: next });
      expect(again).toMatchObject({ first_fail_at: at(2 * DAY).toISOString(), consecutive_fail_days: 1 });
    }
  });

  it("flips sustained_fail exactly at 7 days since first_fail_at", () => {
    let previous = deriveReliabilityVerdict(failing, { now: at(0) });
    for (let day = 1; day <= 6; day++) {
      previous = deriveReliabilityVerdict(failing, { now: at(day * DAY), previous });
    }
    const before = deriveReliabilityVerdict(failing, { now: at(7 * DAY - 1), previous });
    const atSeven = deriveReliabilityVerdict(failing, { now: at(7 * DAY), previous: before });
    expect(before.sustained_fail).toBe(false);
    expect(atSeven.sustained_fail).toBe(true);
  });

  it("does not treat a daemon outage as consecutive observed failures", () => {
    const previous = sustainedVerdict();
    const resumed = deriveReliabilityVerdict(failing, { now: at(30 * DAY), previous });
    expect(resumed).toMatchObject({
      first_fail_at: at(30 * DAY).toISOString(),
      consecutive_fail_days: 1,
      sustained_fail: false,
    });
  });

  it("resets observed failure history after the clock moves backward", () => {
    const resumed = deriveReliabilityVerdict(failing, { now: at(DAY), previous: sustainedVerdict() });
    expect(resumed).toMatchObject({
      first_fail_at: at(DAY).toISOString(),
      consecutive_fail_days: 1,
      sustained_fail: false,
    });
  });

  it("carries last_notified_at forward for the 24 h notification gate", () => {
    const previous = sustainedVerdict({ last_notified_at: at(9 * DAY).toISOString() });
    const next = deriveReliabilityVerdict(failing, { now: at(10 * DAY), previous });
    expect(next.last_notified_at).toBe(previous.last_notified_at);
  });
});

describe("reliability verdict persistence", () => {
  it("round-trips through an owner-only JSON file", () => {
    const dir = tempDir("recall-verdict-");
    const verdict = sustainedVerdict();
    persistReliabilityVerdict(dir, verdict);
    expect(readReliabilityVerdict(dir)).toEqual(verdict);
    if (process.platform !== "win32") {
      expect(lstatSync(reliabilityVerdictPath(dir)).mode & 0o777).toBe(0o600);
    }
  });

  it("returns null for a missing, corrupt, or malformed file", () => {
    const dir = tempDir("recall-verdict-");
    expect(readReliabilityVerdict(dir)).toBeNull();
    writeFileSync(reliabilityVerdictPath(dir), "{not json");
    expect(readReliabilityVerdict(dir)).toBeNull();
    writeFileSync(reliabilityVerdictPath(dir), JSON.stringify({ ...sustainedVerdict(), overall: "great" }));
    expect(readReliabilityVerdict(dir)).toBeNull();
    writeFileSync(reliabilityVerdictPath(dir), JSON.stringify({ ...sustainedVerdict(), first_fail_at: "yesterday" }));
    expect(readReliabilityVerdict(dir)).toBeNull();
  });
});

describe("reliability verdict computation", () => {
  it("reports an empty store as insufficient evidence, without a failure streak", () => {
    const db = initStandaloneDb(join(tempDir("recall-verdict-db-"), "recall.db"));
    const verdict = computeReliabilityVerdict(db, { now: new Date() });
    expect(verdict.overall).toBe("warn");
    expect(verdict.checks.find((check) => check.name === "retrieval_observations")?.status).toBe("warn");
    expect(verdict.consecutive_fail_days).toBe(0);
  });

  it("logs a sustained FAIL every run but notifies at most once per 24 h", async () => {
    const dataDir = tempDir("recall-verdict-cycle-");
    const db = initStandaloneDb(join(dataDir, "recall.db"));
    const now = new Date();
    createActivityEvent(db, { session_id: "missing-repo", event_type: "session_start", source: "cli", request: { repo_path: "/missing/reliability-repo" } });
    persistReliabilityVerdict(dataDir, sustainedVerdict({
      checks: computeReliabilityVerdict(db).checks,
      computed_at: new Date(now.getTime() - DAY).toISOString(),
      first_fail_at: new Date(now.getTime() - 10 * DAY).toISOString(),
    }));
    const logged: string[] = [];
    const notified: string[] = [];
    const deps = {
      now: () => now,
      logError: (line: string) => logged.push(line),
      notify: async (message: string) => { notified.push(message); return true; },
    };

    const first = await runReliabilityVerdictCycle(db, dataDir, deps);
    expect(first.sustained_fail).toBe(true);
    expect(first.last_notified_at).toBe(now.toISOString());
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^\[recall\] reliability FAIL for 10 days: .*repo_attribution/);
    expect(notified).toHaveLength(1);
    expect(readReliabilityVerdict(dataDir)?.last_notified_at).toBe(now.toISOString());

    const second = await runReliabilityVerdictCycle(db, dataDir, { ...deps, now: () => new Date(now.getTime() + 3_600_000) });
    expect(logged).toHaveLength(2);
    expect(notified).toHaveLength(1);
    expect(second.last_notified_at).toBe(now.toISOString());

    await runReliabilityVerdictCycle(db, dataDir, { ...deps, now: () => new Date(now.getTime() + DAY) });
    expect(notified).toHaveLength(2);
  });

  it("keeps last_notified_at unset when the notifier fails or is absent", async () => {
    const dataDir = tempDir("recall-verdict-cycle-");
    const db = initStandaloneDb(join(dataDir, "recall.db"));
    const now = new Date();
    createActivityEvent(db, { session_id: "missing-repo", event_type: "session_start", source: "cli", request: { repo_path: "/missing/reliability-repo" } });
    persistReliabilityVerdict(dataDir, sustainedVerdict({
      checks: computeReliabilityVerdict(db).checks,
      computed_at: new Date(now.getTime() - DAY).toISOString(),
      first_fail_at: new Date(now.getTime() - 8 * DAY).toISOString(),
    }));
    const quiet = { now: () => now, logError: () => {} };
    const failed = await runReliabilityVerdictCycle(db, dataDir, { ...quiet, notify: async () => false });
    expect(failed.last_notified_at).toBeNull();
    const thrown = await runReliabilityVerdictCycle(db, dataDir, {
      ...quiet,
      notify: async () => { throw new Error("osascript missing"); },
    });
    expect(thrown.last_notified_at).toBeNull();
    const absent = await runReliabilityVerdictCycle(db, dataDir, quiet);
    expect(absent.last_notified_at).toBeNull();
  });
});

describe("reliability verdict config and notifier", () => {
  it("never notifies under a test runner and honours the env flags", () => {
    expect(loadReliabilityVerdictConfigFromEnv({})).toEqual({
      enabled: true,
      notify: true,
      delayMs: 120_000,
      intervalMs: 86_400_000,
    });
    expect(loadReliabilityVerdictConfigFromEnv({ VITEST: "true" }).notify).toBe(false);
    expect(loadReliabilityVerdictConfigFromEnv({ NODE_ENV: "test" }).notify).toBe(false);
    expect(loadReliabilityVerdictConfigFromEnv({ RECALL_RELIABILITY_VERDICT_NOTIFY: "false" }).notify).toBe(false);
    expect(loadReliabilityVerdictConfigFromEnv({ RECALL_RELIABILITY_VERDICT_ENABLED: "false" }).enabled).toBe(false);
    const bounded = loadReliabilityVerdictConfigFromEnv({
      RECALL_RELIABILITY_VERDICT_DELAY_SECONDS: "0",
      RECALL_RELIABILITY_VERDICT_INTERVAL_SECONDS: "nope",
    });
    expect(bounded.delayMs).toBe(1_000);
    expect(bounded.intervalMs).toBe(86_400_000);
  });

  it("never posts desktop notifications through osascript (shown as Script Editor)", () => {
    const source = readFileSync(new URL("../src/reliability/verdict.ts", import.meta.url), "utf-8");
    const daemon = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/osascript|child_process/);
    expect(daemon).not.toMatch(/osascript|display notification/);
  });
});

describe("doctor ## Reliability section", () => {
  const base = {
    db_path: "/tmp/recall.db",
    db_user_version: 2,
    db_target_version: 2,
    embeddings: null,
    launchd: null,
    agents: [],
    upgrade: { available: false, reasons: [] },
  };

  it("renders since-when, failing checks with value vs target, and hints", () => {
    const verdict = sustainedVerdict({
      computed_at: "2026-10-13T09:00:00.000Z",
      first_fail_at: "2026-10-10T08:00:00.000Z",
      consecutive_fail_days: 4,
      sustained_fail: false,
    });
    const text = formatDoctorReport({ ...base, reliability_verdict: verdict } as never);
    expect(text).toContain("## Reliability");
    expect(text).toContain("FAIL since 2026-10-10 (3 days)");
    expect(text).toContain("FAIL repo_attribution: 11.2% (target >=95%)");
    expect(text).toContain("sessions start outside a recognized repo or hooks are missing — see ## Agents");
    expect(text).toContain("FAIL retrieval_observations: 0 (target >=20)");
    expect(text).toContain("too few used/missed observations to assess retrieval");
    expect(text).not.toContain("candidate_backlog");
  });

  it("marks sustained and stale verdicts and falls back for unknown checks", () => {
    const verdict = sustainedVerdict({
      checks: [
        { name: "session_scope_coverage", status: "warn", value: 0.103, target: ">=50%" },
        { name: "future_check", status: "warn", value: 0.5, target: ">=90%" },
      ],
    });
    const lines = formatReliabilityVerdictSection(verdict, at(20 * DAY));
    expect(lines[0]).toContain("sustained");
    expect(lines[1]).toContain("STALE");
    expect(lines).toContain("WARN session_scope_coverage: 10.3% (target >=50%)");
    expect(lines.join("\n")).toContain("cannot receive repo memory");
    expect(lines).toContain("WARN future_check: 50.0% (target >=90%)");
    expect(lines.at(-1)).toContain("recall reliability");
  });

  it("explains a missing verdict and omits the section for older reports", () => {
    const missing = formatDoctorReport({ ...base, reliability_verdict: null } as never);
    expect(missing).toContain("No verdict yet — the daemon computes one daily; run `recall reliability` now.");
    expect(formatDoctorReport(base as never)).not.toContain("## Reliability");
  });
});

// --- daemon /health ---------------------------------------------------------

const daemons: ChildProcess[] = [];

async function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") return rej(new Error("bad addr"));
      const p = addr.port;
      srv.close(() => res(p));
    });
  });
}

async function bootDaemon(dataDir: string, env: Record<string, string>) {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child = spawn(process.execPath, [
    resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
    resolve(process.cwd(), "src/daemon.ts"),
  ], {
    env: {
      ...process.env,
      RECALL_PORT: String(port),
      RECALL_DATA_DIR: dataDir,
      RECALL_EMBEDDINGS_DISABLED: "true",
      RECALL_DISPATCHER_ENABLED: "false",
      RECALL_CLEANUP_ENABLED: "false",
      RECALL_QUALITY_SNAPSHOT_ENABLED: "false",
      RECALL_MAINTENANCE_ENABLED: "false",
      RECALL_RELIABILITY_PROBE_ENABLED: "false",
      RECALL_RELIABILITY_VERDICT_NOTIFY: "false",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemons.push(child);
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const health = async () => (await (await fetch(`${baseUrl}/health`)).json()) as Record<string, any>;
  const started = Date.now();
  for (;;) {
    try {
      const body = await health();
      if (body.status === "ok") break;
    } catch {
      // not listening yet
    }
    if (Date.now() - started > 20_000) throw new Error(`daemon did not become ready: ${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { health, stderr: () => stderr };
}

afterAll(async () => {
  await Promise.all(daemons.map((child) => new Promise<void>((done) => {
    if (child.exitCode !== null) return done();
    child.once("exit", () => done());
    child.kill("SIGTERM");
    setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3000).unref?.();
  })));
});

describe("daemon /health reliability_verdict (live HTTP)", () => {
  it("serves a legacy failure, then clears it when the evidence is insufficient", async () => {
    const dataDir = tempDir("recall-daemon-verdict-");
    const now = Date.now();
    const seeded = sustainedVerdict({
      computed_at: new Date(now - DAY).toISOString(),
      first_fail_at: new Date(now - 10 * DAY).toISOString(),
      consecutive_fail_days: 9,
    });
    persistReliabilityVerdict(dataDir, seeded);
    const daemon = await bootDaemon(dataDir, {
      RECALL_RELIABILITY_VERDICT_DELAY_SECONDS: "4",
      RECALL_RELIABILITY_VERDICT_NOTIFY: "true",
      VITEST: "",
      NODE_ENV: "production",
    });

    const initial = await daemon.health();
    expect(initial).toHaveProperty("reliability_verdict");
    expect(initial.reliability_verdict_notify).toBe(false);
    expect(initial.reliability_verdict.first_fail_at).toBe(seeded.first_fail_at);

    let current = initial.reliability_verdict;
    const deadline = Date.now() + 30_000;
    while (current.computed_at === seeded.computed_at && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      current = (await daemon.health()).reliability_verdict;
    }
    expect(current.computed_at).not.toBe(seeded.computed_at);
    expect((await daemon.health()).reliability_verdict_notify).toBe(true);
    expect(current).toMatchObject({
      overall: "warn",
      first_fail_at: null,
      consecutive_fail_days: 0,
      sustained_fail: false,
      last_notified_at: null,
    });
    expect(JSON.parse(readFileSync(reliabilityVerdictPath(dataDir), "utf-8"))).toEqual(current);
    expect(daemon.stderr()).not.toContain("[recall] reliability FAIL");
  }, 60_000);

  it("reports null when no verdict exists and the loop is disabled", async () => {
    const dataDir = tempDir("recall-daemon-verdict-");
    const daemon = await bootDaemon(dataDir, { RECALL_RELIABILITY_VERDICT_ENABLED: "false" });
    const body = await daemon.health();
    expect(body).toHaveProperty("reliability_verdict", null);
    expect(readReliabilityVerdict(dataDir)).toBeNull();
  }, 60_000);
});

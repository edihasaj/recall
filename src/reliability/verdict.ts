import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { getDbPath, type RecallDb } from "../db/client.js";
import { atomicWriteUtf8File, readUtf8FileIfExists } from "../security/atomic-file.js";
import { computeReliabilityReport } from "./report.js";

/**
 * Daily reliability verdict: the measured `recall reliability` result,
 * persisted day over day so a FAIL that lasts for weeks is noticed instead of
 * only being visible when a human happens to run the report.
 */
export const RELIABILITY_VERDICT_FILE = "reliability-verdict.json";
export const RELIABILITY_VERDICT_WINDOW_DAYS = 14;
export const RELIABILITY_SUSTAINED_FAIL_DAYS = 7;
export const RELIABILITY_NOTIFY_INTERVAL_MS = 86_400_000;
const DAY_MS = 86_400_000;
const STALE_VERDICT_MS = 48 * 3_600_000;

export type ReliabilityStatus = "pass" | "warn" | "fail";

export interface ReliabilityVerdictCheck {
  name: string;
  status: ReliabilityStatus;
  value: number;
  target: string;
}

export interface ReliabilityVerdict {
  computed_at: string;
  overall: ReliabilityStatus;
  checks: ReliabilityVerdictCheck[];
  first_fail_at: string | null;
  consecutive_fail_days: number;
  sustained_fail: boolean;
  last_notified_at: string | null;
}

export interface ReliabilityVerdictLoopConfig {
  enabled: boolean;
  notify: boolean;
  delayMs: number;
  intervalMs: number;
}

export interface ReliabilityVerdictCycleDeps {
  now?: () => Date;
  /** Resolves true only when the notification was actually shown. */
  notify?: (message: string) => Promise<boolean>;
  logError?: (line: string) => void;
}

/** Runs the existing reliability report over its default 14-day window. */
export function computeReliabilityVerdict(
  db: RecallDb,
  options: { now?: Date; previous?: ReliabilityVerdict | null } = {},
): ReliabilityVerdict {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - RELIABILITY_VERDICT_WINDOW_DAYS * DAY_MS).toISOString();
  const report = computeReliabilityReport(db, { since });
  return deriveReliabilityVerdict(report, { now, previous: options.previous ?? null });
}

/**
 * Carry-over rule: a FAIL that follows a FAIL keeps the earlier
 * `first_fail_at` and counts one more day only when the UTC calendar day
 * changed. Any PASS, WARN, clock reversal, or missed UTC day resets the streak:
 * downtime is missing evidence, not an observed sustained failure.
 */
export function deriveReliabilityVerdict(
  measured: { overall: ReliabilityStatus; checks: ReadonlyArray<ReliabilityVerdictCheck> },
  options: { now?: Date; previous?: ReliabilityVerdict | null } = {},
): ReliabilityVerdict {
  const now = options.now ?? new Date();
  const previous = options.previous ?? null;
  const computedAt = now.toISOString();
  let firstFailAt: string | null = null;
  let consecutiveFailDays = 0;
  if (measured.overall === "fail") {
    const dayGap = previous
      ? (Date.parse(utcDay(computedAt)) - Date.parse(utcDay(previous.computed_at))) / DAY_MS
      : Number.NaN;
    if (previous?.overall === "fail" && previous.first_fail_at
      && now.getTime() >= Date.parse(previous.computed_at) && dayGap >= 0 && dayGap <= 1) {
      firstFailAt = previous.first_fail_at;
      consecutiveFailDays = Math.max(1, previous.consecutive_fail_days) + dayGap;
    } else {
      firstFailAt = computedAt;
      consecutiveFailDays = 1;
    }
  }
  return {
    computed_at: computedAt,
    overall: measured.overall,
    checks: measured.checks.map((check) => ({
      name: check.name,
      status: check.status,
      value: Number.isFinite(check.value) ? check.value : 0,
      target: check.target,
    })),
    first_fail_at: firstFailAt,
    consecutive_fail_days: consecutiveFailDays,
    sustained_fail: firstFailAt !== null &&
      now.getTime() - Date.parse(firstFailAt) >= RELIABILITY_SUSTAINED_FAIL_DAYS * DAY_MS,
    last_notified_at: previous?.last_notified_at ?? null,
  };
}

/** The verdict lives next to the database, so it follows `RECALL_DATA_DIR`. */
export function reliabilityVerdictDataDir(): string {
  return dirname(getDbPath());
}

export function reliabilityVerdictPath(dataDir: string): string {
  return join(dataDir, RELIABILITY_VERDICT_FILE);
}

export function persistReliabilityVerdict(dataDir: string, verdict: ReliabilityVerdict): void {
  atomicWriteUtf8File(reliabilityVerdictPath(dataDir), `${JSON.stringify(verdict, null, 2)}\n`);
}

/** Returns null when the file is missing, unreadable, corrupt, or malformed. */
export function readReliabilityVerdict(dataDir: string): ReliabilityVerdict | null {
  try {
    const raw = readUtf8FileIfExists(reliabilityVerdictPath(dataDir));
    return raw === null ? null : parseReliabilityVerdict(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function runReliabilityVerdictCycle(
  db: RecallDb,
  dataDir: string,
  deps: ReliabilityVerdictCycleDeps = {},
): Promise<ReliabilityVerdict> {
  const now = deps.now?.() ?? new Date();
  const previous = readReliabilityVerdict(dataDir);
  let verdict = computeReliabilityVerdict(db, { now, previous });
  // Persist the measurement before any notification so /health and doctor
  // reflect it even if the notifier hangs or fails.
  persistReliabilityVerdict(dataDir, verdict);
  if (!verdict.sustained_fail) return verdict;

  const message = formatSustainedFailMessage(verdict);
  (deps.logError ?? console.error)(`[recall] ${message}`);
  if (deps.notify && isNotificationDue(verdict, now)) {
    let delivered = false;
    try {
      delivered = await deps.notify(message);
    } catch {
      delivered = false;
    }
    if (delivered) {
      verdict = { ...verdict, last_notified_at: now.toISOString() };
      persistReliabilityVerdict(dataDir, verdict);
    }
  }
  return verdict;
}

export function formatSustainedFailMessage(verdict: ReliabilityVerdict): string {
  const failing = verdict.checks.filter((check) => check.status === "fail").map((check) => check.name);
  return `reliability FAIL for ${failDays(verdict)} days: ${failing.join(", ") || "no individual check"}`;
}

export function isNotificationDue(verdict: ReliabilityVerdict, now: Date): boolean {
  if (!verdict.last_notified_at) return true;
  return now.getTime() - Date.parse(verdict.last_notified_at) >= RELIABILITY_NOTIFY_INTERVAL_MS;
}

/** macOS user notification; resolves false (never throws) when unavailable. */
export function notifyMacOS(
  message: string,
  options: { platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "darwin") return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      execFile("/usr/bin/osascript", ["-e", buildNotificationScript(message)], { timeout: 10_000 }, (error) => {
        resolve(!error);
      });
    } catch {
      resolve(false);
    }
  });
}

export function buildNotificationScript(message: string): string {
  const escaped = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
  return `display notification "${escaped}" with title "Recall"`;
}

/**
 * Notifications are always off under a test runner, so a daemon booted by a
 * test can never post to the developer's Notification Center.
 */
export function loadReliabilityVerdictConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReliabilityVerdictLoopConfig {
  const underTest = Boolean(env.VITEST) || env.NODE_ENV === "test";
  return {
    enabled: env.RECALL_RELIABILITY_VERDICT_ENABLED !== "false",
    notify: env.RECALL_RELIABILITY_VERDICT_NOTIFY !== "false" && !underTest,
    delayMs: boundedSeconds(env.RECALL_RELIABILITY_VERDICT_DELAY_SECONDS, 120, 1) * 1000,
    intervalMs: boundedSeconds(env.RECALL_RELIABILITY_VERDICT_INTERVAL_SECONDS, 86_400, 300) * 1000,
  };
}

const CHECK_HINTS: Record<string, string> = {
  repo_attribution: "sessions start outside a recognized repo or hooks are missing — see ## Agents",
  session_scope_coverage: "most sessions start outside a repo (home, /tmp, ~/Projects) and cannot receive repo memory",
  retrieval_observations: "too few used/missed retrieval observations in 14 d — inspect query and hook telemetry",
  emission_coverage: "memories selected but the hook did not emit them",
  outcome_coverage: "emitted memories never resolved — check session-end hooks",
  candidate_backlog: "run `recall maintenance cleanup` (a dry run unless you pass --apply)",
};

/** Body lines for the doctor `## Reliability` section. */
export function formatReliabilityVerdictSection(
  verdict: ReliabilityVerdict | null,
  now: Date = new Date(),
): string[] {
  if (!verdict) {
    return ["No verdict yet — the daemon computes one daily; run `recall reliability` now."];
  }
  let headline = `Overall:   ${verdict.overall.toUpperCase()}`;
  if (verdict.overall === "fail" && verdict.first_fail_at) {
    headline = `Overall:   FAIL since ${verdict.first_fail_at.slice(0, 10)} (${describeDays(failDays(verdict))})`;
    if (verdict.sustained_fail) headline += " — sustained; the daemon notifies once a day";
  }
  let computed = `Computed:  ${verdict.computed_at.slice(0, 19)}Z over the last ${RELIABILITY_VERDICT_WINDOW_DAYS} days`;
  const ageMs = now.getTime() - Date.parse(verdict.computed_at);
  if (ageMs > STALE_VERDICT_MS) {
    computed += ` — STALE (${describeDays(Math.floor(ageMs / DAY_MS))} old); is the daemon running? See Launchd/Systemd above`;
  }
  const lines = [headline, computed];
  const flagged = verdict.checks.filter((check) => check.status !== "pass");
  if (flagged.length === 0) {
    lines.push("All checks pass.");
    return lines;
  }
  for (const check of flagged) {
    lines.push(`${check.status.toUpperCase().padEnd(4)} ${check.name}: ${formatCheckValue(check)} (target ${check.target})`);
    lines.push(`     ${CHECK_HINTS[check.name] ?? "run `recall reliability` for the measured numbers"}`);
  }
  return lines;
}

function formatCheckValue(check: ReliabilityVerdictCheck): string {
  if (check.target.includes("%")) return `${(check.value * 100).toFixed(1)}%`;
  return Number.isInteger(check.value) ? String(check.value) : check.value.toFixed(2);
}

function failDays(verdict: ReliabilityVerdict): number {
  if (!verdict.first_fail_at) return 0;
  return Math.max(0, Math.floor((Date.parse(verdict.computed_at) - Date.parse(verdict.first_fail_at)) / DAY_MS));
}

function describeDays(days: number): string {
  if (days < 1) return "less than 1 day";
  return days === 1 ? "1 day" : `${days} days`;
}

function utcDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function boundedSeconds(raw: string | undefined, fallback: number, floor: number): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Math.max(floor, Number.isFinite(parsed) ? parsed : fallback);
}

function parseReliabilityVerdict(value: unknown): ReliabilityVerdict | null {
  if (!isRecord(value)) return null;
  if (!isTimestamp(value.computed_at) || !isStatus(value.overall) || !Array.isArray(value.checks)) return null;
  const checks: ReliabilityVerdictCheck[] = [];
  for (const check of value.checks) {
    if (!isRecord(check) || typeof check.name !== "string" || !isStatus(check.status)) return null;
    if (typeof check.value !== "number" || typeof check.target !== "string") return null;
    checks.push({ name: check.name, status: check.status, value: check.value, target: check.target });
  }
  const firstFailAt = value.first_fail_at;
  if (firstFailAt !== null && !isTimestamp(firstFailAt)) return null;
  const days = value.consecutive_fail_days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0) return null;
  if (typeof value.sustained_fail !== "boolean") return null;
  const lastNotifiedAt = value.last_notified_at ?? null;
  if (lastNotifiedAt !== null && !isTimestamp(lastNotifiedAt)) return null;
  return {
    computed_at: value.computed_at,
    overall: value.overall,
    checks,
    first_fail_at: firstFailAt,
    consecutive_fail_days: days,
    sustained_fail: value.sustained_fail,
    last_notified_at: lastNotifiedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is ReliabilityStatus {
  return value === "pass" || value === "warn" || value === "fail";
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

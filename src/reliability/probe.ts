import type { RecallDb } from "../db/client.js";
import { listBackups, verifyBackupIntegrity } from "../backups/snapshot.js";
import { createActivityEvent } from "../models/activity.js";
import { runReliabilityCanary } from "./canary.js";
import { computeReliabilityReport } from "./report.js";

export interface ReliabilityProbeResult {
  ok: boolean;
  checked_at: string;
  duration_ms: number;
  database_integrity: boolean;
  backup_integrity: boolean;
  backup_path: string | null;
  canary_ok: boolean;
  reliability_overall: "pass" | "warn" | "fail";
  error?: string;
}

export async function runReliabilityProbe(
  db: RecallDb,
  options: {
    real_embeddings?: boolean;
    record?: boolean;
    run_canary?: () => Promise<{ ok: boolean }>;
  } = {},
): Promise<ReliabilityProbeResult> {
  const started = performance.now();
  const checkedAt = new Date().toISOString();
  let result: ReliabilityProbeResult;
  try {
    const databaseIntegrity = db.$client.pragma("quick_check", { simple: true }) === "ok";
    const backup = listBackups(db.$client.name)[0];
    const backupIntegrity = Boolean(backup && verifyBackupIntegrity(backup.path));
    const canary = options.run_canary
      ? await options.run_canary()
      : await runReliabilityCanary({ real_embeddings: options.real_embeddings });
    const reliability = computeReliabilityReport(db);
    result = {
      ok: databaseIntegrity && backupIntegrity && canary.ok,
      checked_at: checkedAt,
      duration_ms: Math.round(performance.now() - started),
      database_integrity: databaseIntegrity,
      backup_integrity: backupIntegrity,
      backup_path: backup?.path ?? null,
      canary_ok: canary.ok,
      reliability_overall: reliability.overall,
    };
  } catch (error) {
    result = {
      ok: false,
      checked_at: checkedAt,
      duration_ms: Math.round(performance.now() - started),
      database_integrity: false,
      backup_integrity: false,
      backup_path: null,
      canary_ok: false,
      reliability_overall: "fail",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (options.record !== false) {
    createActivityEvent(db, {
      source: "system",
      event_type: "signal",
      request: { name: "reliability_probe" },
      result: { ...result },
    });
  }
  return result;
}

/**
 * Implicit feedback signals — infer memory quality from indirect signals:
 *   - test pass/fail after injection
 *   - file unchanged vs rewritten after injection
 *   - task acceptance/rejection
 *
 * These signals feed back into confidence adjustments.
 */

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { RecallDb } from "../db/client.js";
import { implicitSignals, memories } from "../db/schema.js";
import { promoteMemory, demoteMemory } from "../models/memory.js";

type SignalType =
  | "test_pass"
  | "test_fail"
  | "file_unchanged"
  | "file_rewritten"
  | "task_accepted"
  | "task_rejected";

// --- Signal weights (how much each signal affects confidence) ---

const SIGNAL_WEIGHTS: Record<SignalType, number> = {
  test_pass: 0.03,
  test_fail: -0.15,
  file_unchanged: 0.02,
  file_rewritten: -0.1,
  task_accepted: 0.05,
  task_rejected: -0.2,
};

// --- Record a signal ---

export function recordSignal(
  db: RecallDb,
  memoryId: string,
  sessionId: string,
  signalType: SignalType,
  context?: string,
): string {
  const id = randomUUID();
  db.insert(implicitSignals)
    .values({
      id,
      memory_id: memoryId,
      session_id: sessionId,
      signal_type: signalType,
      timestamp: new Date().toISOString(),
      context: context ?? null,
    })
    .run();

  // Apply confidence adjustment
  const weight = SIGNAL_WEIGHTS[signalType];
  if (weight > 0) {
    promoteMemory(db, memoryId, "passive_gain");
  } else if (weight < 0) {
    demoteMemory(db, memoryId, `implicit:${signalType}`);
  }

  return id;
}

// --- Get signals for a memory ---

export function getSignals(db: RecallDb, memoryId: string) {
  return db
    .select()
    .from(implicitSignals)
    .where(eq(implicitSignals.memory_id, memoryId))
    .all();
}

// --- Detect test results ---

export interface TestResult {
  passed: boolean;
  output?: string;
}

/**
 * After running tests, record implicit signals for all memories
 * that were injected in the current session.
 */
export function recordTestSignals(
  db: RecallDb,
  sessionId: string,
  injectedMemoryIds: string[],
  testResult: TestResult,
): string[] {
  const signalType: SignalType = testResult.passed ? "test_pass" : "test_fail";
  const ids: string[] = [];

  for (const memId of injectedMemoryIds) {
    const id = recordSignal(
      db,
      memId,
      sessionId,
      signalType,
      testResult.output?.slice(0, 500),
    );
    ids.push(id);
  }

  return ids;
}

// --- Detect file changes (post-injection) ---

/**
 * Check if files were modified after memory injection.
 * Compares git diff to see if agent output was rewritten.
 */
export function detectFileChanges(
  repoPath: string,
  files: string[],
): Map<string, "unchanged" | "rewritten"> {
  const results = new Map<string, "unchanged" | "rewritten">();

  try {
    const diff = execFileSync("git", ["diff", "--name-only"], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const changedFiles = new Set(diff.split("\n").filter(Boolean));

    for (const file of files) {
      results.set(
        file,
        changedFiles.has(file) ? "rewritten" : "unchanged",
      );
    }
  } catch {
    // Not a git repo or git error — mark all as unchanged
    for (const file of files) {
      results.set(file, "unchanged");
    }
  }

  return results;
}

/**
 * Record file-change signals for injected memories.
 */
export function recordFileChangeSignals(
  db: RecallDb,
  sessionId: string,
  memoryIds: string[],
  changes: Map<string, "unchanged" | "rewritten">,
): string[] {
  const ids: string[] = [];
  const hasRewrites = [...changes.values()].some((v) => v === "rewritten");

  const signalType: SignalType = hasRewrites
    ? "file_rewritten"
    : "file_unchanged";

  for (const memId of memoryIds) {
    const id = recordSignal(
      db,
      memId,
      sessionId,
      signalType,
      `files: ${[...changes.entries()].map(([f, s]) => `${f}:${s}`).join(", ")}`,
    );
    ids.push(id);
  }

  return ids;
}

// --- Aggregate signal stats ---

export function getSignalStats(
  db: RecallDb,
  memoryId: string,
): Record<SignalType, number> {
  const signals = getSignals(db, memoryId);
  const stats: Record<string, number> = {
    test_pass: 0,
    test_fail: 0,
    file_unchanged: 0,
    file_rewritten: 0,
    task_accepted: 0,
    task_rejected: 0,
  };

  for (const s of signals) {
    stats[s.signal_type] = (stats[s.signal_type] ?? 0) + 1;
  }

  return stats as Record<SignalType, number>;
}

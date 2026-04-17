/**
 * Audit trail — versioned history of every memory mutation.
 *
 * Records who changed what, when, why. Supports diff between versions
 * and rollback to a previous state.
 */

import { eq, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { auditTrail, memories } from "../db/schema.js";
import { queueMemoryEmbeddingSync } from "../embeddings/embeddings.js";
import { getMemory } from "../models/memory.js";
import type { AuditAction, AuditEntry, MemoryItem } from "../types.js";

// --- Record an audit entry ---

export function recordAudit(
  db: RecallDb,
  memoryId: string,
  action: AuditAction,
  actor: string,
  reason: string | null,
  beforeSnapshot?: string | null,
  afterSnapshot?: string | null,
): string {
  const id = randomUUID();

  // Auto-capture snapshots if not provided
  if (afterSnapshot === undefined) {
    const mem = getMemory(db, memoryId);
    if (mem) {
      afterSnapshot = JSON.stringify(mem);
    }
  }

  db.insert(auditTrail)
    .values({
      id,
      memory_id: memoryId,
      action,
      actor,
      before_snapshot: beforeSnapshot ?? null,
      after_snapshot: afterSnapshot ?? null,
      reason: reason ?? null,
      timestamp: new Date().toISOString(),
    })
    .run();

  return id;
}

/** Record with explicit before/after snapshots */
export function recordAuditWithSnapshot(
  db: RecallDb,
  memoryId: string,
  action: AuditAction,
  actor: string,
  reason: string | null,
  before: MemoryItem | null,
  after: MemoryItem | null,
): string {
  return recordAudit(
    db,
    memoryId,
    action,
    actor,
    reason,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
  );
}

// --- Query audit trail ---

export function getAuditTrail(
  db: RecallDb,
  memoryId: string,
): AuditEntry[] {
  return db
    .select()
    .from(auditTrail)
    .where(eq(auditTrail.memory_id, memoryId))
    .orderBy(desc(auditTrail.timestamp))
    .all()
    .map(rowToAudit);
}

export function getRecentAudit(
  db: RecallDb,
  limit: number = 50,
): AuditEntry[] {
  return db
    .select()
    .from(auditTrail)
    .orderBy(desc(auditTrail.timestamp))
    .limit(limit)
    .all()
    .map(rowToAudit);
}

// --- Diff between versions ---

export interface MemoryDiff {
  field: string;
  before: unknown;
  after: unknown;
}

export function diffSnapshots(
  before: string | null,
  after: string | null,
): MemoryDiff[] {
  if (!before || !after) return [];

  const a = JSON.parse(before);
  const b = JSON.parse(after);
  const diffs: MemoryDiff[] = [];

  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === "evidence" || key === "embedding") continue; // skip large fields
    const va = JSON.stringify(a[key]);
    const vb = JSON.stringify(b[key]);
    if (va !== vb) {
      diffs.push({ field: key, before: a[key], after: b[key] });
    }
  }

  return diffs;
}

// --- Rollback ---

export function rollbackMemory(
  db: RecallDb,
  memoryId: string,
  auditEntryId: string,
  actor: string,
): boolean {
  const entry = db
    .select()
    .from(auditTrail)
    .where(eq(auditTrail.id, auditEntryId))
    .get();

  if (!entry) return false;

  // Use the before_snapshot to restore state
  const snapshot = entry.before_snapshot;
  if (!snapshot) return false;

  const beforeRollback = getMemory(db, memoryId);
  const restored = JSON.parse(snapshot) as MemoryItem;

  db.update(memories)
    .set({
      text: restored.text,
      type: restored.type,
      scope: restored.scope,
      path_scope: restored.path_scope,
      status: restored.status,
      confidence: restored.confidence,
      source: restored.source,
      evidence: restored.evidence as any,
      capture_context: restored.capture_context as any,
      repetition_count: restored.repetition_count,
      updated_at: new Date().toISOString(),
    })
    .where(eq(memories.id, memoryId))
    .run();
  queueMemoryEmbeddingSync(db, memoryId);

  recordAuditWithSnapshot(
    db,
    memoryId,
    "rolled_back",
    actor,
    `Rolled back to state from ${entry.timestamp}`,
    beforeRollback ?? null,
    getMemory(db, memoryId) ?? null,
  );

  return true;
}

// --- Format audit trail ---

export function formatAuditTrail(entries: AuditEntry[]): string {
  if (entries.length === 0) return "No audit entries.";

  const lines = ["# Audit Trail", ""];
  for (const e of entries) {
    const diffs = diffSnapshots(e.before_snapshot, e.after_snapshot);
    const diffStr = diffs.length > 0
      ? ` [${diffs.map((d) => `${d.field}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`).join(", ")}]`
      : "";
    lines.push(
      `${e.timestamp.slice(0, 19)}  ${e.action.padEnd(22)} by ${e.actor}${e.reason ? ` — ${e.reason}` : ""}${diffStr}`,
    );
  }

  return lines.join("\n");
}

// --- Helpers ---

function rowToAudit(row: any): AuditEntry {
  return {
    id: row.id,
    memory_id: row.memory_id,
    action: row.action,
    actor: row.actor,
    before_snapshot: row.before_snapshot,
    after_snapshot: row.after_snapshot,
    reason: row.reason,
    timestamp: row.timestamp,
  };
}

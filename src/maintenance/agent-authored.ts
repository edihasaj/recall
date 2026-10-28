import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { maintenanceCleanupLog, memories } from "../db/schema.js";
import { getMemory } from "../models/memory.js";
import { recordAuditWithSnapshot } from "../audit/trail.js";
import {
  createCodexRolloutLocator,
  isAutomatedCodexSource,
  readCodexThreadSource,
} from "../cli/codex-thread-origin.js";
import type { EvidenceEntry } from "../types.js";

/**
 * Rejects stored "corrections" whose every source is a prompt written by an
 * agent or script. Before the prompt hook learned to tell those threads
 * apart, Codex `exec`, subagent and MCP-server task briefs were captured as
 * the user's words, and repeated scripted runs promoted them.
 *
 * Fail-closed: a memory is rejected only when every evidence entry is a
 * session correction or repetition, and every one of those sessions is a
 * local Codex rollout that records an automated origin. Explicit
 * confirmation, reactivation, other evidence types, sessions from another
 * machine, and unreadable rollouts all keep the memory.
 */
export interface RejectAgentAuthoredPlan {
  kind: "reject_agent_authored";
  memory_id: string;
  text: string;
  sessions: Array<{ session_id: string; source: string }>;
}

const ACTOR = "maintenance:cleanup";

export function planRejectAgentAuthored(
  db: RecallDb,
  opts: { locate?: (threadId: string, startedAt?: string) => string | null } = {},
): RejectAgentAuthoredPlan[] {
  const locate = opts.locate ?? createCodexRolloutLocator();
  const sourceCache = new Map<string, string | null>();
  const sourceOf = (sessionId: string, startedAt?: string): string | null => {
    if (!sourceCache.has(sessionId)) {
      const path = locate(sessionId, startedAt);
      sourceCache.set(sessionId, path ? readCodexThreadSource(path) : null);
    }
    return sourceCache.get(sessionId) ?? null;
  };

  const rows = db.select({ id: memories.id, text: memories.text, evidence: memories.evidence })
    .from(memories)
    .where(and(
      inArray(memories.status, ["active", "candidate"]),
      eq(memories.source, "user_correction"),
    ))
    .all();

  const plans: RejectAgentAuthoredPlan[] = [];
  for (const row of rows) {
    const evidence = parseEvidence(row.evidence);
    if (evidence.length === 0) continue;
    const sessions = new Map<string, string | undefined>();
    let eligible = true;
    for (const entry of evidence) {
      if (entry.type === "session_correction" && entry.session) {
        sessions.set(entry.session, entry.timestamp);
      } else if (entry.type === "repeated_correction" && Array.isArray(entry.sessions) && entry.sessions.length > 0) {
        for (const session of entry.sessions) {
          if (!sessions.has(session)) sessions.set(session, entry.timestamp);
        }
      } else {
        eligible = false;
        break;
      }
    }
    if (!eligible || sessions.size === 0) continue;
    const origins: RejectAgentAuthoredPlan["sessions"] = [];
    for (const [sessionId, startedAt] of sessions) {
      const source = sourceOf(sessionId, startedAt);
      if (!isAutomatedCodexSource(source)) {
        eligible = false;
        break;
      }
      origins.push({ session_id: sessionId, source: source! });
    }
    if (!eligible) continue;
    plans.push({ kind: "reject_agent_authored", memory_id: row.id, text: row.text, sessions: origins });
  }
  return plans;
}

export function applyRejectAgentAuthored(db: RecallDb, runId: string, plan: RejectAgentAuthoredPlan) {
  const before = getMemory(db, plan.memory_id);
  if (!before || !["active", "candidate"].includes(before.status)) return;

  const now = new Date().toISOString();
  db.update(memories)
    .set({ status: "rejected", dedupe_key: null, updated_at: now })
    .where(eq(memories.id, plan.memory_id))
    .run();

  const after = getMemory(db, plan.memory_id);
  recordAuditWithSnapshot(
    db,
    plan.memory_id,
    "rejected",
    ACTOR,
    `cleanup_agent_authored:run:${runId}`,
    before,
    after ?? null,
  );

  db.insert(maintenanceCleanupLog).values({
    id: randomUUID(),
    run_id: runId,
    action: "reject_agent_authored",
    memory_id: plan.memory_id,
    related_memory_id: null,
    before_snapshot: before as unknown as any,
    after_snapshot: after as unknown as any,
    details: { sessions: plan.sessions } as any,
    reverted: false,
    reverted_at: null,
    created_at: now,
  }).run();
}

function parseEvidence(value: unknown): Array<EvidenceEntry & { sessions?: string[] }> {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  return Array.isArray(parsed) ? parsed as Array<EvidenceEntry & { sessions?: string[] }> : [];
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

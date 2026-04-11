/**
 * Org-level policy engine + approval workflows.
 *
 * Policy rules control what memories can be promoted, what needs approval,
 * and what's automatically accepted. Admins set policy, members submit
 * memories, admins approve.
 */

import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { policyRules, approvalRequests, memories } from "../db/schema.js";
import { getMemory, confirmMemory, rejectMemory, queryMemories } from "../models/memory.js";
import { recordAudit } from "../audit/trail.js";
import type { PolicyRule, ApprovalStatus, MemoryItem } from "../types.js";

// --- Policy CRUD ---

export function createPolicy(
  db: RecallDb,
  orgId: string,
  ruleType: PolicyRule["rule_type"],
  config: Record<string, unknown>,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(policyRules)
    .values({
      id,
      org_id: orgId,
      rule_type: ruleType,
      config: config as any,
      enabled: true,
      created_at: now,
      updated_at: now,
    })
    .run();
  return id;
}

export function listPolicies(db: RecallDb, orgId: string): PolicyRule[] {
  return db
    .select()
    .from(policyRules)
    .where(eq(policyRules.org_id, orgId))
    .all()
    .map(rowToPolicy);
}

export function togglePolicy(db: RecallDb, policyId: string, enabled: boolean) {
  db.update(policyRules)
    .set({ enabled, updated_at: new Date().toISOString() })
    .where(eq(policyRules.id, policyId))
    .run();
}

export function deletePolicy(db: RecallDb, policyId: string) {
  db.delete(policyRules).where(eq(policyRules.id, policyId)).run();
}

// --- Policy evaluation ---

export interface PolicyViolation {
  rule_id: string;
  rule_type: string;
  message: string;
  blocking: boolean;
}

export function evaluatePolicy(
  db: RecallDb,
  orgId: string,
  memory: MemoryItem,
): PolicyViolation[] {
  const rules = listPolicies(db, orgId).filter((r) => r.enabled);
  const violations: PolicyViolation[] = [];

  for (const rule of rules) {
    const cfg = rule.config as Record<string, any>;

    switch (rule.rule_type) {
      case "min_confidence": {
        const min = cfg.min_confidence ?? 0.6;
        if (memory.confidence < min) {
          violations.push({
            rule_id: rule.id,
            rule_type: rule.rule_type,
            message: `Confidence ${memory.confidence.toFixed(2)} below minimum ${min}`,
            blocking: true,
          });
        }
        break;
      }

      case "require_approval": {
        const forTypes = cfg.for_types as string[] | undefined;
        if (!forTypes || forTypes.includes(memory.type)) {
          violations.push({
            rule_id: rule.id,
            rule_type: rule.rule_type,
            message: `Memory type "${memory.type}" requires approval before activation`,
            blocking: true,
          });
        }
        break;
      }

      case "allowed_sources": {
        const allowed = cfg.sources as string[] | undefined;
        if (allowed && !allowed.includes(memory.source)) {
          violations.push({
            rule_id: rule.id,
            rule_type: rule.rule_type,
            message: `Source "${memory.source}" not in allowed list: ${allowed.join(", ")}`,
            blocking: true,
          });
        }
        break;
      }

      case "blocked_scopes": {
        const blocked = cfg.scopes as string[] | undefined;
        if (blocked && blocked.includes(memory.scope)) {
          violations.push({
            rule_id: rule.id,
            rule_type: rule.rule_type,
            message: `Scope "${memory.scope}" is blocked by policy`,
            blocking: true,
          });
        }
        break;
      }

      case "max_active_per_repo": {
        const max = cfg.max ?? 50;
        if (memory.repo) {
          const active = queryMemories(db, { repo: memory.repo, status: "active" });
          if (active.length >= max) {
            violations.push({
              rule_id: rule.id,
              rule_type: rule.rule_type,
              message: `Repo "${memory.repo}" has ${active.length}/${max} active memories`,
              blocking: true,
            });
          }
        }
        break;
      }

      case "require_evidence_count": {
        const minEvidence = cfg.min_evidence ?? 2;
        if (memory.evidence.length < minEvidence) {
          violations.push({
            rule_id: rule.id,
            rule_type: rule.rule_type,
            message: `Memory has ${memory.evidence.length} evidence entries, needs ${minEvidence}`,
            blocking: true,
          });
        }
        break;
      }

      case "auto_approve_pattern": {
        // Not a violation — handled separately
        break;
      }
    }
  }

  return violations;
}

/** Check if a memory matches any auto-approve pattern */
export function matchesAutoApprove(
  db: RecallDb,
  orgId: string,
  memory: MemoryItem,
): boolean {
  const rules = listPolicies(db, orgId).filter(
    (r) => r.enabled && r.rule_type === "auto_approve_pattern",
  );

  for (const rule of rules) {
    const cfg = rule.config as Record<string, any>;
    const pattern = cfg.pattern as string | undefined;
    if (pattern) {
      try {
        const regex = new RegExp(pattern, "i");
        if (regex.test(memory.text)) return true;
      } catch {
        // Invalid regex, skip
      }
    }

    const sources = cfg.sources as string[] | undefined;
    if (sources && sources.includes(memory.source)) return true;

    const types = cfg.types as string[] | undefined;
    if (types && types.includes(memory.type)) return true;
  }

  return false;
}

// --- Approval queue ---

export function requestApproval(
  db: RecallDb,
  memoryId: string,
  orgId: string,
  requestedBy: string,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();

  db.insert(approvalRequests)
    .values({
      id,
      memory_id: memoryId,
      org_id: orgId,
      requested_by: requestedBy,
      status: "pending",
      created_at: now,
    })
    .run();

  recordAudit(db, memoryId, "approval_requested", requestedBy, null);
  return id;
}

export function resolveApproval(
  db: RecallDb,
  approvalId: string,
  status: "approved" | "denied",
  reviewedBy: string,
  reason?: string,
): boolean {
  const row = db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalId))
    .get();
  if (!row) return false;

  const now = new Date().toISOString();
  db.update(approvalRequests)
    .set({
      status,
      reviewed_by: reviewedBy,
      reason: reason ?? null,
      resolved_at: now,
    })
    .where(eq(approvalRequests.id, approvalId))
    .run();

  // Apply the decision
  if (status === "approved") {
    confirmMemory(db, row.memory_id);
  } else {
    rejectMemory(db, row.memory_id);
  }

  recordAudit(db, row.memory_id, "approval_resolved", reviewedBy, reason ?? null);
  return true;
}

export function listPendingApprovals(
  db: RecallDb,
  orgId: string,
) {
  return db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.org_id, orgId),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .all();
}

export function getApproval(db: RecallDb, id: string) {
  return db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, id))
    .get();
}

// --- Helpers ---

function rowToPolicy(row: any): PolicyRule {
  return {
    ...row,
    config:
      typeof row.config === "string" ? JSON.parse(row.config) : row.config ?? {},
    enabled: Boolean(row.enabled),
  };
}

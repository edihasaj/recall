import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { initDb } from "../db/client.js";
import {
  queryMemories,
  getMemory,
  confirmMemory,
  rejectMemory,
  recordFeedback,
  listMemories,
} from "../models/memory.js";
import { compileContext } from "../compiler/context.js";
import { processCorrection, processReviewFeedback } from "../capture/correction.js";
import { scanAndStore } from "../scanner/repo.js";
import { computeMetrics, formatMetricsReport } from "../eval/harness.js";
import { recordSignal, getSignalStats } from "../feedback/implicit.js";
import { inferScope } from "../capture/scope.js";
import { evaluatePolicy, listPendingApprovals, resolveApproval } from "../policy/engine.js";
import { computeHealthScore, computeAllHealthScores, formatHealthReport } from "../health/scoring.js";
import { detectContradictions, resolveContradiction, autoResolveContradictions } from "../contradictions/detector.js";
import { pruneMemories, formatPruneReport } from "../pruning/pruner.js";
import { getAuditTrail, getRecentAudit, formatAuditTrail, rollbackMemory } from "../audit/trail.js";

const db = initDb();

const server = new McpServer({
  name: "recall",
  version: "0.1.0",
});

// --- Tools ---

server.tool(
  "recall_query",
  "Retrieve relevant memories for the current task context. Returns compiled, confidence-gated memories scoped to the repo and path.",
  {
    repo: z.string().describe("Repository name (e.g., owner/repo)"),
    path: z.string().optional().describe("Current file path for path-scoped filtering"),
    min_confidence: z.number().optional().describe("Minimum confidence threshold (default: 0.6)"),
  },
  async ({ repo, path, min_confidence }) => {
    const result = compileContext(db, {
      repo,
      path,
      config: min_confidence ? { confidence_threshold: min_confidence } : {},
    });

    if (!result.text) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No memories above confidence threshold for this context.",
          },
        ],
      };
    }

    return {
      content: [{ type: "text" as const, text: result.text }],
    };
  },
);

server.tool(
  "recall_list",
  "List all memories for a repository, optionally filtered by status.",
  {
    repo: z.string().describe("Repository name"),
    status: z
      .enum(["transient", "candidate", "active", "rejected"])
      .optional()
      .describe("Filter by memory status"),
  },
  async ({ repo, status }) => {
    const items = queryMemories(db, { repo, status });
    if (items.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No memories found." }],
      };
    }

    const lines = items.map(
      (m) =>
        `[${m.status}] (${m.confidence.toFixed(2)}) ${m.type}: ${m.text} [${m.id.slice(0, 8)}]`,
    );

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  },
);

server.tool(
  "recall_report_correction",
  "Report a correction or rule to be learned. Creates a candidate memory from the correction text.",
  {
    text: z.string().describe("The correction or rule (e.g., 'don't use pip, use uv')"),
    repo: z.string().optional().describe("Repository name"),
    path: z.string().optional().describe("File path context"),
    session_id: z.string().optional().describe("Session identifier"),
  },
  async ({ text, repo, path, session_id }) => {
    const ids = processCorrection(db, text, {
      sessionId: session_id ?? "mcp",
      repo,
      path,
    });

    if (ids.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No correction pattern detected. Try phrasing as a rule (e.g., 'always use X' or 'don't use Y, use Z').",
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Created ${ids.length} candidate memory/memories: ${ids.map((id) => id.slice(0, 8)).join(", ")}`,
        },
      ],
    };
  },
);

server.tool(
  "recall_report_review",
  "Report review feedback from a code review. Creates candidate memories from review comments.",
  {
    feedback: z.string().describe("The review feedback"),
    repo: z.string().optional().describe("Repository name"),
    path: z.string().optional().describe("File path context"),
    reviewer: z.string().optional().describe("Reviewer name"),
  },
  async ({ feedback, repo, path, reviewer }) => {
    const ids = processReviewFeedback(db, feedback, {
      sessionId: "mcp-review",
      repo,
      path,
      reviewer,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Created ${ids.length} candidate memory/memories from review feedback: ${ids.map((id) => id.slice(0, 8)).join(", ")}`,
        },
      ],
    };
  },
);

server.tool(
  "recall_confirm",
  "Confirm a candidate memory, promoting it to active status.",
  {
    memory_id: z.string().describe("Memory ID to confirm"),
  },
  async ({ memory_id }) => {
    const success = confirmMemory(db, memory_id);
    if (!success) {
      return {
        content: [
          { type: "text" as const, text: `Memory ${memory_id} not found or already rejected.` },
        ],
      };
    }
    return {
      content: [
        { type: "text" as const, text: `Memory ${memory_id.slice(0, 8)} confirmed and promoted to active.` },
      ],
    };
  },
);

server.tool(
  "recall_reject",
  "Reject a memory. It will never be injected again.",
  {
    memory_id: z.string().describe("Memory ID to reject"),
  },
  async ({ memory_id }) => {
    const success = rejectMemory(db, memory_id);
    if (!success) {
      return {
        content: [
          { type: "text" as const, text: `Memory ${memory_id} not found.` },
        ],
      };
    }
    return {
      content: [
        { type: "text" as const, text: `Memory ${memory_id.slice(0, 8)} rejected.` },
      ],
    };
  },
);

server.tool(
  "recall_feedback",
  "Record feedback about an injected memory — whether it was followed, overridden, ignored, or contradicted.",
  {
    memory_id: z.string().describe("Memory ID"),
    session_id: z.string().describe("Session ID"),
    injected: z.boolean().describe("Was the memory injected into this session?"),
    outcome: z
      .enum(["followed", "overridden", "ignored", "contradicted"])
      .describe("What happened with the memory"),
  },
  async ({ memory_id, session_id, injected, outcome }) => {
    const id = recordFeedback(db, memory_id, session_id, injected, outcome);
    return {
      content: [
        { type: "text" as const, text: `Feedback recorded: ${id.slice(0, 8)}` },
      ],
    };
  },
);

server.tool(
  "recall_scan",
  "Scan a repository and bootstrap memories from config files, scripts, and instruction files.",
  {
    repo_path: z.string().describe("Absolute path to the repository root"),
  },
  async ({ repo_path }) => {
    const ids = scanAndStore(db, repo_path);
    return {
      content: [
        {
          type: "text" as const,
          text: `Scanned repo. Created ${ids.length} candidate memories.`,
        },
      ],
    };
  },
);

// --- Phase 2 tools ---

server.tool(
  "recall_eval",
  "Get evaluation metrics for memory effectiveness.",
  {
    repo: z.string().optional().describe("Filter by repo"),
    since: z.string().optional().describe("Since date (ISO)"),
  },
  async ({ repo, since }) => {
    const metrics = computeMetrics(db, { repo, since });
    return {
      content: [{ type: "text" as const, text: formatMetricsReport(metrics) }],
    };
  },
);

server.tool(
  "recall_signal",
  "Record an implicit feedback signal (test pass/fail, file unchanged/rewritten, task accepted/rejected).",
  {
    memory_id: z.string().describe("Memory ID"),
    session_id: z.string().describe("Session ID"),
    signal_type: z
      .enum(["test_pass", "test_fail", "file_unchanged", "file_rewritten", "task_accepted", "task_rejected"])
      .describe("Type of implicit signal"),
    context: z.string().optional().describe("Additional context"),
  },
  async ({ memory_id, session_id, signal_type, context }) => {
    const id = recordSignal(db, memory_id, session_id, signal_type, context);
    const stats = getSignalStats(db, memory_id);
    return {
      content: [
        {
          type: "text" as const,
          text: `Signal recorded: ${id.slice(0, 8)}. Stats: ${JSON.stringify(stats)}`,
        },
      ],
    };
  },
);

server.tool(
  "recall_scope",
  "Analyze the scope of a correction text. Returns inferred scope, path, and reasoning.",
  {
    text: z.string().describe("Correction text to analyze"),
    path: z.string().optional().describe("Context file path"),
  },
  async ({ text, path }) => {
    const result = inferScope(text, path);
    return {
      content: [
        {
          type: "text" as const,
          text: `Scope: ${result.scope}, Path: ${result.path_scope ?? "none"}, Reason: ${result.reason}`,
        },
      ],
    };
  },
);

// --- Phase 3 tools ---

server.tool(
  "recall_health",
  "Get memory health scores. Returns composite health report for all memories or a single memory.",
  {
    repo: z.string().optional().describe("Filter by repo"),
    memory_id: z.string().optional().describe("Score a single memory"),
  },
  async ({ repo, memory_id }) => {
    if (memory_id) {
      const score = computeHealthScore(db, memory_id);
      if (!score) {
        return { content: [{ type: "text" as const, text: "Memory not found." }] };
      }
      return {
        content: [{
          type: "text" as const,
          text: `Health: ${(score.score * 100).toFixed(0)}% | Conf: ${(score.confidence_component * 100).toFixed(0)}% | Fresh: ${(score.freshness_component * 100).toFixed(0)}% | Follow: ${(score.follow_rate_component * 100).toFixed(0)}% | Signal: ${(score.signal_ratio_component * 100).toFixed(0)}%`,
        }],
      };
    }
    const scores = computeAllHealthScores(db, repo);
    return { content: [{ type: "text" as const, text: formatHealthReport(scores) }] };
  },
);

server.tool(
  "recall_contradictions",
  "Detect contradictions between memories. Finds conflicting rules, negations, and scope overlaps.",
  {
    repo: z.string().optional().describe("Filter by repo"),
    auto_resolve: z.boolean().optional().describe("Auto-resolve by confidence (default: false)"),
  },
  async ({ repo, auto_resolve }) => {
    const found = detectContradictions(db, repo);
    if (auto_resolve) {
      const resolved = autoResolveContradictions(db, repo);
      return {
        content: [{
          type: "text" as const,
          text: `Detected ${found.length} contradiction(s). Auto-resolved ${resolved}.`,
        }],
      };
    }
    if (found.length === 0) {
      return { content: [{ type: "text" as const, text: "No contradictions detected." }] };
    }
    const lines = found.map(
      (c) => `[${c.severity}] ${c.contradiction_type}: ${c.description} (${c.id.slice(0, 8)})`,
    );
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

server.tool(
  "recall_prune",
  "Auto-prune stale, rejected, transient, and unhealthy memories.",
  {
    dry_run: z.boolean().optional().describe("Preview without making changes (default: false)"),
    stale_days: z.number().optional().describe("Days before archiving stale memories (default: 90)"),
    min_health_score: z.number().optional().describe("Min health score for active (default: 0.2)"),
  },
  async ({ dry_run, stale_days, min_health_score }) => {
    const result = pruneMemories(db, { dry_run: dry_run ?? false, stale_days, min_health_score });
    return {
      content: [{ type: "text" as const, text: formatPruneReport(result, dry_run ?? false) }],
    };
  },
);

server.tool(
  "recall_audit",
  "View audit trail for a memory or recent activity.",
  {
    memory_id: z.string().optional().describe("Memory ID (omit for recent global audit)"),
    limit: z.number().optional().describe("Max entries for recent audit (default: 50)"),
  },
  async ({ memory_id, limit }) => {
    const entries = memory_id
      ? getAuditTrail(db, memory_id)
      : getRecentAudit(db, limit ?? 50);
    return {
      content: [{ type: "text" as const, text: formatAuditTrail(entries) }],
    };
  },
);

server.tool(
  "recall_rollback",
  "Rollback a memory to a previous state using an audit entry.",
  {
    memory_id: z.string().describe("Memory ID"),
    audit_entry_id: z.string().describe("Audit entry ID to rollback to"),
    actor: z.string().optional().describe("Who is performing the rollback"),
  },
  async ({ memory_id, audit_entry_id, actor }) => {
    const ok = rollbackMemory(db, memory_id, audit_entry_id, actor ?? "mcp");
    return {
      content: [{
        type: "text" as const,
        text: ok
          ? `Memory ${memory_id.slice(0, 8)} rolled back successfully.`
          : "Rollback failed. Audit entry not found or no snapshot available.",
      }],
    };
  },
);

server.tool(
  "recall_policy_check",
  "Check a memory against org policies. Returns policy violations.",
  {
    org_id: z.string().describe("Organization ID"),
    memory_id: z.string().describe("Memory ID to check"),
  },
  async ({ org_id, memory_id }) => {
    const mem = getMemory(db, memory_id);
    if (!mem) {
      return { content: [{ type: "text" as const, text: "Memory not found." }] };
    }
    const violations = evaluatePolicy(db, org_id, mem);
    if (violations.length === 0) {
      return { content: [{ type: "text" as const, text: "No policy violations." }] };
    }
    const lines = violations.map(
      (v) => `[${v.blocking ? "BLOCK" : "WARN"}] ${v.rule_type}: ${v.message}`,
    );
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

server.tool(
  "recall_approval_list",
  "List pending approval requests for an organization.",
  {
    org_id: z.string().describe("Organization ID"),
  },
  async ({ org_id }) => {
    const pending = listPendingApprovals(db, org_id);
    if (pending.length === 0) {
      return { content: [{ type: "text" as const, text: "No pending approvals." }] };
    }
    const lines = pending.map(
      (a) => `${a.id.slice(0, 8)} memory:${a.memory_id.slice(0, 8)} by:${a.requested_by} ${a.created_at}`,
    );
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

server.tool(
  "recall_approval_resolve",
  "Approve or deny a pending approval request.",
  {
    approval_id: z.string().describe("Approval request ID"),
    status: z.enum(["approved", "denied"]).describe("Decision"),
    reviewed_by: z.string().optional().describe("Reviewer name"),
    reason: z.string().optional().describe("Reason for decision"),
  },
  async ({ approval_id, status, reviewed_by, reason }) => {
    const ok = resolveApproval(db, approval_id, status, reviewed_by ?? "mcp", reason);
    return {
      content: [{
        type: "text" as const,
        text: ok
          ? `Approval ${approval_id.slice(0, 8)} → ${status}`
          : "Approval not found.",
      }],
    };
  },
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);

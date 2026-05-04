import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { initDb } from "../db/client.js";
import { tagActivitySource } from "../types.js";
import {
  queryMemories,
  getMemory,
  confirmMemory,
  rejectMemory,
  recordFeedback,
  listMemories,
  demoteGlobalMemory,
} from "../models/memory.js";
import { recordAudit } from "../audit/trail.js";
import { compileContext, compileContextHybrid } from "../compiler/context.js";
import { processCorrection, processReviewFeedback } from "../capture/correction.js";
import { scanAndStore } from "../scanner/repo.js";
import { computeMetrics, formatMetricsReport } from "../eval/harness.js";
import { formatRetrievalEvalReport, runRetrievalEval } from "../eval/retrieval.js";
import { recordSignal, getSignalStats } from "../feedback/implicit.js";
import { inferScope } from "../capture/scope.js";
import { evaluatePolicy, listPendingApprovals, resolveApproval } from "../policy/engine.js";
import { computeHealthScore, computeAllHealthScores, formatHealthReport } from "../health/scoring.js";
import { detectContradictions, resolveContradiction, autoResolveContradictions } from "../contradictions/detector.js";
import { pruneMemories, formatPruneReport } from "../pruning/pruner.js";
import { getAuditTrail, getRecentAudit, formatAuditTrail, rollbackMemory } from "../audit/trail.js";
import { getRepoQualityProfile } from "../repo/quality.js";
import { createActivityEvent, listActivityEvents, listActivitySessions } from "../models/activity.js";
import { ensureRepoBootstrapped } from "../repo/discovery.js";
import {
  captureCorrectionFallback,
  sessionEndFallback,
  signalOutcomeFallback,
} from "./fallback.js";
import {
  DEFAULT_LEASE_SECONDS,
  TaskClaimConflictError,
  claimTask,
  peekTasks,
  releaseTask,
  submitTask,
} from "../maintenance/tasks.js";

const db = initDb();
const activityEventTypes = [
  "compile",
  "query",
  "scan",
  "correction",
  "review",
  "feedback",
  "signal",
  "session_start",
  "session_event",
  "session_end",
  "tool_call",
] as const;

const server = new McpServer({
  name: "recall",
  version: "0.5.0",
});

const mcpClientContext = new AsyncLocalStorage<{ name?: string }>();

function mcpSource() {
  return tagActivitySource("mcp", mcpClientContext.getStore()?.name);
}

function resolveCurrentClientName(): string | undefined {
  return server.server.getClientVersion()?.name;
}

function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") {
      out[k] = v.length > 200 ? `${v.slice(0, 200)}…(len=${v.length})` : v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = { array_length: v.length };
    } else if (typeof v === "object") {
      out[k] = { object_keys: Object.keys(v as object).length };
    }
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tool(name: string, description: string, schema: any, handler: (args: any, extra: any) => any) {
  server.tool(name, description, schema, async (args: Record<string, unknown>, extra: unknown) => {
    const start = Date.now();
    let ok = true;
    let errorMessage: string | undefined;
    return mcpClientContext.run({ name: resolveCurrentClientName() }, async () => {
      try {
        return await handler(args, extra);
      } catch (err) {
        ok = false;
        errorMessage = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        try {
          createActivityEvent(db, {
            session_id: typeof args.session_id === "string" ? args.session_id : null,
            repo: typeof args.repo === "string" ? args.repo : null,
            path: typeof args.path === "string" ? args.path : null,
            source: mcpSource(),
            event_type: "tool_call",
            request: { tool: name, args: summarizeArgs(args) },
            result: {
              ok,
              duration_ms: Date.now() - start,
              ...(errorMessage ? { error: errorMessage } : {}),
            },
          });
        } catch {
          // telemetry must never break a tool call
        }
      }
    });
  });
}

// --- Tools ---

tool(
  "query",
  "Fallback retrieval for repo memory. Recall's lifecycle hooks already inject memory at SessionStart and on every UserPromptSubmit, so only call this tool when (a) injected context clearly missed something specific you need, (b) the user asks you to look up memory explicitly, or (c) you want memory for a different repo than the current one. Prefer query_text so results are ranked against your actual task.",
  {
    repo: z.string().describe("Repository name (e.g., owner/repo)"),
    repo_path: z.string().optional().describe("Optional local repo path hint for first-time bootstrap"),
    path: z.string().optional().describe("Current file path for path-scoped filtering"),
    query_text: z.string().optional().describe("Optional task/query text for hybrid reranking"),
    include_candidates: z.boolean().optional().describe("Allow strong candidate memories into hybrid ranking"),
    min_confidence: z.number().optional().describe("Minimum confidence threshold (default: 0.6)"),
    session_id: z.string().optional().describe("Optional session identifier"),
  },
  async ({ repo, repo_path, path, query_text, include_candidates, min_confidence, session_id }) => {
    const bootstrap = ensureRepoBootstrapped(db, {
      repo,
      repoPathHint: repo_path,
    });
    if (bootstrap.status === "bootstrapped" || bootstrap.status === "scanned_empty") {
      createActivityEvent(db, {
        session_id: session_id ?? null,
        repo,
        source: mcpSource(),
        event_type: "scan",
        memory_ids: bootstrap.created_ids,
        request: {
          repo_path: bootstrap.repo_path,
          trigger: "query_auto_bootstrap",
        },
        result: {
          created: bootstrap.created_ids.length,
          status: bootstrap.status,
        },
      });
    }

    const result = query_text || include_candidates
      ? await compileContextHybrid(db, {
          repo,
          path,
          session_id,
          query_text,
          config: {
            ...(min_confidence ? { confidence_threshold: min_confidence } : {}),
            include_candidates: include_candidates ?? false,
          },
        })
      : compileContext(db, {
          repo,
          path,
          session_id,
          config: min_confidence ? { confidence_threshold: min_confidence } : {},
        });
    createActivityEvent(db, {
      session_id: session_id ?? null,
      repo,
      path: path ?? null,
      source: mcpSource(),
      event_type: "query",
      memory_ids: result.memories_included,
      request: {
        min_confidence: min_confidence ?? null,
        query_text: query_text ?? null,
        include_candidates: include_candidates ?? false,
        bootstrap_status: bootstrap.status,
      },
      result: {
        included: result.memories_included,
        dropped: result.memories_dropped,
        history_included: result.history_included,
        token_estimate: result.token_estimate,
        repo_path: bootstrap.repo_path,
      },
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

tool(
  "list",
  "List all memories for a repository, optionally filtered by status.",
  {
    repo: z.string().describe("Repository name"),
    status: z
      .enum(["transient", "candidate", "active", "rejected"])
      .optional()
      .describe("Filter by memory status"),
    limit: z.number().optional().describe("Max memories to return"),
    offset: z.number().optional().describe("Skip first N memories"),
  },
  async ({ repo, status, limit, offset }) => {
    const items = queryMemories(db, { repo, status, limit, offset });
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

tool(
  "report_correction",
  "Report a correction or rule to be learned. Accepts optional assistant/tool context and creates candidate memories from the correction text.",
  {
    text: z.string().describe("The correction or rule (e.g., 'don't use pip, use uv')"),
    repo: z.string().optional().describe("Repository name"),
    path: z.string().optional().describe("File path context"),
    session_id: z.string().optional().describe("Session identifier"),
    agent: z.string().optional().describe("Source agent name, such as codex or claude-code."),
    prev_assistant_turn: z.string().optional().describe("The assistant message that triggered the correction."),
    recent_tool_calls: z.array(
      z.object({
        name: z.string(),
        path: z.string().optional(),
        input_summary: z.string().optional(),
        exit_code: z.number().optional(),
      }),
    ).optional().describe("Last 1-3 tool calls leading up to the correction."),
  },
  async ({ text, repo, path, session_id, agent, prev_assistant_turn, recent_tool_calls }) => {
    const result = await captureCorrectionFallback(db, {
      text,
      repo,
      path,
      session_id,
      agent: agent ?? "mcp",
      prev_assistant_turn,
      recent_tool_calls,
    }, mcpSource());

    if (result.ids.length === 0) {
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
          text: `Created ${result.ids.length} candidate memory/memories: ${result.ids.map((id) => id.slice(0, 8)).join(", ")}`,
        },
      ],
    };
  },
);

tool(
  "capture_correction",
  "Call this right after the user corrects the assistant or states a repo rule. Captures the correction with richer context so scope inference stays accurate.",
  {
    text: z.string().describe("The user correction or rule text to capture."),
    repo: z.string().optional().describe("Repository name when known."),
    path: z.string().optional().describe("Current file path context, if the correction is file-specific."),
    session_id: z.string().optional().describe("Current session identifier."),
    agent: z.string().optional().describe("Source agent name, such as codex or claude-code."),
    prev_assistant_turn: z.string().optional().describe("The assistant message that triggered the correction."),
    recent_tool_calls: z.array(
      z.object({
        name: z.string(),
        path: z.string().optional(),
        input_summary: z.string().optional(),
        exit_code: z.number().optional(),
      }),
    ).optional().describe("Last 1-3 tool calls leading up to the correction."),
  },
  async ({ text, repo, path, session_id, agent, prev_assistant_turn, recent_tool_calls }) => {
    const result = await captureCorrectionFallback(db, {
      text,
      repo,
      path,
      session_id,
      agent,
      prev_assistant_turn,
      recent_tool_calls,
    }, mcpSource());

    if (result.ids.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No correction pattern detected. Use this when the user is explicitly correcting prior behavior or stating a durable repo rule.",
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Captured correction context for ${result.ids.length} memory/memories: ${result.ids.map((id) => id.slice(0, 8)).join(", ")}`,
        },
      ],
    };
  },
);

tool(
  "report_review",
  "Report review feedback from a code review. Creates candidate memories from review comments.",
  {
    feedback: z.string().describe("The review feedback"),
    repo: z.string().optional().describe("Repository name"),
    path: z.string().optional().describe("File path context"),
    reviewer: z.string().optional().describe("Reviewer name"),
    session_id: z.string().optional().describe("Optional session identifier"),
  },
  async ({ feedback, repo, path, reviewer, session_id }) => {
    const ids = await processReviewFeedback(db, feedback, {
      sessionId: session_id ?? "mcp-review",
      repo,
      path,
      reviewer,
    });
    createActivityEvent(db, {
      session_id: session_id ?? "mcp-review",
      repo: repo ?? null,
      path: path ?? null,
      source: mcpSource(),
      event_type: "review",
      memory_ids: ids,
      request: { feedback, reviewer: reviewer ?? null },
      result: { created: ids },
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

tool(
  "confirm",
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

tool(
  "reject",
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

tool(
  "demote_global",
  "Demote a global-scoped memory. Pass `repo` to re-scope it to a single repo (the rule was real but over-scoped). Omit `repo` to reject it (the rule was junk for everywhere).",
  {
    memory_id: z.string().describe("Memory ID to demote"),
    repo: z.string().optional().describe("Re-scope to this repo. If omitted, the memory is rejected instead."),
    reason: z.string().optional().describe("Why this is being demoted (recorded in the audit trail)."),
  },
  async ({ memory_id, repo, reason }) => {
    const result = demoteGlobalMemory(db, memory_id, { repo: repo ?? null });
    if (!result.ok) {
      const msg = result.reason === "not_found"
        ? `Memory ${memory_id} not found.`
        : `Memory ${memory_id.slice(0, 8)} is not global-scoped; nothing to demote.`;
      return { content: [{ type: "text" as const, text: msg }] };
    }
    const auditReason = reason
      ?? (result.outcome === "rescoped" ? `demoted from global to repo ${repo}` : "demoted from global; rejected");
    recordAudit(db, memory_id, result.outcome === "rejected" ? "rejected" : "demoted", "mcp", auditReason);
    const text = result.outcome === "rescoped"
      ? `Memory ${memory_id.slice(0, 8)} re-scoped to repo ${repo}.`
      : `Memory ${memory_id.slice(0, 8)} rejected (was global, no repo target).`;
    return { content: [{ type: "text" as const, text }] };
  },
);

tool(
  "feedback",
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
    const result = signalOutcomeFallback(db, {
      memory_id,
      session_id,
      injected,
      outcome,
    }, mcpSource());
    return {
      content: [
        { type: "text" as const, text: `Feedback recorded: ${result.feedback_id.slice(0, 8)}` },
      ],
    };
  },
);

tool(
  "signal_outcome",
  "Call this after acting on an injected memory to report whether it was followed, overridden, ignored, or contradicted in the current session.",
  {
    memory_id: z.string().describe("The injected memory being evaluated."),
    session_id: z.string().describe("Current session ID."),
    injected: z.boolean().optional().describe("Whether the memory was actually injected; defaults to true."),
    outcome: z
      .enum(["followed", "overridden", "ignored", "contradicted"])
      .describe("What happened after the memory was shown to the model."),
    context: z.string().optional().describe("Short note explaining the outcome."),
  },
  async ({ memory_id, session_id, injected, outcome, context }) => {
    const result = signalOutcomeFallback(db, {
      memory_id,
      session_id,
      injected,
      outcome,
      context,
    }, mcpSource());
    return {
      content: [
        { type: "text" as const, text: `Outcome recorded: ${result.feedback_id.slice(0, 8)}` },
      ],
    };
  },
);

tool(
  "scan",
  "Scan a repository and bootstrap memories from config files, scripts, and instruction files.",
  {
    repo_path: z.string().describe("Absolute path to the repository root"),
    session_id: z.string().optional().describe("Optional session identifier"),
  },
  async ({ repo_path, session_id }) => {
    const ids = scanAndStore(db, repo_path);
    const mem = ids[0] ? getMemory(db, ids[0]) : undefined;
    createActivityEvent(db, {
      session_id: session_id ?? null,
      repo: mem?.repo ?? null,
      source: mcpSource(),
      event_type: "scan",
      memory_ids: ids,
      request: { repo_path },
      result: { created: ids },
    });
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

tool(
  "eval",
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

tool(
  "eval_retrieval",
  "Run retrieval eval fixtures against baseline vs hybrid retrieval.",
  {
    cases_json: z.string().describe("JSON string matching { cases: [...] } retrieval fixture format"),
  },
  async ({ cases_json }) => {
    const parsed = JSON.parse(cases_json);
    const report = await runRetrievalEval(db, parsed);
    return {
      content: [{ type: "text" as const, text: formatRetrievalEvalReport(report) }],
    };
  },
);

tool(
  "signal",
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
    const mem = getMemory(db, memory_id);
    createActivityEvent(db, {
      session_id,
      repo: mem?.repo ?? null,
      path: mem?.path_scope ?? null,
      source: mcpSource(),
      event_type: "signal",
      memory_ids: [memory_id],
      request: { signal_type, context: context ?? null },
      result: { signal_id: id },
    });
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

tool(
  "session_end",
  "Call this when the session is ending or being cleared so Recall can record the end-of-session boundary and run follow-up session logic.",
  {
    session_id: z.string().describe("Current session ID."),
    repo: z.string().optional().describe("Repository slug if already known."),
    repo_path: z.string().optional().describe("Repository path when available."),
    path: z.string().optional().describe("Current file path context."),
    agent: z.string().optional().describe("Source agent name."),
    turn_count: z.number().optional().describe("Completed turn count, if known."),
  },
  async ({ session_id, repo, repo_path, path, agent, turn_count }) => {
    const result = sessionEndFallback(db, {
      session_id,
      repo,
      repo_path,
      path,
      agent,
      turn_count,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `Session end recorded for ${result.session_id}${result.repo ? ` (${result.repo})` : ""}.`,
        },
      ],
    };
  },
);

tool(
  "scope",
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

tool(
  "health",
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

tool(
  "contradictions",
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

tool(
  "prune",
  "Auto-prune stale, rejected, transient, and unhealthy memories.",
  {
    repo: z.string().optional().describe("Limit pruning to one repo"),
    dry_run: z.boolean().optional().describe("Preview without making changes (default: false)"),
    stale_days: z.number().optional().describe("Days before rejecting stale memories (default: 90)"),
    min_health_score: z.number().optional().describe("Min health score for active (default: 0.2)"),
  },
  async ({ repo, dry_run, stale_days, min_health_score }) => {
    const result = pruneMemories(db, { repo, dry_run: dry_run ?? false, stale_days, min_health_score });
    return {
      content: [{ type: "text" as const, text: formatPruneReport(result, dry_run ?? false) }],
    };
  },
);

tool(
  "audit",
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

tool(
  "rollback",
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

tool(
  "policy_check",
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

tool(
  "approval_list",
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

tool(
  "approval_resolve",
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

tool(
  "activity",
  "List recent activity events such as queries, compiles, scans, corrections, feedback, and signals.",
  {
    repo: z.string().optional().describe("Filter by repo"),
    session_id: z.string().optional().describe("Filter by session id"),
    source: z.string().optional().describe("Filter by source (e.g., 'mcp', 'hook:claude-code', 'cli')"),
    event_type: z.enum(activityEventTypes).optional().describe("Filter by event type"),
    since: z.string().optional().describe("Created at >= ISO timestamp"),
    limit: z.number().optional().describe("Max events to return"),
  },
  async ({ repo, session_id, source, event_type, since, limit }) => {
    const events = listActivityEvents(db, { repo, session_id, source, event_type, since, limit });
    if (events.length === 0) {
      return { content: [{ type: "text" as const, text: "No activity found." }] };
    }
    const lines = events.map(
      (event) =>
        `${event.created_at} ${event.source}/${event.event_type} session:${event.session_id ?? "-"} repo:${event.repo ?? "-"} memories:${event.memory_ids.length}`,
    );
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

tool(
  "sessions",
  "List grouped activity sessions so you can review what happened in prior runs.",
  {
    repo: z.string().optional().describe("Filter by repo"),
    source: z.string().optional().describe("Filter by source (e.g., 'mcp', 'hook:claude-code', 'cli')"),
    event_type: z.enum(activityEventTypes).optional().describe("Filter by event type"),
    since: z.string().optional().describe("Created at >= ISO timestamp"),
    limit: z.number().optional().describe("Max sessions to return"),
  },
  async ({ repo, source, event_type, since, limit }) => {
    const sessions = listActivitySessions(db, { repo, source, event_type, since, limit });
    if (sessions.length === 0) {
      return { content: [{ type: "text" as const, text: "No sessions found." }] };
    }
    const lines = sessions.map(
      (session) =>
        `${session.last_at} ${session.session_id} repo:${session.repo ?? "-"} events:${session.event_count} types:${session.event_types.join(",")}`,
    );
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

tool(
  "quality",
  "Get the repo quality profile — maturity stage, dynamic thresholds, and quality score. Use this to understand how strict memory gating is for a repo.",
  {
    repo: z.string().optional().describe("Repository name"),
  },
  async ({ repo }) => {
    const profile = getRepoQualityProfile(db, repo);
    const lines = [
      `Stage: ${profile.stage} | Score: ${(profile.score * 100).toFixed(0)}%`,
      `Active: ${profile.active_count} | Total: ${profile.total_count}`,
      `Avg health: ${(profile.avg_health * 100).toFixed(0)}% | Override rate: ${(profile.override_rate * 100).toFixed(0)}%`,
      `Repeat sessions needed: ${profile.repeat_sessions_required}`,
      `Compile threshold: ${profile.compile_confidence_threshold.toFixed(2)}`,
      `Dedup similarity: ${profile.dedup_similarity_threshold.toFixed(2)}`,
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

// --- Delegated maintenance (Tier-2) ---

const maintenanceTaskKinds = [
  "summarize_history",
  "merge_duplicates",
  "refine_candidate",
  "summarize_session",
  "synthesize_repo",
  "verify_capture",
] as const;

tool(
  "maintenance_peek",
  "Call at session start or between turns to see pending memory maintenance work that you could pick up. Returns small tasks the agent can complete in one turn. Do not call during an active user turn.",
  {
    repo: z.string().optional().describe("Optional repo to filter by (owner/repo)."),
    kinds: z.array(z.enum(maintenanceTaskKinds)).optional().describe("Restrict to specific task kinds."),
    limit: z.number().int().positive().max(10).optional().describe("Max tasks to return; defaults to 3."),
  },
  async ({ repo, kinds, limit }) => {
    const tasks = peekTasks(db, { repo, kinds, limit });
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ tasks }, null, 2) },
      ],
    };
  },
);

tool(
  "maintenance_claim",
  "Claim a pending maintenance task so you can work on it. Only call when the user is idle — never during an active user turn. Returns the full payload and a lease; submit or release before the lease expires.",
  {
    task_id: z.string().describe("ID of a task returned by maintenance_peek."),
    agent: z.string().describe("Caller agent name (e.g., claude-code, codex)."),
    lease_seconds: z.number().int().positive().max(3600).optional().describe(`Lease duration; default ${DEFAULT_LEASE_SECONDS}s.`),
  },
  async ({ task_id, agent, lease_seconds }) => {
    try {
      const result = claimTask(db, task_id, agent, lease_seconds);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              task: {
                id: result.task.id,
                kind: result.task.kind,
                repo: result.task.repo,
                payload: result.task.payload,
                priority: result.task.priority,
              },
              lease_expires_at: result.lease_expires_at,
            }, null, 2),
          },
        ],
      };
    } catch (err) {
      if (err instanceof TaskClaimConflictError) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: err.reason, task_id }) },
          ],
          isError: true,
        };
      }
      throw err;
    }
  },
);

tool(
  "maintenance_submit",
  "Submit the result of a claimed maintenance task. Recall validates the shape per task kind and applies the effect. Rejection bumps the task's attempt counter; after max_attempts the task is abandoned.",
  {
    task_id: z.string().describe("Claimed task ID."),
    agent: z.string().describe("Caller agent name; must match the claim holder."),
    result: z.record(z.string(), z.unknown()).describe("Result payload. Shape depends on task kind; see payload for expectations."),
  },
  async ({ task_id, agent, result }) => {
    const outcome = submitTask(db, task_id, agent, result);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(outcome, null, 2) },
      ],
      isError: outcome.status === "rejected",
    };
  },
);

tool(
  "maintenance_release",
  "Release a previously-claimed maintenance task without submitting a result (e.g., user interrupted you, context compacted, agent can't handle this kind). Returns the task to pending so another run can pick it up.",
  {
    task_id: z.string().describe("Claimed task ID."),
    agent: z.string().describe("Caller agent name; must match the claim holder."),
    reason: z.string().max(500).optional().describe("Short note about why you released."),
  },
  async ({ task_id, agent, reason }) => {
    const outcome = releaseTask(db, task_id, agent, reason);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(outcome) },
      ],
      isError: outcome.status !== "released",
    };
  },
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);

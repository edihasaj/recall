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

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);

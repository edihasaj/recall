import { Command } from "commander";
import { resolve } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { initDb, getDbPath } from "./db/client.js";
import {
  listMemories,
  getMemory,
  confirmMemory,
  rejectMemory,
  queryMemories,
  recordFeedback,
} from "./models/memory.js";
import { scanAndStore } from "./scanner/repo.js";
import { compileContext } from "./compiler/context.js";
import { processCorrection, processReviewFeedback } from "./capture/correction.js";
import { exportClaude, exportCodex, exportMarkdown } from "./adapters/markdown.js";
import { sync, createTeam, joinTeam } from "./sync/client.js";
import { computeMetrics, formatMetricsReport, startEvalSession, endEvalSession } from "./eval/harness.js";
import { embedAllMemories, semanticSearch } from "./embeddings/embeddings.js";
import { recordSignal, getSignalStats } from "./feedback/implicit.js";
import { inferScope, analyzeScopePatterns } from "./capture/scope.js";
import { createPolicy, listPolicies, togglePolicy, deletePolicy, evaluatePolicy, requestApproval, resolveApproval, listPendingApprovals } from "./policy/engine.js";
import { computeHealthScore, computeAllHealthScores, formatHealthReport } from "./health/scoring.js";
import { detectContradictions, resolveContradiction, autoResolveContradictions, listContradictions } from "./contradictions/detector.js";
import { pruneMemories, formatPruneReport } from "./pruning/pruner.js";
import { getAuditTrail, getRecentAudit, formatAuditTrail, rollbackMemory } from "./audit/trail.js";
import { getRepoQualityProfile } from "./repo/quality.js";
import type { SyncConfig, EmbeddingConfig } from "./types.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const program = new Command();

program
  .name("recall")
  .description("Cross-tool coding memory and instruction compiler")
  .version(pkg.version);

// --- init ---

program
  .command("init")
  .description("Initialize Recall database")
  .action(() => {
    initDb();
    console.log("Recall initialized. Database ready.");
  });

// --- scan ---

program
  .command("scan")
  .description("Scan a repository and bootstrap memories")
  .argument("[path]", "Repository path", ".")
  .action((path: string) => {
    const db = initDb();
    const repoPath = resolve(path);
    const ids = scanAndStore(db, repoPath);
    console.log(`Scanned ${repoPath}`);
    console.log(`Created ${ids.length} candidate memories.`);

    if (ids.length > 0) {
      console.log("\nMemories:");
      for (const id of ids) {
        const mem = getMemory(db, id);
        if (mem) {
          console.log(
            `  [${mem.status}] (${mem.confidence.toFixed(2)}) ${mem.type}: ${mem.text}`,
          );
        }
      }
      console.log(
        "\nUse `recall confirm <id>` to promote candidates, or `recall reject <id>` to discard.",
      );
    }
  });

// --- list ---

program
  .command("list")
  .description("List memories")
  .option("-r, --repo <repo>", "Filter by repository")
  .option(
    "-s, --status <status>",
    "Filter by status (transient|candidate|active|rejected)",
  )
  .option("-t, --type <type>", "Filter by type")
  .action((opts) => {
    const db = initDb();
    const items = queryMemories(db, {
      repo: opts.repo,
      status: opts.status,
      type: opts.type,
    });

    if (items.length === 0) {
      console.log("No memories found.");
      return;
    }

    for (const m of items) {
      const prefix = m.id.slice(0, 8);
      console.log(
        `${prefix}  [${m.status.padEnd(9)}] (${m.confidence.toFixed(2)}) ${m.type.padEnd(14)} ${m.text}`,
      );
    }
    console.log(`\n${items.length} memories total.`);
  });

// --- show ---

program
  .command("show")
  .description("Show memory details")
  .argument("<id>", "Memory ID (full or prefix)")
  .action((idPrefix: string) => {
    const db = initDb();
    const mem = findByPrefix(db, idPrefix);
    if (!mem) {
      console.error(`Memory not found: ${idPrefix}`);
      process.exit(1);
    }
    console.log(JSON.stringify(mem, null, 2));
  });

// --- confirm ---

program
  .command("confirm")
  .description("Confirm a memory (promote to active)")
  .argument("<id>", "Memory ID (full or prefix)")
  .action((idPrefix: string) => {
    const db = initDb();
    const mem = findByPrefix(db, idPrefix);
    if (!mem) {
      console.error(`Memory not found: ${idPrefix}`);
      process.exit(1);
    }
    const ok = confirmMemory(db, mem.id);
    if (ok) {
      console.log(`Confirmed: ${mem.id.slice(0, 8)} → active`);
    } else {
      console.error("Could not confirm (may be rejected).");
    }
  });

// --- reject ---

program
  .command("reject")
  .description("Reject a memory (never inject again)")
  .argument("<id>", "Memory ID (full or prefix)")
  .action((idPrefix: string) => {
    const db = initDb();
    const mem = findByPrefix(db, idPrefix);
    if (!mem) {
      console.error(`Memory not found: ${idPrefix}`);
      process.exit(1);
    }
    rejectMemory(db, mem.id);
    console.log(`Rejected: ${mem.id.slice(0, 8)}`);
  });

// --- compile ---

program
  .command("compile")
  .description("Compile active memories into injection pack")
  .requiredOption("-r, --repo <repo>", "Repository name")
  .option("-p, --path <path>", "File path for scoping")
  .option("--threshold <n>", "Confidence threshold (default: dynamic from quality profile)")
  .action((opts) => {
    const db = initDb();
    const result = compileContext(db, {
      repo: opts.repo,
      path: opts.path,
      config: opts.threshold ? { confidence_threshold: parseFloat(opts.threshold) } : {},
    });

    if (!result.text) {
      console.log("No memories above threshold. Nothing to inject.");
      return;
    }

    console.log(result.text);
    console.log(`---`);
    console.log(
      `${result.memories_included.length} included, ${result.memories_dropped.length} dropped, ~${result.token_estimate} tokens`,
    );
  });

// --- correct ---

program
  .command("correct")
  .description("Report a correction to learn from")
  .argument("<text>", "Correction text")
  .option("-r, --repo <repo>", "Repository name")
  .option("-p, --path <path>", "File path context")
  .action((text: string, opts) => {
    const db = initDb();
    const ids = processCorrection(db, text, {
      sessionId: "cli",
      repo: opts.repo,
      path: opts.path,
    });

    if (ids.length === 0) {
      console.log("No correction pattern detected.");
      console.log(
        'Try: "don\'t use X, use Y" or "always do Z" or "review said to use W"',
      );
      return;
    }

    console.log(`Created ${ids.length} candidate(s):`);
    for (const id of ids) {
      const mem = getMemory(db, id);
      if (mem)
        console.log(`  ${id.slice(0, 8)}: ${mem.text}`);
    }
  });

// --- review ---

program
  .command("review")
  .description("Report review feedback")
  .argument("<feedback>", "Review feedback text")
  .option("-r, --repo <repo>", "Repository name")
  .option("-p, --path <path>", "File path context")
  .option("--reviewer <name>", "Reviewer name")
  .action((feedback: string, opts) => {
    const db = initDb();
    const ids = processReviewFeedback(db, feedback, {
      sessionId: "cli-review",
      repo: opts.repo,
      path: opts.path,
      reviewer: opts.reviewer,
    });

    console.log(`Created ${ids.length} candidate(s) from review feedback.`);
    for (const id of ids) {
      const mem = getMemory(db, id);
      if (mem) console.log(`  ${id.slice(0, 8)}: ${mem.text}`);
    }
  });

// --- export ---

program
  .command("export")
  .description("Export memories as markdown instruction files")
  .requiredOption("-r, --repo <repo>", "Repository name")
  .option(
    "-f, --format <format>",
    "Export format: claude | codex | markdown",
    "markdown",
  )
  .option("-o, --output <path>", "Output file path")
  .action((opts) => {
    const db = initDb();
    let content: string;

    switch (opts.format) {
      case "claude":
        content = exportClaude(db, opts.repo);
        break;
      case "codex":
        content = exportCodex(db, opts.repo);
        break;
      default:
        content = exportMarkdown(db, opts.repo);
    }

    if (opts.output) {
      writeFileSync(opts.output, content);
      console.log(`Exported to ${opts.output}`);
    } else {
      console.log(content);
    }
  });

// --- serve (MCP) ---

program
  .command("serve")
  .description("Start the MCP server (stdio transport)")
  .action(async () => {
    // Dynamic import to avoid loading MCP deps for other commands
    await import("./mcp/server.js");
  });

// --- Phase 2: sync ---

const syncCmd = program
  .command("sync")
  .description("Sync memories with remote server");

syncCmd
  .command("push")
  .description("Push local memories to remote")
  .action(async () => {
    const db = initDb();
    const config = loadSyncConfig();
    if (!config) {
      console.error("No sync config. Set RECALL_SYNC_URL and RECALL_SYNC_KEY.");
      process.exit(1);
    }
    const result = await sync(db, config);
    console.log(`Pushed: ${result.pushed}, Pulled: ${result.pulled}, Conflicts: ${result.conflicts}`);
    if (result.errors.length > 0) {
      console.error("Errors:", result.errors.join("; "));
    }
  });

syncCmd
  .command("pull")
  .description("Pull team memories from remote")
  .action(async () => {
    const db = initDb();
    const config = loadSyncConfig();
    if (!config) {
      console.error("No sync config. Set RECALL_SYNC_URL and RECALL_SYNC_KEY.");
      process.exit(1);
    }
    const result = await sync(db, config);
    console.log(`Pulled: ${result.pulled}, Conflicts: ${result.conflicts}`);
  });

// --- Phase 2: team ---

const teamCmd = program
  .command("team")
  .description("Manage teams");

teamCmd
  .command("create")
  .description("Create a new team")
  .argument("<name>", "Team name")
  .action(async (name: string) => {
    const config = loadSyncConfig();
    if (!config) {
      console.error("No sync config.");
      process.exit(1);
    }
    const teamId = await createTeam(config, name);
    console.log(`Team created: ${teamId}`);
    console.log(`Set RECALL_TEAM_ID=${teamId} to use this team.`);
  });

teamCmd
  .command("join")
  .description("Join an existing team")
  .argument("<team-id>", "Team ID")
  .action(async (teamId: string) => {
    const config = loadSyncConfig();
    if (!config) {
      console.error("No sync config.");
      process.exit(1);
    }
    await joinTeam(config, teamId);
    console.log(`Joined team: ${teamId}`);
  });

// --- Phase 2: eval ---

const evalCmd = program
  .command("eval")
  .description("Evaluation metrics");

evalCmd
  .command("report")
  .description("Show evaluation metrics report")
  .option("-r, --repo <repo>", "Filter by repo")
  .option("--since <date>", "Since date (ISO)")
  .action((opts) => {
    const db = initDb();
    const metrics = computeMetrics(db, { repo: opts.repo, since: opts.since });
    console.log(formatMetricsReport(metrics));
  });

evalCmd
  .command("start")
  .description("Start an eval session")
  .requiredOption("-r, --repo <repo>", "Repository name")
  .action((opts) => {
    const db = initDb();
    const id = startEvalSession(db, opts.repo);
    console.log(`Eval session started: ${id}`);
  });

evalCmd
  .command("end")
  .description("End an eval session")
  .argument("<session-id>", "Session ID")
  .action((sessionId: string) => {
    const db = initDb();
    endEvalSession(db, sessionId);
    console.log(`Eval session ended: ${sessionId}`);
  });

// --- Phase 2: embed ---

program
  .command("embed")
  .description("Generate embeddings for all un-embedded memories")
  .action(async () => {
    const db = initDb();
    const config = loadEmbeddingConfig();
    if (!config?.enabled) {
      console.error("Embeddings not enabled. Set RECALL_EMBEDDINGS_ENABLED=true and OPENAI_API_KEY.");
      process.exit(1);
    }
    const count = await embedAllMemories(db, config);
    console.log(`Embedded ${count} memories.`);
  });

program
  .command("search")
  .description("Semantic search across memories")
  .argument("<query>", "Search query")
  .option("-r, --repo <repo>", "Filter by repo")
  .option("-n, --limit <n>", "Max results", "10")
  .action(async (query: string, opts) => {
    const db = initDb();
    const config = loadEmbeddingConfig();
    if (!config?.enabled) {
      console.error("Embeddings not enabled.");
      process.exit(1);
    }
    const results = await semanticSearch(db, query, config, {
      repo: opts.repo,
      limit: parseInt(opts.limit),
    });

    if (results.length === 0) {
      console.log("No matching memories found.");
      return;
    }

    for (const r of results) {
      console.log(
        `${r.memory.id.slice(0, 8)}  (${r.similarity.toFixed(3)}) [${r.memory.status}] ${r.memory.text}`,
      );
    }
  });

// --- Phase 2: signals ---

program
  .command("signal")
  .description("Record an implicit feedback signal")
  .argument("<memory-id>", "Memory ID")
  .argument("<signal>", "Signal type: test_pass|test_fail|file_unchanged|file_rewritten|task_accepted|task_rejected")
  .option("-s, --session <id>", "Session ID", "cli")
  .action((memoryIdPrefix: string, signal: string, opts) => {
    const db = initDb();
    const mem = findByPrefix(db, memoryIdPrefix);
    if (!mem) {
      console.error(`Memory not found: ${memoryIdPrefix}`);
      process.exit(1);
    }
    const validSignals = ["test_pass", "test_fail", "file_unchanged", "file_rewritten", "task_accepted", "task_rejected"];
    if (!validSignals.includes(signal)) {
      console.error(`Invalid signal. Use: ${validSignals.join(", ")}`);
      process.exit(1);
    }
    const id = recordSignal(db, mem.id, opts.session, signal as any);
    console.log(`Signal recorded: ${id.slice(0, 8)}`);

    const stats = getSignalStats(db, mem.id);
    console.log("Stats:", JSON.stringify(stats));
  });

// --- Phase 2: scope analysis ---

program
  .command("scope")
  .description("Analyze scope of a correction text")
  .argument("<text>", "Correction text")
  .option("-p, --path <path>", "Context file path")
  .action((text: string, opts) => {
    const result = inferScope(text, opts.path);
    console.log(`Scope:       ${result.scope}`);
    console.log(`Path scope:  ${result.path_scope ?? "(none)"}`);
    console.log(`Confidence:  ${result.confidence_modifier > 0 ? "+" : ""}${result.confidence_modifier}`);
    console.log(`Reason:      ${result.reason}`);
  });

// --- Phase 3: policy ---

const policyCmd = program
  .command("policy")
  .description("Org-level policy management");

policyCmd
  .command("create")
  .description("Create a policy rule")
  .requiredOption("--org <id>", "Organization ID")
  .requiredOption("--type <type>", "Rule type: min_confidence|require_approval|allowed_sources|blocked_scopes|max_active_per_repo|require_evidence_count|auto_approve_pattern")
  .requiredOption("--config <json>", "Rule config as JSON")
  .action((opts) => {
    const db = initDb();
    const config = JSON.parse(opts.config);
    const id = createPolicy(db, opts.org, opts.type, config);
    console.log(`Policy created: ${id.slice(0, 8)}`);
  });

policyCmd
  .command("list")
  .description("List policies for an org")
  .requiredOption("--org <id>", "Organization ID")
  .action((opts) => {
    const db = initDb();
    const rules = listPolicies(db, opts.org);
    if (rules.length === 0) {
      console.log("No policies.");
      return;
    }
    for (const r of rules) {
      console.log(`${r.id.slice(0, 8)}  [${r.enabled ? "on" : "off"}] ${r.rule_type}  ${JSON.stringify(r.config)}`);
    }
  });

policyCmd
  .command("toggle")
  .description("Enable/disable a policy")
  .argument("<id>", "Policy ID")
  .argument("<state>", "on or off")
  .action((id: string, state: string) => {
    const db = initDb();
    togglePolicy(db, id, state === "on");
    console.log(`Policy ${id.slice(0, 8)} ${state === "on" ? "enabled" : "disabled"}.`);
  });

policyCmd
  .command("delete")
  .description("Delete a policy")
  .argument("<id>", "Policy ID")
  .action((id: string) => {
    const db = initDb();
    deletePolicy(db, id);
    console.log(`Policy ${id.slice(0, 8)} deleted.`);
  });

policyCmd
  .command("check")
  .description("Check a memory against org policies")
  .requiredOption("--org <id>", "Organization ID")
  .argument("<memory-id>", "Memory ID")
  .action((memoryId: string, opts) => {
    const db = initDb();
    const mem = findByPrefix(db, memoryId);
    if (!mem) {
      console.error(`Memory not found: ${memoryId}`);
      process.exit(1);
    }
    const violations = evaluatePolicy(db, opts.org, mem);
    if (violations.length === 0) {
      console.log("No policy violations.");
    } else {
      for (const v of violations) {
        console.log(`[${v.blocking ? "BLOCK" : "WARN"}] ${v.rule_type}: ${v.message}`);
      }
    }
  });

// --- Phase 3: approval ---

const approvalCmd = program
  .command("approval")
  .description("Approval queue management");

approvalCmd
  .command("request")
  .description("Request approval for a memory")
  .argument("<memory-id>", "Memory ID")
  .requiredOption("--org <id>", "Organization ID")
  .option("--by <name>", "Requested by", "cli")
  .action((memoryId: string, opts) => {
    const db = initDb();
    const mem = findByPrefix(db, memoryId);
    if (!mem) {
      console.error(`Memory not found: ${memoryId}`);
      process.exit(1);
    }
    const id = requestApproval(db, mem.id, opts.org, opts.by);
    console.log(`Approval requested: ${id.slice(0, 8)}`);
  });

approvalCmd
  .command("list")
  .description("List pending approvals")
  .requiredOption("--org <id>", "Organization ID")
  .action((opts) => {
    const db = initDb();
    const pending = listPendingApprovals(db, opts.org);
    if (pending.length === 0) {
      console.log("No pending approvals.");
      return;
    }
    for (const a of pending) {
      console.log(`${a.id.slice(0, 8)}  memory:${a.memory_id.slice(0, 8)}  by:${a.requested_by}  ${a.created_at}`);
    }
  });

approvalCmd
  .command("resolve")
  .description("Approve or deny a request")
  .argument("<approval-id>", "Approval ID")
  .argument("<decision>", "approved or denied")
  .option("--by <name>", "Reviewed by", "cli")
  .option("--reason <reason>", "Reason")
  .action((approvalId: string, decision: string, opts) => {
    const db = initDb();
    const ok = resolveApproval(db, approvalId, decision as any, opts.by, opts.reason);
    if (ok) {
      console.log(`Approval ${approvalId.slice(0, 8)} → ${decision}`);
    } else {
      console.error("Approval not found.");
    }
  });

// --- Phase 3: health ---

program
  .command("health")
  .description("Memory health scoring report")
  .option("-r, --repo <repo>", "Filter by repo")
  .option("--id <id>", "Score a single memory")
  .action((opts) => {
    const db = initDb();
    if (opts.id) {
      const mem = findByPrefix(db, opts.id);
      if (!mem) {
        console.error(`Memory not found: ${opts.id}`);
        process.exit(1);
      }
      const score = computeHealthScore(db, mem.id);
      if (score) {
        console.log(`Score:      ${(score.score * 100).toFixed(0)}%`);
        console.log(`Confidence: ${(score.confidence_component * 100).toFixed(0)}%`);
        console.log(`Freshness:  ${(score.freshness_component * 100).toFixed(0)}%`);
        console.log(`Follow:     ${(score.follow_rate_component * 100).toFixed(0)}%`);
        console.log(`Signal:     ${(score.signal_ratio_component * 100).toFixed(0)}%`);
      }
      return;
    }
    const scores = computeAllHealthScores(db, opts.repo);
    console.log(formatHealthReport(scores));
  });

// --- Phase 3: contradictions ---

const contradictCmd = program
  .command("contradictions")
  .description("Detect and resolve contradictions");

contradictCmd
  .command("detect")
  .description("Scan for contradictions")
  .option("-r, --repo <repo>", "Filter by repo")
  .action((opts) => {
    const db = initDb();
    const found = detectContradictions(db, opts.repo);
    if (found.length === 0) {
      console.log("No new contradictions detected.");
      return;
    }
    for (const c of found) {
      console.log(`${c.id.slice(0, 8)}  [${c.severity}] ${c.contradiction_type}: ${c.description}`);
    }
    console.log(`\n${found.length} contradiction(s) found.`);
  });

contradictCmd
  .command("list")
  .description("List contradictions")
  .option("--resolved", "Show resolved only")
  .option("--unresolved", "Show unresolved only")
  .action((opts) => {
    const db = initDb();
    const resolved = opts.resolved ? true : opts.unresolved ? false : undefined;
    const items = listContradictions(db, { resolved });
    if (items.length === 0) {
      console.log("No contradictions.");
      return;
    }
    for (const c of items) {
      const status = c.resolved ? "resolved" : "open";
      console.log(`${c.id.slice(0, 8)}  [${status}] ${c.severity} ${c.contradiction_type}: ${c.description}`);
    }
  });

contradictCmd
  .command("resolve")
  .description("Resolve a contradiction by keeping one memory")
  .argument("<contradiction-id>", "Contradiction ID")
  .argument("<keep-memory-id>", "Memory ID to keep")
  .option("--actor <name>", "Who resolved", "cli")
  .option("--reason <reason>", "Resolution reason")
  .action((cId: string, keepId: string, opts) => {
    const db = initDb();
    const ok = resolveContradiction(db, cId, keepId, opts.actor, opts.reason);
    if (ok) {
      console.log(`Contradiction ${cId.slice(0, 8)} resolved. Kept ${keepId.slice(0, 8)}.`);
    } else {
      console.error("Contradiction not found.");
    }
  });

contradictCmd
  .command("auto-resolve")
  .description("Auto-resolve contradictions (higher confidence wins)")
  .option("-r, --repo <repo>", "Filter by repo")
  .action((opts) => {
    const db = initDb();
    const count = autoResolveContradictions(db, opts.repo);
    console.log(`Auto-resolved ${count} contradiction(s).`);
  });

// --- Phase 3: prune ---

program
  .command("prune")
  .description("Auto-prune stale and unhealthy memories")
  .option("--stale-days <n>", "Days before archiving stale memories", "90")
  .option("--rejected-days <n>", "Days before deleting rejected memories", "30")
  .option("--transient-days <n>", "Days before deleting transient memories", "7")
  .option("--min-health <n>", "Min health score for active memories", "0.2")
  .option("--dry-run", "Preview without making changes")
  .action((opts) => {
    const db = initDb();
    const result = pruneMemories(db, {
      stale_days: parseInt(opts.staleDays),
      rejected_retention_days: parseInt(opts.rejectedDays),
      transient_retention_days: parseInt(opts.transientDays),
      min_health_score: parseFloat(opts.minHealth),
      dry_run: opts.dryRun ?? false,
    });
    console.log(formatPruneReport(result, opts.dryRun ?? false));
  });

// --- Phase 3: audit ---

const auditCmd = program
  .command("audit")
  .description("View audit trail and rollback");

auditCmd
  .command("show")
  .description("Show audit trail for a memory")
  .argument("<memory-id>", "Memory ID")
  .action((memoryId: string) => {
    const db = initDb();
    const mem = findByPrefix(db, memoryId);
    if (!mem) {
      console.error(`Memory not found: ${memoryId}`);
      process.exit(1);
    }
    const entries = getAuditTrail(db, mem.id);
    console.log(formatAuditTrail(entries));
  });

auditCmd
  .command("recent")
  .description("Show recent audit entries")
  .option("-n, --limit <n>", "Max entries", "50")
  .action((opts) => {
    const db = initDb();
    const entries = getRecentAudit(db, parseInt(opts.limit));
    console.log(formatAuditTrail(entries));
  });

auditCmd
  .command("rollback")
  .description("Rollback a memory to a previous state")
  .argument("<memory-id>", "Memory ID")
  .argument("<audit-entry-id>", "Audit entry ID to rollback to")
  .option("--actor <name>", "Who performed rollback", "cli")
  .action((memoryId: string, auditEntryId: string, opts) => {
    const db = initDb();
    const mem = findByPrefix(db, memoryId);
    if (!mem) {
      console.error(`Memory not found: ${memoryId}`);
      process.exit(1);
    }
    const ok = rollbackMemory(db, mem.id, auditEntryId, opts.actor);
    if (ok) {
      console.log(`Memory ${mem.id.slice(0, 8)} rolled back.`);
    } else {
      console.error("Rollback failed. Audit entry not found or no snapshot.");
    }
  });

// --- Helpers ---

function loadSyncConfig(): SyncConfig | null {
  const url = process.env.RECALL_SYNC_URL;
  const key = process.env.RECALL_SYNC_KEY;
  if (!url || !key) return null;
  return {
    remote_url: url,
    api_key: key,
    team_id: process.env.RECALL_TEAM_ID,
    auto_sync: false,
    sync_interval_seconds: 300,
  };
}

function loadEmbeddingConfig(): EmbeddingConfig | null {
  if (process.env.RECALL_EMBEDDINGS_ENABLED !== "true") return null;
  return {
    enabled: true,
    provider: "openai",
    model: process.env.RECALL_EMBEDDING_MODEL ?? "text-embedding-3-small",
    api_key: process.env.OPENAI_API_KEY,
    dimensions: parseInt(process.env.RECALL_EMBEDDING_DIMS ?? "256"),
    similarity_threshold: parseFloat(process.env.RECALL_SIMILARITY_THRESHOLD ?? "0.8"),
  };
}

function findByPrefix(db: ReturnType<typeof initDb>, prefix: string) {
  // Try exact match first
  const exact = getMemory(db, prefix);
  if (exact) return exact;

  // Try prefix match
  const all = listMemories(db);
  const matches = all.filter((m) => m.id.startsWith(prefix));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.error(`Ambiguous prefix "${prefix}". Matches:`);
    for (const m of matches) console.error(`  ${m.id}`);
    process.exit(1);
  }
  return undefined;
}

program.parse();

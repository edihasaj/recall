import { Command } from "commander";
import { resolve } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { initDb, getDbPath, resetDb } from "./db/client.js";
import {
  listMemories,
  listRepos,
  getMemory,
  confirmMemory,
  rejectMemory,
  queryMemories,
  recordFeedback,
} from "./models/memory.js";
import { scanAndStore } from "./scanner/repo.js";
import { compileContext, compileContextHybrid } from "./compiler/context.js";
import { processCorrection, processReviewFeedback } from "./capture/correction.js";
import { exportClaude, exportCodex, exportMarkdown } from "./adapters/markdown.js";
import { writeRepoContextArtifact } from "./artifacts/context.js";
import { inferRepoSlugFromPath } from "./repo/discovery.js";
import { sync, createTeam, joinTeam } from "./sync/client.js";
import { computeMetrics, formatMetricsReport, startEvalSession, endEvalSession } from "./eval/harness.js";
import { formatRetrievalEvalReport, loadRetrievalEvalFile, runRetrievalEval } from "./eval/retrieval.js";
import {
  bootstrapEmbeddings,
  ensureEmbeddingProviderReady,
  getEmbeddingModelInfo,
  hybridSearch,
  loadEmbeddingConfigFromEnv,
  rebuildEmbeddingIndex,
  verifyEmbeddings,
} from "./embeddings/embeddings.js";
import { recordSignal, getSignalStats } from "./feedback/implicit.js";
import { inferScope, analyzeScopePatterns } from "./capture/scope.js";
import { createPolicy, listPolicies, togglePolicy, deletePolicy, evaluatePolicy, requestApproval, resolveApproval, listPendingApprovals } from "./policy/engine.js";
import { computeHealthScore, computeAllHealthScores, formatHealthReport } from "./health/scoring.js";
import { detectContradictions, resolveContradiction, autoResolveContradictions, listContradictions } from "./contradictions/detector.js";
import { pruneMemories, formatPruneReport } from "./pruning/pruner.js";
import { getAuditTrail, getRecentAudit, formatAuditTrail, rollbackMemory } from "./audit/trail.js";
import { getRepoQualityProfile } from "./repo/quality.js";
import { createActivityEvent, listActivityEvents, listActivitySessions } from "./models/activity.js";
import { runLocalSetup } from "./setup/local.js";
import { runRecallSetup } from "./setup/local.js";
import type { SyncConfig, EmbeddingConfig } from "./types.js";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { listHistorySnippets } from "./history/snippets.js";
import { searchHistorySnippets } from "./history/retrieval.js";
import { formatDoctorReport, getDoctorReport } from "./doctor/report.js";
import { ensureDailyBackup, listBackups, restoreBackup } from "./backups/snapshot.js";
import { getHookCallStats } from "./hooks/calls.js";
import {
  getLaunchAgentInfo,
  getLaunchAgentStatus,
  installLaunchAgent,
  startLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./daemon/launchd.js";
import {
  dispatchCodexNotify,
  executePromptHook,
  executeSessionEndHook,
  executeSessionStartHook,
  executeToolHook,
  formatInjectionContext,
  formatMaintenanceBacklogContext,
  parseInteger,
  parseRecentToolCallsOption,
  readClaudeCodePromptInputFromStdin,
  readClaudeCodeSessionEndInputFromStdin,
  readClaudeCodeSessionStartInputFromStdin,
  readClaudeCodeToolInputFromStdin,
  readCodexPromptInputFromStdin,
  readCodexSessionEndInputFromStdin,
  readCodexSessionStartInputFromStdin,
  readCodexToolInputFromStdin,
} from "./cli/hook.js";

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

program
  .command("doctor")
  .description("Show local Recall runtime, DB, embedding, and agent-install health")
  .option("--json", "Emit raw JSON report")
  .option("--fix", "Install missing hooks/MCP for detected agents")
  .action((opts) => {
    const report = getDoctorReport();
    if (opts.fix) {
      const detectedAgents = report.agents
        .filter((a) => a.detected && (!a.mcp || !a.hooks))
        .map((a) => a.agent);
      if (detectedAgents.length === 0) {
        if (!opts.json) console.log("Nothing to fix — all detected agents are wired.");
      } else {
        const fixResult = runLocalSetup({
          codex: detectedAgents.includes("codex"),
          claude: detectedAgents.includes("claude-code"),
        });
        if (!opts.json) {
          console.log(`Applied fix for: ${detectedAgents.join(", ")}`);
          console.log(`Codex MCP:    ${formatSetupStep(fixResult.codex)}`);
          console.log(`Codex hooks:  ${formatSetupStep(fixResult.codex_hooks)}`);
          console.log(`Claude MCP:   ${formatSetupStep(fixResult.claude)}`);
          console.log(`Claude hooks: ${formatSetupStep(fixResult.claude_hooks)}`);
          console.log("");
        }
      }
    }

    const finalReport = opts.fix ? getDoctorReport() : report;
    if (opts.json) {
      console.log(JSON.stringify(finalReport, null, 2));
      return;
    }
    console.log(formatDoctorReport(finalReport));
  });

const dbCmd = program
  .command("db")
  .description("Manage the local Recall database");

dbCmd
  .command("reset")
  .description("Reset the local Recall database and reinitialize the clean schema")
  .option("--yes", "Confirm destructive reset")
  .option("--yes-i-know", "Confirm destructive reset")
  .option("--purge-models", "Also remove the local embedding model cache")
  .action((opts) => {
    if (!opts.yes && !opts.yesIKnow) {
      console.error("Refusing to reset without --yes or --yes-i-know.");
      process.exit(1);
    }

    const dbPath = getDbPath();
    resetDb(dbPath, { purgeModels: opts.purgeModels });
    initDb(dbPath);
    console.log(`Reset ${dbPath}`);
    if (opts.purgeModels) {
      console.log("Purged local embedding model cache.");
    }
  });

dbCmd
  .command("backup")
  .description("Create a dated snapshot of the local database (idempotent per day)")
  .option("--retention <n>", "Number of snapshots to retain", (v) => Number.parseInt(v, 10))
  .action((opts) => {
    initDb();
    const result = ensureDailyBackup({
      retention: Number.isFinite(opts.retention) ? opts.retention : undefined,
    });
    if (result.created) console.log(`Created ${result.created}`);
    else console.log("Today's backup already exists.");
    console.log(`Retained: ${result.retained.length}`);
    for (const p of result.retained) console.log(`  ${p}`);
    if (result.removed.length) {
      console.log(`Removed: ${result.removed.length}`);
      for (const p of result.removed) console.log(`  ${p}`);
    }
  });

dbCmd
  .command("backups")
  .description("List available database snapshots")
  .action(() => {
    const backups = listBackups();
    if (backups.length === 0) {
      console.log("No backups yet.");
      return;
    }
    for (const b of backups) {
      const mb = (b.size_bytes / 1024 / 1024).toFixed(2);
      console.log(`${b.date}  ${mb} MB  ${b.path}`);
    }
  });

dbCmd
  .command("restore <date>")
  .description("Restore the local database from a dated snapshot (YYYY-MM-DD)")
  .option("--yes", "Confirm overwrite")
  .action((date: string, opts) => {
    if (!opts.yes) {
      console.error("Refusing to restore without --yes.");
      process.exit(1);
    }
    const result = restoreBackup(date);
    if (!result.restored) {
      console.error(`No backup found at ${result.from}`);
      process.exit(1);
    }
    console.log(`Restored ${result.from} -> ${result.to}`);
  });

const setupCmd = program
  .command("setup")
  .description("Setup Recall for local use");

setupCmd
  .option("--app-path <path>", "Override Recall.app path", "/Applications/Recall.app")
  .option("--hooks-only", "Install hooks only")
  .option("--mcp-only", "Install MCP wiring only")
  .option("--agent <agent>", "Restrict setup to a single agent (repeatable)", collectAgents, [])
  .option("--uninstall-hooks", "Remove Recall-managed hooks while leaving MCP configured")
  .option("--dry-run", "Show planned setup changes without writing")
  .option("--scope <scope>", "Hook config scope: global or project", "global")
  .option("--yes", "Skip confirmation prompt")
  .action(async (opts) => {
    if (!opts.yes && !opts.dryRun) {
      const confirmed = await confirmSetupWrite(opts.scope);
      if (!confirmed) {
        console.error("Aborted setup.");
        process.exit(1);
      }
    }

    const result = runRecallSetup({
      appPath: opts.appPath,
      agent: opts.agent.length > 0 ? opts.agent : undefined,
      dryRun: opts.dryRun,
      hooksOnly: opts.hooksOnly,
      mcpOnly: opts.mcpOnly,
      scope: opts.scope,
      uninstallHooks: opts.uninstallHooks,
    });

    console.log(`Recall app: ${result.appPath}`);
    console.log(`Bundled node: ${result.runtimeNodePath}`);
    console.log(`Bundled CLI:  ${result.runtimeCliPath}`);
    console.log(`Bundled MCP:  ${result.runtimeMcpPath}`);
    console.log(`Scope:        ${result.scope}${result.dry_run ? " (dry-run)" : ""}`);
    console.log("");
    if (result.agents.length === 0) {
      console.log("No installed agents detected.");
      return;
    }
    for (const agent of result.agents) {
      console.log(`${formatAgentName(agent.agent)}:`);
      console.log(`  detected: ${agent.detected ? "yes" : "no"}`);
      console.log(`  mcp:      ${formatSetupStep(agent.mcp)}`);
      console.log(`  hooks:    ${formatSetupStep(agent.hooks)}`);
      if (agent.hook_config_path) {
        console.log(`  config:   ${agent.hook_config_path}`);
      }
    }
  });

setupCmd
  .command("local")
  .description("Configure local Codex/Claude MCP + hooks against the installed Recall.app")
  .option("--app-path <path>", "Override Recall.app path", "/Applications/Recall.app")
  .option("--codex-only", "Configure only Codex")
  .option("--claude-only", "Configure only Claude")
  .action((opts) => {
    const result = runLocalSetup({
      appPath: opts.appPath,
      codex: opts.claudeOnly ? false : true,
      claude: opts.codexOnly ? false : true,
    });

    console.log(`Recall app: ${result.appPath}`);
    console.log(`Bundled node: ${result.runtimeNodePath}`);
    console.log(`Bundled CLI:  ${result.runtimeCliPath}`);
    console.log(`Bundled MCP:  ${result.runtimeMcpPath}`);
    console.log("");
    console.log(`Codex MCP:    ${formatSetupStep(result.codex)}`);
    console.log(`Codex hooks:  ${formatSetupStep(result.codex_hooks)}`);
    console.log(`Claude MCP:   ${formatSetupStep(result.claude)}`);
    console.log(`Claude hooks: ${formatSetupStep(result.claude_hooks)}`);
  });

// --- hook ---

const hookCmd = program
  .command("hook")
  .description("Run lifecycle hook handlers for agent integrations");

hookCmd
  .command("prompt")
  .description("Record a submitted prompt")
  .option("--text <text>", "Prompt text")
  .option("--repo <repo>", "Repository slug")
  .option("--repo-path <path>", "Repository path")
  .option("--session <id>", "Session ID")
  .option("--path <path>", "File path context")
  .option("--agent <agent>", "Agent name")
  .option("--prev-assistant <text>", "Previous assistant turn")
  .option("--recent-tools <json>", "Recent tool calls as a JSON array")
  .option("--claude-code-stdin", "Read Claude Code hook JSON from stdin")
  .option("--codex-stdin", "Read Codex hook JSON from stdin")
  .action(async (opts) => {
    const stdinAgent = opts.claudeCodeStdin ? "claude-code" : opts.codexStdin ? "codex" : null;
    const input = stdinAgent === "claude-code"
      ? await readClaudeCodePromptInputFromStdin()
      : stdinAgent === "codex"
        ? await readCodexPromptInputFromStdin()
        : {
            text: opts.text,
            repo: opts.repo,
            repo_path: opts.repoPath,
            session_id: opts.session,
            path: opts.path,
            agent: opts.agent,
            prev_assistant_turn: opts.prevAssistant,
            recent_tool_calls: parseRecentToolCallsOption(opts.recentTools),
          };
    const result = await executePromptHook(input);
    if (stdinAgent && result.injection) {
      const output = {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: formatInjectionContext(result.injection),
        },
      };
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  });

hookCmd
  .command("tool")
  .description("Record a completed tool invocation")
  .option("--name <name>", "Tool name")
  .option("--exit <code>", "Tool exit code")
  .option("--repo <repo>", "Repository slug")
  .option("--repo-path <path>", "Repository path")
  .option("--session <id>", "Session ID")
  .option("--path <path>", "File path context")
  .option("--agent <agent>", "Agent name")
  .option("--input-summary <text>", "Tool input summary")
  .option("--claude-code-stdin", "Read Claude Code hook JSON from stdin")
  .option("--codex-stdin", "Read Codex hook JSON from stdin")
  .action(async (opts) => {
    const input = opts.claudeCodeStdin
      ? await readClaudeCodeToolInputFromStdin()
      : opts.codexStdin
        ? await readCodexToolInputFromStdin()
        : {
            name: opts.name,
            exit_code: parseInteger(opts.exit, "exit"),
            repo: opts.repo,
            repo_path: opts.repoPath,
            session_id: opts.session,
            path: opts.path,
            agent: opts.agent,
            input_summary: opts.inputSummary,
          };
    await executeToolHook(input);
  });

hookCmd
  .command("session-start")
  .description("Record session start")
  .option("--session <id>", "Session ID")
  .option("--agent <agent>", "Agent name")
  .option("--repo <repo>", "Repository slug")
  .option("--repo-path <path>", "Repository path")
  .option("--path <path>", "File path context")
  .option("--claude-code-stdin", "Read Claude Code hook JSON from stdin")
  .option("--codex-stdin", "Read Codex hook JSON from stdin")
  .action(async (opts) => {
    const stdinAgent = opts.claudeCodeStdin ? "claude-code" : opts.codexStdin ? "codex" : null;
    const input = stdinAgent === "claude-code"
      ? await readClaudeCodeSessionStartInputFromStdin()
      : stdinAgent === "codex"
        ? await readCodexSessionStartInputFromStdin()
        : {
            session_id: opts.session,
            agent: opts.agent,
            repo: opts.repo,
            repo_path: opts.repoPath,
            path: opts.path,
          };
    const result = await executeSessionStartHook(input);
    if (stdinAgent) {
      const parts: string[] = [];
      if (result.injection) parts.push(formatInjectionContext(result.injection));
      if (result.maintenance_backlog) {
        parts.push(formatMaintenanceBacklogContext(result.maintenance_backlog));
      }
      if (parts.length > 0) {
        const output = {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: parts.join("\n\n"),
          },
        };
        process.stdout.write(`${JSON.stringify(output)}\n`);
      }
    }
  });

hookCmd
  .command("session-end")
  .description("Record session end")
  .option("--session <id>", "Session ID")
  .option("--repo <repo>", "Repository slug")
  .option("--repo-path <path>", "Repository path")
  .option("--path <path>", "File path context")
  .option("--agent <agent>", "Agent name")
  .option("--turn-count <count>", "Turn count")
  .option("--claude-code-stdin", "Read Claude Code hook JSON from stdin")
  .option("--codex-stdin", "Read Codex hook JSON from stdin")
  .action(async (opts) => {
    const input = opts.claudeCodeStdin
      ? await readClaudeCodeSessionEndInputFromStdin()
      : opts.codexStdin
        ? await readCodexSessionEndInputFromStdin()
        : {
            session_id: opts.session,
            repo: opts.repo,
            repo_path: opts.repoPath,
            path: opts.path,
            agent: opts.agent,
            turn_count: opts.turnCount ? parseInteger(opts.turnCount, "turn-count") : undefined,
          };
    await executeSessionEndHook(input);
  });

hookCmd
  .command("codex-notify")
  .description("Bridge a Codex notify payload into Recall hook handlers")
  .argument("[payload]", "Codex notify payload JSON")
  .action(async (payload?: string) => {
    await dispatchCodexNotify(payload);
  });

hookCmd
  .command("stats")
  .description("Inspect local hook call telemetry")
  .option("--agent <agent>", "Filter by agent")
  .option("--event <event>", "Filter by event")
  .option("--limit <n>", "Limit rows")
  .option("--json", "Emit raw JSON")
  .action((opts) => {
    const db = initDb();
    const stats = getHookCallStats(db, {
      agent: opts.agent,
      event: opts.event,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
    });

    if (opts.json) {
      console.log(JSON.stringify(stats, null, 2));
      return;
    }

    if (stats.length === 0) {
      console.log("No hook calls recorded.");
      return;
    }

    for (const row of stats) {
      console.log(
        `${row.agent.padEnd(12)} ${row.event.padEnd(16)} total=${row.total_calls} ok=${row.ok_calls} err=${row.error_calls} avg=${row.avg_duration_ms.toFixed(1)}ms max=${row.max_duration_ms}ms last=${row.last_called_at}`,
      );
    }
  });

// --- scan ---

program
  .command("scan")
  .description("Scan a repository and bootstrap memories")
  .argument("[path]", "Repository path", ".")
  .option("-s, --session <id>", "Session ID")
  .action((path: string, opts) => {
    const db = initDb();
    const repoPath = resolve(path);
    const ids = scanAndStore(db, repoPath);
    const artifact = writeRepoContextArtifact(db, {
      repo: inferRepoSlugFromPath(repoPath),
      repo_path: repoPath,
    });
    const scanned = ids
      .map((id) => getMemory(db, id))
      .filter((mem) => mem != null);
    const activeCount = scanned.filter((mem) => mem.status === "active").length;
    const candidateCount = scanned.filter((mem) => mem.status === "candidate").length;
    console.log(`Scanned ${repoPath}`);
    console.log(`Created ${ids.length} memories (${activeCount} active, ${candidateCount} candidate).`);
    if (artifact.output_path) {
      console.log(`Updated ${artifact.output_path}`);
    }
    createActivityEvent(db, {
      session_id: opts.session ?? null,
      repo: scanned[0]?.repo ?? null,
      source: "cli",
      event_type: "scan",
      memory_ids: ids,
      request: { repo_path: repoPath },
      result: { created: ids.length, active: activeCount, candidate: candidateCount },
    });

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
  .command("repos")
  .description("List repositories known to Recall")
  .action(() => {
    const db = initDb();
    const repos = listRepos(db);
    if (repos.length === 0) {
      console.log("No repositories found.");
      return;
    }
    for (const repo of repos) {
      console.log(repo);
    }
    console.log(`\n${repos.length} repos total.`);
  });

program
  .command("list")
  .description("List memories")
  .option("-r, --repo <repo>", "Filter by repository")
  .option(
    "-s, --status <status>",
    "Filter by status (transient|candidate|active|rejected)",
  )
  .option("-t, --type <type>", "Filter by type")
  .option("-n, --limit <n>", "Limit results")
  .option("--offset <n>", "Skip first N results", "0")
  .action((opts) => {
    const db = initDb();
    const items = queryMemories(db, {
      repo: opts.repo,
      status: opts.status,
      type: opts.type,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
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
  .option("-q, --query <text>", "Optional query text for hybrid reranking")
  .option("--include-candidates", "Allow strong candidate memories into hybrid ranking")
  .option("-s, --session <id>", "Session ID")
  .option("--threshold <n>", "Confidence threshold (default: dynamic from quality profile)")
  .action(async (opts) => {
    const db = initDb();
    const result = opts.query || opts.includeCandidates
      ? await compileContextHybrid(db, {
          repo: opts.repo,
          path: opts.path,
          query_text: opts.query,
          config: {
            ...(opts.threshold ? { confidence_threshold: parseFloat(opts.threshold) } : {}),
            include_candidates: opts.includeCandidates ?? false,
          },
        })
      : compileContext(db, {
          repo: opts.repo,
          path: opts.path,
          config: opts.threshold ? { confidence_threshold: parseFloat(opts.threshold) } : {},
        });
    createActivityEvent(db, {
      session_id: opts.session ?? null,
      repo: opts.repo,
      path: opts.path ?? null,
      source: "cli",
      event_type: "compile",
      memory_ids: result.memories_included,
      request: {
        threshold: opts.threshold ? parseFloat(opts.threshold) : null,
        query_text: opts.query ?? null,
        include_candidates: opts.includeCandidates ?? false,
      },
      result: {
        included: result.memories_included,
        dropped: result.memories_dropped,
        token_estimate: result.token_estimate,
      },
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
  .option("-s, --session <id>", "Session ID", "cli")
  .action(async (text: string, opts) => {
    const db = initDb();
    const ids = await processCorrection(db, text, {
      sessionId: opts.session,
      repo: opts.repo,
      path: opts.path,
    });
    createActivityEvent(db, {
      session_id: opts.session,
      repo: opts.repo ?? null,
      path: opts.path ?? null,
      source: "cli",
      event_type: "correction",
      memory_ids: ids,
      request: { text },
      result: { created: ids },
    });

    if (ids.length === 0) {
      console.log("No correction pattern detected.");
      console.log(
        'Try: "don\'t use X, use Y", "always do Z", "let\'s use editorconfig defaults", or "review said to use W"',
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
  .option("-s, --session <id>", "Session ID", "cli-review")
  .option("--reviewer <name>", "Reviewer name")
  .action(async (feedback: string, opts) => {
    const db = initDb();
    const ids = await processReviewFeedback(db, feedback, {
      sessionId: opts.session,
      repo: opts.repo,
      path: opts.path,
      reviewer: opts.reviewer,
    });
    createActivityEvent(db, {
      session_id: opts.session,
      repo: opts.repo ?? null,
      path: opts.path ?? null,
      source: "cli",
      event_type: "review",
      memory_ids: ids,
      request: { feedback, reviewer: opts.reviewer ?? null },
      result: { created: ids },
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
    "Export format: claude | codex | markdown | context",
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
      case "context": {
        const artifact = writeRepoContextArtifact(db, { repo: opts.repo });
        if (!artifact.output_path) {
          console.error(`Could not resolve local repo path for ${opts.repo}`);
          process.exit(1);
        }
        content = readFileSync(artifact.output_path, "utf-8");
        if (!opts.output) {
          console.log(content);
          return;
        }
        break;
      }
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

program
  .command("publish")
  .description("Write repo-local .recall/context.md for the current repo")
  .argument("[path]", "Repository path", ".")
  .action((path: string) => {
    const db = initDb();
    const repoPath = resolve(path);
    const artifact = writeRepoContextArtifact(db, {
      repo: inferRepoSlugFromPath(repoPath),
      repo_path: repoPath,
    });
    if (!artifact.output_path) {
      console.error(`Could not write repo-local context for ${repoPath}`);
      process.exit(1);
    }
    console.log(`Wrote ${artifact.output_path}`);
  });

const historyCmd = program
  .command("history")
  .description("Inspect rolled-up history snippets");

historyCmd
  .command("list")
  .description("List history snippets")
  .option("-r, --repo <repo>", "Filter by repository")
  .option("-s, --session <id>", "Filter by session id")
  .option("-k, --kind <kind>", "Filter by kind")
  .option("-n, --limit <n>", "Limit results", "20")
  .action((opts) => {
    const db = initDb();
    const items = listHistorySnippets(db, {
      repo: opts.repo,
      session_id: opts.session,
      kind: opts.kind,
      limit: parseInt(opts.limit, 10),
    });

    if (items.length === 0) {
      console.log("No history snippets found.");
      return;
    }

    for (const item of items) {
      console.log(`${item.id.slice(0, 8)}  [${item.kind}] repo=${item.repo ?? "-"} session=${item.session_id ?? "-"} ${item.text.split("\n")[0]}`);
    }
  });

historyCmd
  .command("search")
  .description("Search history snippets with hybrid lexical/vector retrieval")
  .argument("<query>", "Search query")
  .option("-r, --repo <repo>", "Filter by repository")
  .option("-n, --limit <n>", "Limit results", "10")
  .action(async (query: string, opts) => {
    const db = initDb();
    const results = await searchHistorySnippets(db, query, {
      repo: opts.repo,
      limit: parseInt(opts.limit, 10),
    });

    if (results.length === 0) {
      console.log("No matching history snippets found.");
      return;
    }

    for (const result of results) {
      console.log(
        `${result.snippet.id.slice(0, 8)}  (score=${result.score.toFixed(3)} vec=${result.similarity.toFixed(3)} lex=${result.lexical_score.toFixed(3)}) [${result.snippet.kind}] ${result.snippet.text.split("\n")[0]}`,
      );
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

evalCmd
  .command("retrieval")
  .description("Run retrieval eval fixtures against baseline vs hybrid retrieval")
  .requiredOption("-f, --file <path>", "Fixture file path")
  .option("-p, --provider <providers>", "Providers to compare (comma-separated: current,nomic,multilingual-e5,bge-small-en-v1.5)", "current")
  .option("--json", "Emit raw JSON report")
  .action(async (opts) => {
    const db = initDb();
    const input = loadRetrievalEvalFile(opts.file);
    const providers = String(opts.provider)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean) as Array<"current" | "nomic" | "multilingual-e5" | "bge-small-en-v1.5">;
    const report = await runRetrievalEval(db, input, { providers });

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(formatRetrievalEvalReport(report));
  });

// --- Phase 1: embeddings ---

const embeddingsCmd = program
  .command("embeddings")
  .description("Manage canonical embedding state");

embeddingsCmd
  .command("setup")
  .description("Pre-fetch the active embedding model into the local cache")
  .action(async () => {
    const config = loadEmbeddingConfigFromEnv();
    if (!config) {
      console.error("Embeddings are disabled. Unset RECALL_EMBEDDINGS_DISABLED=true to enable local embeddings.");
      process.exit(1);
    }

    const before = getEmbeddingModelInfo(config)!;
    if (!before.cached) {
      const approx = before.estimated_size_mb ? `~${before.estimated_size_mb}MB` : "download";
      console.log(`Fetching embedding model (one-time, ${approx}) -> ${before.cache_path}`);
    }

    const info = await ensureEmbeddingProviderReady(config);
    if (!info) {
      console.error("Failed to initialize embedding provider.");
      process.exit(1);
    }

    console.log(`Provider: ${info.provider}`);
    console.log(`Model:    ${info.model}`);
    console.log(`Cache:    ${info.cache_path}`);
    console.log(`Size:     ${info.size_label}`);
  });

embeddingsCmd
  .command("info")
  .description("Show active embedding provider and cache details")
  .action(() => {
    const info = getEmbeddingModelInfo();
    if (!info) {
      console.error("Embeddings are disabled. Unset RECALL_EMBEDDINGS_DISABLED=true to enable local embeddings.");
      process.exit(1);
    }

    console.log(`Provider: ${info.provider}`);
    console.log(`Model:    ${info.model}`);
    console.log(`Dims:     index=${info.index_dimensions} canonical=${info.canonical_dimensions}`);
    console.log(`Version:  ${info.version}`);
    console.log(`Cached:   ${info.cached ? "yes" : "no"}`);
    console.log(`Size:     ${info.size_label}`);
    console.log(`Cache:    ${info.cache_path}`);
    if (info.task_prefix) {
      console.log(`Prefix:   ${info.task_prefix}`);
    }
  });

embeddingsCmd
  .command("bootstrap")
  .description("Generate or refresh embeddings for eligible memories")
  .option("-r, --repo <repo>", "Limit bootstrap to one repo")
  .action(async (opts) => {
    const db = initDb();
    const config = loadEmbeddingConfigFromEnv();
    if (!config) {
      console.error("Embeddings are disabled. Unset RECALL_EMBEDDINGS_DISABLED=true to enable local embeddings.");
      process.exit(1);
    }

    const count = await bootstrapEmbeddings(db, config, {
      repo: opts.repo,
    });
    console.log(`Bootstrapped ${count} embeddings.`);
  });

embeddingsCmd
  .command("verify")
  .description("Verify embedding coverage and stale content hashes")
  .option("-r, --repo <repo>", "Limit verification to one repo")
  .action((opts) => {
    const db = initDb();
    const config = loadEmbeddingConfigFromEnv();
    if (!config) {
      console.error("Embeddings are disabled. Unset RECALL_EMBEDDINGS_DISABLED=true to enable local embeddings.");
      process.exit(1);
    }

    const result = verifyEmbeddings(db, config, {
      repo: opts.repo,
    });
    console.log(`Eligible: ${result.eligible}`);
    console.log(`Stored:   ${result.stored}`);
    console.log(`Stale:    ${result.stale}`);
    console.log(`Indexed:  ${result.indexed}`);
    console.log(`Drift:    ${result.index_drift}`);
    console.log(`Lexical:  ${result.lexical_indexed}`);
    console.log(`LexDrift: ${result.lexical_drift}`);
  });

embeddingsCmd
  .command("rebuild-index")
  .description("Rebuild derived retrieval indexes from canonical memories")
  .option("-r, --repo <repo>", "Limit rebuild to one repo")
  .action((opts) => {
    const db = initDb();
    const config = loadEmbeddingConfigFromEnv();
    const result = rebuildEmbeddingIndex(db, config, {
      repo: opts.repo,
    });
    console.log(`Rebuilt sqlite-vec index with ${result.vector_rows} rows.`);
    console.log(`Rebuilt FTS5 index with ${result.lexical_rows} rows.`);
  });

program
  .command("search")
  .description("Hybrid lexical + vector search across memories")
  .argument("<query>", "Search query")
  .option("-r, --repo <repo>", "Filter by repo")
  .option("-n, --limit <n>", "Max results", "10")
  .action(async (query: string, opts) => {
    const db = initDb();
    const config = loadEmbeddingConfigFromEnv();
    const results = await hybridSearch(db, query, config, {
      repo: opts.repo,
      limit: parseInt(opts.limit),
    });

    if (results.length === 0) {
      console.log("No matching memories found.");
      return;
    }

    for (const r of results) {
      console.log(
        `${r.memory.id.slice(0, 8)}  (score=${r.score.toFixed(3)} vec=${r.similarity.toFixed(3)} lex=${r.lexical_score.toFixed(3)}) [${r.memory.status}] ${r.memory.text}`,
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
    createActivityEvent(db, {
      session_id: opts.session,
      repo: mem.repo,
      path: mem.path_scope,
      source: "cli",
      event_type: "signal",
      memory_ids: [mem.id],
      request: { signal },
      result: { signal_id: id },
    });
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
  .option("-r, --repo <repo>", "Limit pruning to one repo")
  .option("--stale-days <n>", "Days before rejecting stale memories", "90")
  .option("--rejected-days <n>", "Days before deleting rejected memories", "30")
  .option("--transient-days <n>", "Days before deleting transient memories", "7")
  .option("--min-health <n>", "Min health score for active memories", "0.2")
  .option("--dry-run", "Preview without making changes")
  .action((opts) => {
    const db = initDb();
    const result = pruneMemories(db, {
      repo: opts.repo,
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

// --- Quality profile ---

program
  .command("quality")
  .description("Show repo quality profile and dynamic thresholds")
  .option("-r, --repo <repo>", "Repository name")
  .action((opts) => {
    const db = initDb();
    const profile = getRepoQualityProfile(db, opts.repo);
    console.log(`Stage:                  ${profile.stage}`);
    console.log(`Quality score:          ${(profile.score * 100).toFixed(0)}%`);
    console.log(`Active memories:        ${profile.active_count}`);
    console.log(`Total memories:         ${profile.total_count}`);
    console.log(`Avg health:             ${(profile.avg_health * 100).toFixed(0)}%`);
    console.log(`Override rate:          ${(profile.override_rate * 100).toFixed(0)}%`);
    console.log(`Contradiction rate:     ${(profile.contradiction_rate * 100).toFixed(0)}%`);
    console.log(`---`);
    console.log(`Repeat sessions needed: ${profile.repeat_sessions_required}`);
    console.log(`Compile threshold:      ${profile.compile_confidence_threshold.toFixed(2)}`);
    console.log(`Dedup similarity:       ${profile.dedup_similarity_threshold.toFixed(2)}`);
  });

// --- Activity ---

program
  .command("activity")
  .description("List recent activity events")
  .option("-r, --repo <repo>", "Filter by repo")
  .option("-s, --session <id>", "Filter by session ID")
  .option("--source <source>", "Filter by source: cli|daemon|mcp|system")
  .option("--type <type>", "Filter by event type: compile|query|scan|correction|review|feedback|signal|session_start|session_event|session_end")
  .option("--since <iso>", "Filter by created_at >= ISO timestamp")
  .option("-n, --limit <n>", "Max events", "20")
  .action((opts) => {
    const db = initDb();
    const events = listActivityEvents(db, {
      repo: opts.repo,
      session_id: opts.session,
      source: opts.source,
      event_type: opts.type,
      since: opts.since,
      limit: parseInt(opts.limit, 10),
    });
    if (events.length === 0) {
      console.log("No activity found.");
      return;
    }
    for (const event of events) {
      console.log(
        `${event.created_at}  ${event.source}/${event.event_type}  session:${event.session_id ?? "-"}  repo:${event.repo ?? "-"}  memories:${event.memory_ids.length}`,
      );
    }
    console.log(`\n${events.length} activity events total.`);
  });

program
  .command("sessions")
  .description("List recent activity sessions")
  .option("-r, --repo <repo>", "Filter by repo")
  .option("--source <source>", "Filter by source: cli|daemon|mcp|system")
  .option("--type <type>", "Filter by event type: compile|query|scan|correction|review|feedback|signal|session_start|session_event|session_end")
  .option("--since <iso>", "Filter by created_at >= ISO timestamp")
  .option("-n, --limit <n>", "Max sessions", "20")
  .action((opts) => {
    const db = initDb();
    const sessions = listActivitySessions(db, {
      repo: opts.repo,
      source: opts.source,
      event_type: opts.type,
      since: opts.since,
      limit: parseInt(opts.limit, 10),
    });
    if (sessions.length === 0) {
      console.log("No sessions found.");
      return;
    }
    for (const session of sessions) {
      console.log(
        `${session.last_at}  ${session.session_id}  repo:${session.repo ?? "-"}  events:${session.event_count}  types:${session.event_types.join(",")}`,
      );
    }
    console.log(`\n${sessions.length} sessions total.`);
  });

// --- daemon ---

const daemonCmd = program
  .command("daemon")
  .description("Manage the local Recall HTTP daemon with launchd");

daemonCmd
  .command("install")
  .description("Install and start a user LaunchAgent")
  .option("--port <port>", "Daemon port", "7890")
  .option("--data-dir <dir>", "Recall data dir")
  .option("--label <label>", "LaunchAgent label", "com.recall.daemon")
  .option("--node-path <path>", "Node executable path override")
  .option("--daemon-script <path>", "Daemon script path override")
  .action((opts) => {
    const status = installLaunchAgent({
      label: opts.label,
      port: parseInt(opts.port, 10),
      dataDir: opts.dataDir,
      nodePath: opts.nodePath,
      daemonScript: opts.daemonScript,
    });
    console.log(getLaunchAgentInfo(status.label));
  });

daemonCmd
  .command("start")
  .description("Start the installed LaunchAgent")
  .option("--label <label>", "LaunchAgent label", "com.recall.daemon")
  .action((opts) => {
    const status = startLaunchAgent(opts.label);
    console.log(getLaunchAgentInfo(status.label));
  });

daemonCmd
  .command("stop")
  .description("Stop the LaunchAgent")
  .option("--label <label>", "LaunchAgent label", "com.recall.daemon")
  .action((opts) => {
    const status = stopLaunchAgent(opts.label);
    console.log(getLaunchAgentInfo(status.label));
  });

daemonCmd
  .command("restart")
  .description("Restart the LaunchAgent")
  .option("--label <label>", "LaunchAgent label", "com.recall.daemon")
  .action((opts) => {
    stopLaunchAgent(opts.label);
    const status = startLaunchAgent(opts.label);
    console.log(getLaunchAgentInfo(status.label));
  });

daemonCmd
  .command("status")
  .description("Show LaunchAgent status")
  .option("--label <label>", "LaunchAgent label", "com.recall.daemon")
  .action((opts) => {
    const status = getLaunchAgentStatus(opts.label);
    console.log(getLaunchAgentInfo(status.label));
  });

daemonCmd
  .command("uninstall")
  .description("Remove the LaunchAgent")
  .option("--label <label>", "LaunchAgent label", "com.recall.daemon")
  .action((opts) => {
    const status = uninstallLaunchAgent(opts.label);
    console.log(getLaunchAgentInfo(status.label));
  });

// --- Tier-2 maintenance tasks ---

const maintenanceCmd = program
  .command("maintenance")
  .description("Inspect and manage the delegated maintenance task queue");

maintenanceCmd
  .command("stats")
  .description("Show backlog counts, completion stats, and mean latency")
  .action(async () => {
    const { getTaskStats } = await import("./maintenance/tasks.js");
    const db = initDb();
    const stats = getTaskStats(db);
    console.log(`Total tasks:            ${stats.total}`);
    console.log(`---`);
    console.log(`Pending:                ${stats.by_status.pending}`);
    console.log(`Claimed:                ${stats.by_status.claimed}`);
    console.log(`Completed:              ${stats.by_status.completed}`);
    console.log(`Abandoned:              ${stats.by_status.abandoned}`);
    console.log(`---`);
    console.log(`Last 24h completed:     ${stats.completed_last_24h}`);
    console.log(`Last 24h abandoned:     ${stats.abandoned_last_24h}`);
    if (stats.mean_completion_ms != null) {
      console.log(`Mean completion:        ${(stats.mean_completion_ms / 1000).toFixed(1)}s`);
    }
    if (stats.pending_oldest_created_at) {
      console.log(`Oldest pending:         ${stats.pending_oldest_created_at}`);
    }
    console.log(`---`);
    console.log(`By kind:`);
    for (const [kind, count] of Object.entries(stats.by_kind)) {
      if (count === 0) continue;
      console.log(`  ${kind.padEnd(22)} ${count}`);
    }
  });

maintenanceCmd
  .command("list")
  .description("List tasks (default: pending)")
  .option("-s, --status <status>", "pending|claimed|completed|abandoned", "pending")
  .option("-k, --kind <kind>", "Filter by kind")
  .option("-r, --repo <repo>", "Filter by repo")
  .option("-n, --limit <n>", "Max entries", "20")
  .action(async (opts) => {
    const { listTasks } = await import("./maintenance/tasks.js");
    const db = initDb();
    const tasks = listTasks(db, {
      status: opts.status,
      kinds: opts.kind ? [opts.kind] : undefined,
      repo: opts.repo,
      limit: parseInt(opts.limit, 10),
    });
    if (tasks.length === 0) {
      console.log(`No ${opts.status} tasks.`);
      return;
    }
    for (const t of tasks) {
      const age = t.created_at.slice(0, 19);
      const prefix = t.id.slice(0, 8);
      const repo = t.repo ?? "-";
      const attempts = t.attempts > 0 ? ` attempts=${t.attempts}` : "";
      const reason = t.failure_reason ? ` (${t.failure_reason.slice(0, 60)})` : "";
      console.log(`${prefix}  p${t.priority}  ${t.kind.padEnd(20)} ${t.status.padEnd(10)} ${repo.padEnd(30)} ${age}${attempts}${reason}`);
    }
  });

maintenanceCmd
  .command("drop")
  .description("Delete a task by id (or id prefix)")
  .argument("<task-id>", "Task id or prefix")
  .action(async (taskIdArg: string) => {
    const { deleteTask, listTasks } = await import("./maintenance/tasks.js");
    const db = initDb();
    const all = listTasks(db, { limit: 10_000 });
    const matches = all.filter((t) => t.id === taskIdArg || t.id.startsWith(taskIdArg));
    if (matches.length === 0) {
      console.error(`No task matching "${taskIdArg}".`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`Ambiguous prefix "${taskIdArg}". Matches:`);
      for (const t of matches) console.error(`  ${t.id}  ${t.kind}  ${t.status}`);
      process.exit(1);
    }
    const ok = deleteTask(db, matches[0].id);
    if (ok) console.log(`Dropped task ${matches[0].id}.`);
    else console.error("Drop failed.");
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

function formatSetupStep(step: { enabled: boolean; ok: boolean; message: string }) {
  if (!step.enabled) return `skipped (${step.message})`;
  return step.ok ? `ok (${step.message})` : `error (${step.message})`;
}

function formatAgentName(agent: string) {
  return agent === "claude-code" ? "Claude Code" : "Codex";
}

function collectAgents(value: string, previous: string[]) {
  return [...previous, value];
}

async function confirmSetupWrite(scope: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(`Update ${scope} agent config files for Recall? [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
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

export { program };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await program.parseAsync(process.argv);
}

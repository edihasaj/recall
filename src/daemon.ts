import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { RecallDb } from "./db/client.js";
import { compileContext, compileContextHybrid } from "./compiler/context.js";
import { processCorrection, processReviewFeedback } from "./capture/correction.js";
import {
  confirmMemory,
  rejectMemory,
  queryMemories,
  recordFeedback,
  getMemory,
} from "./models/memory.js";
import { scanAndStore } from "./scanner/repo.js";
import { computeMetrics, formatMetricsReport, startEvalSession, endEvalSession, incrementEvalCounter } from "./eval/harness.js";
import { recordSignal, getSignalStats, recordTestSignals, runTests } from "./feedback/implicit.js";
import { createPolicy, listPolicies, evaluatePolicy, requestApproval, resolveApproval, listPendingApprovals } from "./policy/engine.js";
import { computeHealthScore, computeAllHealthScores } from "./health/scoring.js";
import { detectContradictions, resolveContradiction, autoResolveContradictions, listContradictions } from "./contradictions/detector.js";
import { pruneMemories } from "./pruning/pruner.js";
import { getAuditTrail, getRecentAudit, recordAudit, rollbackMemory } from "./audit/trail.js";
import { getRepoQualityProfile } from "./repo/quality.js";
import { createActivityEvent, listActivityEvents, listActivitySessions } from "./models/activity.js";
import { ensureRepoBootstrapped, inferRepoSlugFromPath } from "./repo/discovery.js";
import { ensureEmbeddingProviderReady, getEmbeddingModelInfo, loadEmbeddingConfigFromEnv } from "./embeddings/embeddings.js";
import {
  endSessionLifecycle,
  recordSessionLifecycleEvent,
  startSessionLifecycle,
} from "./session/lifecycle.js";
import { writeRepoContextArtifact } from "./artifacts/context.js";
import { loadMaintenanceConfigFromEnv, runMaintenanceCycle } from "./maintenance/lifecycle.js";
import { formatMaintenanceSummary, shouldLogMaintenance } from "./maintenance/logging.js";
import { dispatchPendingTasks } from "./maintenance/dispatcher.js";
import { runDeterministicCleanup } from "./maintenance/cleanup.js";
import { computeQualityReport, listQualitySnapshots, recordQualitySnapshot } from "./maintenance/quality.js";
import { hasProviderConfigured } from "./credentials/keychain.js";
import { initDb } from "./db/client.js";
import { ensureDailyBackup } from "./backups/snapshot.js";
import { handleRecallMcpHttpRequest } from "./mcp/http.js";
import {
  handlePromptHook,
  handleSessionEndHook,
  handleSessionStartHook,
  handleToolHook,
} from "./cli/hook.js";

let db: RecallDb;
const PORT = parseInt(process.env.RECALL_PORT ?? "7890", 10);
const requireFromHere = createRequire(import.meta.url);
const pkg = requireFromHere("../package.json") as { version: string };
const maintenanceConfig = loadMaintenanceConfigFromEnv();
let maintenanceRunning = false;

const dispatcherConfig = {
  enabled: process.env.RECALL_DISPATCHER_ENABLED !== "false",
  intervalSeconds: parseInt(process.env.RECALL_DISPATCHER_INTERVAL_SECONDS ?? "86400", 10),
  maxTasksPerRun: parseInt(process.env.RECALL_DISPATCHER_MAX_TASKS_PER_RUN ?? "5", 10),
};
let dispatcherRunning = false;

const cleanupConfig = {
  enabled: process.env.RECALL_CLEANUP_ENABLED !== "false",
  intervalSeconds: parseInt(process.env.RECALL_CLEANUP_INTERVAL_SECONDS ?? "86400", 10),
};
let cleanupRunning = false;

const qualitySnapshotConfig = {
  enabled: process.env.RECALL_QUALITY_SNAPSHOT_ENABLED !== "false",
  intervalSeconds: parseInt(process.env.RECALL_QUALITY_SNAPSHOT_INTERVAL_SECONDS ?? "604800", 10),
};
let qualitySnapshotRunning = false;

function parseBody(req: import("node:http").IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function resolveRepo(body: Record<string, any>): string | undefined {
  return body.repo ?? inferRepoSlugFromPath(body.repo_path) ?? undefined;
}

function scheduleMaintenanceLoop() {
  if (!maintenanceConfig.enabled) return;

  const run = async () => {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      const result = await runMaintenanceCycle(db, maintenanceConfig);
      if (shouldLogMaintenance(result)) {
        console.log(formatMaintenanceSummary(result));
      }
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`[recall] maintenance failed: ${message}`);
    } finally {
      maintenanceRunning = false;
    }
  };

  const intervalMs = Math.max(30, maintenanceConfig.interval_seconds) * 1000;
  // Defer first run so startup health checks can succeed before embedding
  // verification or history refresh work can occupy the event loop.
  setTimeout(() => void run(), intervalMs).unref?.();
  const timer = setInterval(() => {
    void run();
  }, intervalMs);
  timer.unref?.();
}

let dispatcherDormantLogged = false;

async function runDispatcherOnce(): Promise<void> {
  if (dispatcherRunning) return;
  const hasKey =
    hasProviderConfigured("anthropic") ||
    hasProviderConfigured("azure-openai") ||
    hasProviderConfigured("openai");
  if (!hasKey) {
    if (!dispatcherDormantLogged) {
      console.log("[recall] dispatcher dormant: no LLM provider configured (set one via 'recall maintenance credentials set <provider> <key>'; preview prompts via 'recall maintenance dispatch --preview')");
      dispatcherDormantLogged = true;
    }
    return;
  }
  dispatcherDormantLogged = false;

  dispatcherRunning = true;
  try {
    const report = await dispatchPendingTasks(db, {
      maxTasks: dispatcherConfig.maxTasksPerRun,
    });
    if (report.attempted > 0 || report.applied > 0) {
      console.log(
        `[recall] dispatcher ${report.provider}: attempted=${report.attempted} applied=${report.applied} rejected=${report.rejected} released=${report.released}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[recall] dispatcher failed: ${message}`);
  } finally {
    dispatcherRunning = false;
  }
}

// Wake-up: triggered by the hook after enqueuing a task. Debounced so a
// burst of hook calls (e.g. parallel sessions) collapses to one dispatch
// run a few seconds later — that lets the dispatcher batch tasks and not
// hammer the LLM provider per prompt.
let dispatchWakeTimer: NodeJS.Timeout | null = null;
const DISPATCH_WAKE_DEBOUNCE_MS = 3_000;
function wakeDispatcherDebounced(): void {
  if (!dispatcherConfig.enabled) return;
  if (dispatchWakeTimer) return;
  dispatchWakeTimer = setTimeout(() => {
    dispatchWakeTimer = null;
    void runDispatcherOnce();
  }, DISPATCH_WAKE_DEBOUNCE_MS);
  dispatchWakeTimer.unref?.();
}

function scheduleDispatcherLoop() {
  if (!dispatcherConfig.enabled) return;
  const timer = setInterval(() => {
    void runDispatcherOnce();
  }, Math.max(60, dispatcherConfig.intervalSeconds) * 1000);
  timer.unref?.();
}

function scheduleCleanupLoop() {
  if (!cleanupConfig.enabled) return;

  const run = async () => {
    if (cleanupRunning) return;
    cleanupRunning = true;
    try {
      const report = runDeterministicCleanup(db, { dryRun: false });
      const c = report.counts;
      const total =
        c.dedupe_clusters +
        c.fragment_rejections +
        c.repeat_promotions +
        c.command_suppressions +
        c.globalizations;
      if (total > 0) {
        console.log(
          `[recall] cleanup run=${report.run_id.slice(0, 8)} merges=${c.dedupe_clusters}/${c.dedupe_losers} fragments=${c.fragment_rejections} promotions=${c.repeat_promotions} suppress=${c.command_suppressions} globalize=${c.globalizations}/${c.globalize_losers}`,
        );
      }
      // Surface logical conflicts after each tick. Cheap (O(n²) over active
      // memories) and lets users see "Use pnpm" vs "Use bun" before the
      // model gets the contradictory pair injected.
      const newContradictions = detectContradictions(db);
      if (newContradictions.length > 0) {
        console.log(
          `[recall] contradictions detected: ${newContradictions.length} new pair(s)`,
        );
        for (const c of newContradictions.slice(0, 5)) {
          console.log(`  [${c.severity}] ${c.contradiction_type}: ${c.description.slice(0, 120)}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`[recall] cleanup failed: ${message}`);
    } finally {
      cleanupRunning = false;
    }
  };

  // Defer the first run so we don't fight startup migrations.
  setTimeout(() => void run(), 30_000).unref?.();
  const timer = setInterval(() => {
    void run();
  }, Math.max(60, cleanupConfig.intervalSeconds) * 1000);
  timer.unref?.();
}

function scheduleQualitySnapshotLoop() {
  if (!qualitySnapshotConfig.enabled) return;

  const intervalMs = Math.max(60, qualitySnapshotConfig.intervalSeconds) * 1000;

  const run = () => {
    if (qualitySnapshotRunning) return;
    qualitySnapshotRunning = true;
    try {
      // Only snapshot if the most recent snapshot is older than the interval.
      const last = listQualitySnapshots(db, 1)[0];
      if (last) {
        const ageMs = Date.now() - new Date(last.taken_at).getTime();
        if (ageMs < intervalMs) return;
      }
      const report = computeQualityReport(db);
      const row = recordQualitySnapshot(db, report, "auto");
      console.log(
        `[recall] quality snapshot ${row.id.slice(0, 8)} followed=${row.followed_rate_resolved != null ? (row.followed_rate_resolved * 100).toFixed(1) + "%" : "n/a"} resolved=${row.injections_resolved} history=${row.history_injections_total} rules=${row.active_rule_count} cand=${row.candidate_correction_count}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`[recall] quality snapshot failed: ${message}`);
    } finally {
      qualitySnapshotRunning = false;
    }
  };

  setTimeout(run, 60_000).unref?.();
  // Re-check hourly; the age gate keeps actual writes weekly.
  const timer = setInterval(run, 3600 * 1000);
  timer.unref?.();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  // CORS for browser extension
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID",
  );

  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    if (path === "/mcp") {
      return await handleRecallMcpHttpRequest(req, res, db);
    }

    res.setHeader("Content-Type", "application/json");

    // Health
    if (path === "/health" && method === "GET") {
      return send(res, 200, {
        status: "ok",
        version: pkg.version,
        embeddings: getEmbeddingModelInfo(),
      });
    }

    // Compile context (hook injection endpoint)
    if (path === "/compile" && method === "POST") {
      const body = await parseBody(req);
      const repo = resolveRepo(body);
      if (!repo) return send(res, 400, { error: "repo or repo_path required" });

      const bootstrap = ensureRepoBootstrapped(db, {
        repo,
        repoPathHint: body.repo_path,
      });
      if (bootstrap.status === "bootstrapped" || bootstrap.status === "scanned_empty") {
        createActivityEvent(db, {
          session_id: body.session_id ?? null,
          repo,
          source: "daemon",
          event_type: "scan",
          memory_ids: bootstrap.created_ids,
          request: {
            repo_path: bootstrap.repo_path,
            trigger: "compile_auto_bootstrap",
          },
          result: {
            created: bootstrap.created_ids.length,
            status: bootstrap.status,
          },
        });
      }

      const result = body.query_text || body.config?.include_candidates
        ? await compileContextHybrid(db, {
            repo,
            path: body.path,
            session_id: body.session_id,
            query_text: body.query_text,
            config: body.config,
          })
        : compileContext(db, {
            repo,
            path: body.path,
            session_id: body.session_id,
            config: body.config,
          });
      createActivityEvent(db, {
        session_id: body.session_id ?? null,
        repo,
        path: body.path ?? null,
        source: "daemon",
        event_type: "compile",
        memory_ids: result.memories_included,
        request: {
          config: body.config ?? {},
          query_text: body.query_text ?? null,
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
      return send(res, 200, {
        ...result,
        repo,
        repo_path: bootstrap.repo_path ?? body.repo_path ?? null,
        bootstrap_status: bootstrap.status,
      });
    }

    // Session start
    if (path === "/session/start" && method === "POST") {
      const body = await parseBody(req);
      if (!body.session_id) {
        return send(res, 400, { error: "session_id required" });
      }
      const result = startSessionLifecycle(db, {
        session_id: body.session_id,
        client: body.client ?? null,
        repo: body.repo ?? null,
        repo_path: body.repo_path ?? null,
        path: body.path ?? null,
        meta: body.meta ?? {},
      });
      return send(res, 200, result);
    }

    // Session event
    if (path === "/session/event" && method === "POST") {
      const body = await parseBody(req);
      if (!body.session_id || !body.name) {
        return send(res, 400, { error: "session_id and name required" });
      }
      const result = recordSessionLifecycleEvent(db, {
        session_id: body.session_id,
        client: body.client ?? null,
        repo: body.repo ?? null,
        repo_path: body.repo_path ?? null,
        path: body.path ?? null,
        meta: body.meta ?? {},
        name: body.name,
        payload: body.payload ?? {},
      });
      return send(res, 200, result);
    }

    // Session end
    if (path === "/session/end" && method === "POST") {
      const body = await parseBody(req);
      if (!body.session_id) {
        return send(res, 400, { error: "session_id required" });
      }
      const result = endSessionLifecycle(db, {
        session_id: body.session_id,
        client: body.client ?? null,
        repo: body.repo ?? null,
        repo_path: body.repo_path ?? null,
        path: body.path ?? null,
        meta: body.meta ?? {},
        payload: body.payload ?? {},
      });
      return send(res, 200, result);
    }

    // Dispatch wake: called by the capture hook after enqueuing a task.
    // Debounced 3s so a burst of hook calls collapses to one dispatch run.
    if (path === "/dispatch/wake" && method === "POST") {
      wakeDispatcherDebounced();
      return send(res, 202, { status: "queued", debounce_ms: DISPATCH_WAKE_DEBOUNCE_MS });
    }

    // Hook prompt
    if (path === "/hook/prompt" && method === "POST") {
      const body = await parseBody(req);
      if (!body.text) {
        return send(res, 400, { error: "text required" });
      }
      const result = await handlePromptHook(body, {
        db,
        source: "daemon",
      });
      return send(res, 200, { ...result, transport: "daemon" });
    }

    // Hook tool
    if (path === "/hook/tool" && method === "POST") {
      const body = await parseBody(req);
      if (!body.name || typeof body.exit_code !== "number") {
        return send(res, 400, { error: "name and numeric exit_code required" });
      }
      const result = await handleToolHook(body, {
        db,
        source: "daemon",
      });
      return send(res, 200, { ...result, transport: "daemon" });
    }

    // Hook session start
    if (path === "/hook/session-start" && method === "POST") {
      const body = await parseBody(req);
      if (!body.session_id || !body.agent) {
        return send(res, 400, { error: "session_id and agent required" });
      }
      const result = await handleSessionStartHook(body, {
        db,
        source: "daemon",
      });
      return send(res, 200, { ...result, transport: "daemon" });
    }

    // Hook session end
    if (path === "/hook/session-end" && method === "POST") {
      const body = await parseBody(req);
      if (!body.session_id) {
        return send(res, 400, { error: "session_id required" });
      }
      const result = await handleSessionEndHook(body, {
        db,
        source: "daemon",
      });
      return send(res, 200, { ...result, transport: "daemon" });
    }

    // Report correction
    if (path === "/correct" && method === "POST") {
      const body = await parseBody(req);
      const repo = resolveRepo(body);
      const ids = await processCorrection(db, body.text, {
        sessionId: body.session_id ?? "hook",
        repo,
        path: body.path,
      });
      createActivityEvent(db, {
        session_id: body.session_id ?? "hook",
        repo: repo ?? null,
        path: body.path ?? null,
        source: "daemon",
        event_type: "correction",
        memory_ids: ids,
        request: { text: body.text },
        result: { created: ids },
      });
      return send(res, 200, { created: ids });
    }

    // Report review feedback
    if (path === "/review" && method === "POST") {
      const body = await parseBody(req);
      const repo = resolveRepo(body);
      const ids = await processReviewFeedback(db, body.feedback, {
        sessionId: body.session_id ?? "hook-review",
        repo,
        path: body.path,
        reviewer: body.reviewer,
      });
      createActivityEvent(db, {
        session_id: body.session_id ?? "hook-review",
        repo: repo ?? null,
        path: body.path ?? null,
        source: "daemon",
        event_type: "review",
        memory_ids: ids,
        request: { feedback: body.feedback, reviewer: body.reviewer ?? null },
        result: { created: ids },
      });
      return send(res, 200, { created: ids });
    }

    // Confirm memory
    if (path === "/confirm" && method === "POST") {
      const body = await parseBody(req);
      const ok = confirmMemory(db, body.memory_id);
      return send(res, ok ? 200 : 404, { success: ok });
    }

    // Reject memory
    if (path === "/reject" && method === "POST") {
      const body = await parseBody(req);
      const before = getMemory(db, body.memory_id);
      const ok = rejectMemory(db, body.memory_id);
      if (ok) {
        const after = getMemory(db, body.memory_id);
        recordAudit(
          db,
          body.memory_id,
          "rejected",
          "daemon:http",
          "manual reject",
          before ? JSON.stringify(before) : null,
          after ? JSON.stringify(after) : null,
        );
      }
      return send(res, ok ? 200 : 404, { success: ok });
    }

    // Record feedback
    if (path === "/feedback" && method === "POST") {
      const body = await parseBody(req);
      const id = recordFeedback(
        db,
        body.memory_id,
        body.session_id,
        body.injected,
        body.outcome,
      );
      createActivityEvent(db, {
        session_id: body.session_id,
        source: "daemon",
        event_type: "feedback",
        memory_ids: [body.memory_id],
        request: { injected: body.injected, outcome: body.outcome },
        result: { feedback_id: id },
      });
      return send(res, 200, { feedback_id: id });
    }

    // List memories
    if (path === "/memories" && method === "GET") {
      const repo = url.searchParams.get("repo") ?? undefined;
      const status = url.searchParams.get("status") as any;
      const limit = url.searchParams.get("limit");
      const offset = url.searchParams.get("offset");
      const items = queryMemories(db, {
        repo,
        status,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      });
      return send(res, 200, { memories: items });
    }

    // Get single memory
    if (path.startsWith("/memory/") && method === "GET") {
      const id = path.slice("/memory/".length);
      const mem = getMemory(db, id);
      if (!mem) return send(res, 404, { error: "not found" });
      return send(res, 200, mem);
    }

    // Scan repo
    if (path === "/scan" && method === "POST") {
      const body = await parseBody(req);
      const ids = scanAndStore(db, body.repo_path);
      const mem = ids[0] ? getMemory(db, ids[0]) : undefined;
      const artifact = writeRepoContextArtifact(db, {
        repo: mem?.repo ?? null,
        repo_path: body.repo_path,
      });
      createActivityEvent(db, {
        session_id: body.session_id ?? null,
        repo: mem?.repo ?? null,
        source: "daemon",
        event_type: "scan",
        memory_ids: ids,
        request: { repo_path: body.repo_path },
        result: {
          created: ids.length,
          artifact_path: artifact.output_path,
          artifact_written: artifact.written,
        },
      });
      return send(res, 200, {
        created: ids,
        count: ids.length,
        artifact_path: artifact.output_path,
        artifact_written: artifact.written,
      });
    }

    // --- Phase 2 endpoints ---

    // Eval metrics
    if (path === "/eval/metrics" && method === "GET") {
      const repo = url.searchParams.get("repo") ?? undefined;
      const since = url.searchParams.get("since") ?? undefined;
      const metrics = computeMetrics(db, { repo, since });
      return send(res, 200, metrics);
    }

    // Eval session start
    if (path === "/eval/start" && method === "POST") {
      const body = await parseBody(req);
      const id = startEvalSession(db, body.repo);
      return send(res, 200, { session_id: id });
    }

    // Eval session end
    if (path === "/eval/end" && method === "POST") {
      const body = await parseBody(req);
      endEvalSession(db, body.session_id);
      return send(res, 200, { success: true });
    }

    // Eval counter increment
    if (path === "/eval/increment" && method === "POST") {
      const body = await parseBody(req);
      incrementEvalCounter(db, body.session_id, body.field, body.amount ?? 1);
      return send(res, 200, { success: true });
    }

    // Record implicit signal
    if (path === "/signal" && method === "POST") {
      const body = await parseBody(req);
      const id = recordSignal(
        db,
        body.memory_id,
        body.session_id ?? "daemon",
        body.signal_type,
        body.context,
      );
      const mem = getMemory(db, body.memory_id);
      createActivityEvent(db, {
        session_id: body.session_id ?? "daemon",
        repo: mem?.repo ?? null,
        path: mem?.path_scope ?? null,
        source: "daemon",
        event_type: "signal",
        memory_ids: [body.memory_id],
        request: { signal_type: body.signal_type, context: body.context ?? null },
        result: { signal_id: id },
      });
      return send(res, 200, { signal_id: id });
    }

    // Signal stats
    if (path.startsWith("/signal/stats/") && method === "GET") {
      const memId = path.slice("/signal/stats/".length);
      const stats = getSignalStats(db, memId);
      return send(res, 200, stats);
    }

    // Run tests + record signals
    if (path === "/test" && method === "POST") {
      const body = await parseBody(req);
      const testResult = runTests(body.repo_path, body.command);
      const signalIds = recordTestSignals(
        db,
        body.session_id ?? "daemon",
        body.memory_ids ?? [],
        testResult,
      );
      return send(res, 200, {
        passed: testResult.passed,
        signals: signalIds,
        output: testResult.output?.slice(0, 1000),
      });
    }

    // Quality profile
    if (path === "/quality" && method === "GET") {
      const repo = url.searchParams.get("repo") ?? undefined;
      return send(res, 200, getRepoQualityProfile(db, repo));
    }

    if (path === "/activity" && method === "GET") {
      const repo = url.searchParams.get("repo") ?? undefined;
      const session_id = url.searchParams.get("session_id") ?? undefined;
      const source = url.searchParams.get("source") as any;
      const event_type = url.searchParams.get("event_type") as any;
      const since = url.searchParams.get("since") ?? undefined;
      const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
      return send(res, 200, {
        events: listActivityEvents(db, { repo, session_id, source, event_type, since, limit }),
      });
    }

    if (path === "/sessions" && method === "GET") {
      const repo = url.searchParams.get("repo") ?? undefined;
      const source = url.searchParams.get("source") as any;
      const event_type = url.searchParams.get("event_type") as any;
      const since = url.searchParams.get("since") ?? undefined;
      const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
      return send(res, 200, {
        sessions: listActivitySessions(db, { repo, source, event_type, since, limit }),
      });
    }

    // --- Phase 3 endpoints ---

    // Policy: list
    if (path === "/policy/list" && method === "GET") {
      const orgId = url.searchParams.get("org_id") ?? "";
      return send(res, 200, { policies: listPolicies(db, orgId) });
    }

    // Policy: create
    if (path === "/policy" && method === "POST") {
      const body = await parseBody(req);
      const id = createPolicy(db, body.org_id, body.rule_type, body.config);
      return send(res, 200, { policy_id: id });
    }

    // Policy: evaluate
    if (path === "/policy/check" && method === "POST") {
      const body = await parseBody(req);
      const mem = getMemory(db, body.memory_id);
      if (!mem) return send(res, 404, { error: "memory not found" });
      const violations = evaluatePolicy(db, body.org_id, mem);
      return send(res, 200, { violations });
    }

    // Approval: request
    if (path === "/approval/request" && method === "POST") {
      const body = await parseBody(req);
      const id = requestApproval(db, body.memory_id, body.org_id, body.requested_by ?? "daemon");
      return send(res, 200, { approval_id: id });
    }

    // Approval: list pending
    if (path === "/approval/pending" && method === "GET") {
      const orgId = url.searchParams.get("org_id") ?? "";
      return send(res, 200, { approvals: listPendingApprovals(db, orgId) });
    }

    // Approval: resolve
    if (path === "/approval/resolve" && method === "POST") {
      const body = await parseBody(req);
      const ok = resolveApproval(db, body.approval_id, body.status, body.reviewed_by ?? "daemon", body.reason);
      return send(res, ok ? 200 : 404, { success: ok });
    }

    // Health: single memory
    if (path.startsWith("/health/") && method === "GET") {
      const memId = path.slice("/health/".length);
      const score = computeHealthScore(db, memId);
      if (!score) return send(res, 404, { error: "not found" });
      return send(res, 200, score);
    }

    // Health: all
    if (path === "/health" && method === "GET") {
      const repo = url.searchParams.get("repo") ?? undefined;
      const scores = computeAllHealthScores(db, repo);
      return send(res, 200, { scores });
    }

    // Contradictions: detect
    if (path === "/contradictions/detect" && method === "POST") {
      const body = await parseBody(req);
      const found = detectContradictions(db, body.repo);
      return send(res, 200, { contradictions: found });
    }

    // Contradictions: list
    if (path === "/contradictions" && method === "GET") {
      const resolved = url.searchParams.get("resolved");
      const items = listContradictions(db, {
        resolved: resolved === "true" ? true : resolved === "false" ? false : undefined,
      });
      return send(res, 200, { contradictions: items });
    }

    // Contradictions: resolve
    if (path === "/contradictions/resolve" && method === "POST") {
      const body = await parseBody(req);
      const ok = resolveContradiction(db, body.contradiction_id, body.keep_memory_id, body.actor ?? "daemon", body.resolution);
      return send(res, ok ? 200 : 404, { success: ok });
    }

    // Contradictions: auto-resolve
    if (path === "/contradictions/auto-resolve" && method === "POST") {
      const body = await parseBody(req);
      const count = autoResolveContradictions(db, body.repo);
      return send(res, 200, { resolved: count });
    }

    // Prune
    if (path === "/prune" && method === "POST") {
      const body = await parseBody(req);
      const result = pruneMemories(db, body.config);
      return send(res, 200, result);
    }

    // Audit: trail for memory
    if (path.startsWith("/audit/memory/") && method === "GET") {
      const memId = path.slice("/audit/memory/".length);
      const entries = getAuditTrail(db, memId);
      return send(res, 200, { entries });
    }

    // Audit: recent
    if (path === "/audit/recent" && method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") ?? "50");
      const entries = getRecentAudit(db, limit);
      return send(res, 200, { entries });
    }

    // Audit: rollback
    if (path === "/audit/rollback" && method === "POST") {
      const body = await parseBody(req);
      const ok = rollbackMemory(db, body.memory_id, body.audit_entry_id, body.actor ?? "daemon");
      return send(res, ok ? 200 : 404, { success: ok });
    }

    send(res, 404, { error: "not found" });
  } catch (err: any) {
    send(res, 500, { error: err.message });
  }
});

function send(
  res: import("node:http").ServerResponse,
  status: number,
  data: any,
) {
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

async function startDaemon() {
  const backup = ensureDailyBackup();
  if (backup.created) {
    console.log(`[recall] backup created ${backup.created} (retained ${backup.retained.length})`);
  }

  db = initDb();

  server.listen(PORT, () => {
    console.log(`Recall daemon listening on http://localhost:${PORT}`);
    scheduleMaintenanceLoop();
    scheduleDispatcherLoop();
    scheduleCleanupLoop();
    scheduleQualitySnapshotLoop();

    setTimeout(() => {
      const embeddingConfig = loadEmbeddingConfigFromEnv();
      if (!embeddingConfig) return;

      const info = getEmbeddingModelInfo(embeddingConfig);
      if (info && !info.cached) {
        const approx = info.estimated_size_mb ? `~${info.estimated_size_mb}MB` : "download";
        console.log(`[recall] Fetching embedding model (one-time, ${approx}) -> ${info.cache_path}`);
      }
      void ensureEmbeddingProviderReady(embeddingConfig).catch((error: unknown) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        console.error(`[recall] embedding provider warmup failed: ${message}`);
      });
    }, 60_000).unref?.();
  });
}

void startDaemon().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[recall] daemon startup failed: ${message}`);
  process.exit(1);
});

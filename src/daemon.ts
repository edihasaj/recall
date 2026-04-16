import { createServer } from "node:http";
import { initDb } from "./db/client.js";
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
import { getAuditTrail, getRecentAudit, rollbackMemory } from "./audit/trail.js";
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

const db = initDb();
const PORT = parseInt(process.env.RECALL_PORT ?? "7890", 10);
const maintenanceConfig = loadMaintenanceConfigFromEnv();
let maintenanceRunning = false;

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
      const changed =
        result.prune_total +
        result.activity_pruned +
        result.feedback_pruned +
        result.signals_pruned +
        result.embeddings_refreshed +
        result.vector_rows_rebuilt +
        result.lexical_rows_rebuilt +
        result.history_snippets_created +
        result.history_embeddings_refreshed;

      if (
        changed > 0 ||
        result.vector_drift !== 0 ||
        result.lexical_drift !== 0 ||
        result.embedding_stale > 0 ||
        result.history_vector_drift !== 0 ||
        result.history_lexical_drift !== 0
      ) {
        console.log(
          `[recall] maintenance prune=${result.prune_total} activity=${result.activity_pruned} feedback=${result.feedback_pruned} signals=${result.signals_pruned} refreshed=${result.embeddings_refreshed} rebuilt(vec=${result.vector_rows_rebuilt},fts=${result.lexical_rows_rebuilt}) drift(vec=${result.vector_drift},fts=${result.lexical_drift}) stale=${result.embedding_stale} history(created=${result.history_snippets_created},refreshed=${result.history_embeddings_refreshed},drift_vec=${result.history_vector_drift},drift_fts=${result.history_lexical_drift})`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`[recall] maintenance failed: ${message}`);
    } finally {
      maintenanceRunning = false;
    }
  };

  void run();
  const timer = setInterval(() => {
    void run();
  }, Math.max(30, maintenanceConfig.interval_seconds) * 1000);
  timer.unref?.();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  // CORS for browser extension
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json");

  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    // Health
    if (path === "/health" && method === "GET") {
      return send(res, 200, {
        status: "ok",
        version: "0.5.0",
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
            query_text: body.query_text,
            config: body.config,
          })
        : compileContext(db, {
            repo,
            path: body.path,
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
      const ok = rejectMemory(db, body.memory_id);
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

scheduleMaintenanceLoop();

const embeddingConfig = loadEmbeddingConfigFromEnv();
if (embeddingConfig) {
  const info = getEmbeddingModelInfo(embeddingConfig);
  if (info && !info.cached) {
    const approx = info.estimated_size_mb ? `~${info.estimated_size_mb}MB` : "download";
    console.log(`[recall] Fetching embedding model (one-time, ${approx}) -> ${info.cache_path}`);
  }
  void ensureEmbeddingProviderReady(embeddingConfig).catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[recall] embedding provider warmup failed: ${message}`);
  });
}

function send(
  res: import("node:http").ServerResponse,
  status: number,
  data: any,
) {
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

server.listen(PORT, () => {
  console.log(`Recall daemon listening on http://localhost:${PORT}`);
});

import { createServer } from "node:http";
import { initDb } from "./db/client.js";
import { compileContext } from "./compiler/context.js";
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

const db = initDb();
const PORT = parseInt(process.env.RECALL_PORT ?? "7890", 10);

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
      return send(res, 200, { status: "ok", version: "0.2.0" });
    }

    // Compile context (hook injection endpoint)
    if (path === "/compile" && method === "POST") {
      const body = await parseBody(req);
      const result = compileContext(db, {
        repo: body.repo,
        path: body.path,
        config: body.config,
      });
      return send(res, 200, result);
    }

    // Report correction
    if (path === "/correct" && method === "POST") {
      const body = await parseBody(req);
      const ids = processCorrection(db, body.text, {
        sessionId: body.session_id ?? "hook",
        repo: body.repo,
        path: body.path,
      });
      return send(res, 200, { created: ids });
    }

    // Report review feedback
    if (path === "/review" && method === "POST") {
      const body = await parseBody(req);
      const ids = processReviewFeedback(db, body.feedback, {
        sessionId: body.session_id ?? "hook-review",
        repo: body.repo,
        path: body.path,
        reviewer: body.reviewer,
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
      return send(res, 200, { feedback_id: id });
    }

    // List memories
    if (path === "/memories" && method === "GET") {
      const repo = url.searchParams.get("repo") ?? undefined;
      const status = url.searchParams.get("status") as any;
      const items = queryMemories(db, { repo, status });
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
      return send(res, 200, { created: ids, count: ids.length });
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

server.listen(PORT, () => {
  console.log(`Recall daemon listening on http://localhost:${PORT}`);
});

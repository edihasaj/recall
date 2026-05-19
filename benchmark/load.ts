/**
 * Load shape harness for Recall's daemon. Dependency-free.
 *
 * Records per-request latency with `performance.now()` and writes a
 * JSON report per run. Modeled on agentmemory/benchmark/load-100k.ts;
 * adapted to Recall's MCP-first REST surface (see ./README.md for the
 * mapping table).
 *
 * Prereqs:
 *   1. `npm run build`
 *   2. Seed: `npx tsx benchmark/seed.ts --count <max BENCH_N> --data-dir ~/.recall-demo`
 *   3. Daemon: `RECALL_DATA_DIR=~/.recall-demo node dist/daemon.js`
 *
 * Run:
 *   npx tsx benchmark/load.ts
 *
 * Env knobs:
 *   BENCH_N        comma-list of memory counts to assume seeded   (default "1000,10000")
 *   BENCH_C        comma-list of concurrency levels               (default "1,10,100")
 *   BENCH_OPS      ops per cell                                   (default 200)
 *   BENCH_OUT_DIR  output directory for JSON reports              (default benchmark/results)
 *   RECALL_PORT    daemon port                                    (default 7890)
 *   BENCH_REPO     repo slug to query against (must exist)        (default "demo")
 */
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PORT = process.env.RECALL_PORT ?? "7890";
const BASE = `http://localhost:${PORT}`;
const N_LIST = (process.env.BENCH_N ?? "1000,10000").split(",").map((s) => parseInt(s.trim(), 10));
const C_LIST = (process.env.BENCH_C ?? "1,10,100").split(",").map((s) => parseInt(s.trim(), 10));
const OPS = parseInt(process.env.BENCH_OPS ?? "200", 10);
const OUT_DIR = process.env.BENCH_OUT_DIR ?? "benchmark/results";
const REPO = process.env.BENCH_REPO ?? "demo";

interface Endpoint {
  name: string;
  method: "GET" | "POST";
  path: string;
  body?: (i: number) => unknown;
}

const QUERY_TEXTS = [
  "react state management",
  "vitest setup",
  "drizzle migrations",
  "auth flow",
  "form validation with zod",
];

const ENDPOINTS: Endpoint[] = [
  {
    name: "POST /compile",
    method: "POST",
    path: "/compile",
    body: (i) => ({
      repo: REPO,
      query_text: QUERY_TEXTS[i % QUERY_TEXTS.length],
      config: { include_candidates: true },
    }),
  },
  {
    name: "POST /graph/query",
    method: "POST",
    path: "/graph/query",
    body: () => ({ repo: REPO, limit: 20 }),
  },
  {
    name: "GET /memories",
    method: "GET",
    path: "/memories?latest=true&limit=20",
  },
];

interface CellResult {
  endpoint: string;
  N: number;
  C: number;
  ops: number;
  errors: number;
  p50_ms: number;
  p90_ms: number;
  p99_ms: number;
  min_ms: number;
  max_ms: number;
  throughput_per_sec: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank, matches agentmemory's harness.
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function callOnce(ep: Endpoint, i: number): Promise<number> {
  const t0 = performance.now();
  const init: RequestInit = { method: ep.method };
  if (ep.method === "POST") {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(ep.body!(i));
  }
  const r = await fetch(BASE + ep.path, init);
  // Drain body to keep apples-to-apples with agentmemory's harness.
  await r.arrayBuffer();
  if (!r.ok) throw new Error(`${ep.name} -> HTTP ${r.status}`);
  return performance.now() - t0;
}

async function runCell(ep: Endpoint, N: number, C: number): Promise<CellResult> {
  const samples: number[] = [];
  let errors = 0;
  let issued = 0;
  const start = performance.now();

  async function worker() {
    while (true) {
      const i = issued++;
      if (i >= OPS) return;
      try {
        samples.push(await callOnce(ep, i));
      } catch {
        errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: C }, () => worker()));
  const wallSec = (performance.now() - start) / 1000;
  samples.sort((a, b) => a - b);

  return {
    endpoint: ep.name,
    N,
    C,
    ops: samples.length,
    errors,
    p50_ms: +percentile(samples, 50).toFixed(3),
    p90_ms: +percentile(samples, 90).toFixed(3),
    p99_ms: +percentile(samples, 99).toFixed(3),
    min_ms: +(samples[0] ?? 0).toFixed(3),
    max_ms: +(samples[samples.length - 1] ?? 0).toFixed(3),
    throughput_per_sec: +(samples.length / wallSec).toFixed(2),
  };
}

async function healthcheck() {
  try {
    const r = await fetch(BASE + "/health");
    if (!r.ok) throw new Error(`health -> HTTP ${r.status}`);
  } catch (e) {
    console.error(`✗ daemon not reachable at ${BASE}. Start it first.`);
    console.error(`  RECALL_DATA_DIR=~/.recall-demo node dist/cli.js daemon`);
    throw e;
  }
}

function gitShortSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

async function main() {
  await healthcheck();
  const results: CellResult[] = [];
  for (const N of N_LIST) {
    console.log(`\n=== N = ${N} (assumed seeded) ===`);
    for (const C of C_LIST) {
      for (const ep of ENDPOINTS) {
        process.stdout.write(`  C=${String(C).padStart(3)} ${ep.name.padEnd(20)} ... `);
        const cell = await runCell(ep, N, C);
        results.push(cell);
        console.log(
          `p50=${cell.p50_ms}ms p90=${cell.p90_ms}ms p99=${cell.p99_ms}ms ` +
            `tput=${cell.throughput_per_sec}/s errors=${cell.errors}`,
        );
      }
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const sha = gitShortSha();
  const out = join(OUT_DIR, `load-${sha}-${Date.now()}.json`);
  writeFileSync(
    out,
    JSON.stringify(
      {
        sha,
        port: PORT,
        ops_per_cell: OPS,
        repo: REPO,
        ts: new Date().toISOString(),
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\n→ ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

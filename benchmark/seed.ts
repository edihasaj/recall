/**
 * Seed an isolated Recall DB with synthetic memories + graph relations.
 *
 * Use cases:
 *   1. Fixture data for the load harness (`load.ts`).
 *   2. Rich graph for the demo recording (`scripts/record-demo.sh`).
 *
 * Does NOT touch your real `~/.recall`. Pass `--data-dir` or set
 * `RECALL_DATA_DIR` to control where the DB lands. Default:
 * `~/.recall-demo`.
 *
 * Usage:
 *   npx tsx benchmark/seed.ts --count 1000 --data-dir ~/.recall-demo
 */
import { join } from "node:path";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { initDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";
import { ingestMemoryHeuristic } from "../src/graph/ingest.js";

interface Args {
  count: number;
  dataDir: string;
  reset: boolean;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    count: 1000,
    dataDir:
      process.env.RECALL_DATA_DIR ??
      join(process.env.HOME ?? ".", ".recall-demo"),
    reset: false,
    seed: 1,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--count") out.count = parseInt(argv[++i] ?? "0", 10);
    else if (a === "--data-dir") out.dataDir = argv[++i] ?? out.dataDir;
    else if (a === "--reset") out.reset = true;
    else if (a === "--seed") out.seed = parseInt(argv[++i] ?? "1", 10);
  }
  if (!Number.isFinite(out.count) || out.count <= 0) {
    throw new Error(`bad --count: ${out.count}`);
  }
  return out;
}

// Deterministic PRNG so seed=1 always produces the same corpus.
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAMEWORKS = ["react", "vue", "svelte", "solid", "qwik", "angular"];
const TOOLS = ["vitest", "jest", "playwright", "cypress", "drizzle", "prisma", "zod", "trpc"];
const VERBS = ["use", "prefer", "avoid", "never", "always"];
const TOPICS = ["state management", "form validation", "testing", "data fetching", "auth", "routing"];
const REPOS = ["demo", "alpha", "beta", "gamma"];

function pick<T>(rng: () => number, xs: T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

function synthText(rng: () => number, i: number): string {
  const verb = pick(rng, VERBS);
  const tool = pick(rng, TOOLS);
  const fw = pick(rng, FRAMEWORKS);
  const topic = pick(rng, TOPICS);
  // Reference `tool` and `fw` in backticks so the heuristic graph
  // extractor picks them up as entities.
  return `${verb} \`${tool}\` for ${topic} in \`${fw}\` projects (#${i}).`;
}

function main() {
  const args = parseArgs(process.argv);
  mkdirSync(args.dataDir, { recursive: true });
  const dbPath = join(args.dataDir, "recall.db");
  if (args.reset && existsSync(dbPath)) {
    rmSync(dbPath);
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }

  // Make sure downstream code (incl. anything we import) sees the same dir.
  process.env.RECALL_DATA_DIR = args.dataDir;
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";

  const db = initDb(dbPath);
  const rng = mulberry32(args.seed);

  const writeStart = performance.now();
  let created = 0;
  let ingestMs = 0;
  for (let i = 0; i < args.count; i++) {
    const text = synthText(rng, i);
    const repo = pick(rng, REPOS);
    const id = createMemory(db, {
      type: "rule",
      text,
      scope: "repo",
      repo,
      source: "repo_scan",
      confidence: 0.6 + rng() * 0.3,
      dedupe: false,
    });
    const t = performance.now();
    ingestMemoryHeuristic(db, { id, text, repo });
    ingestMs += performance.now() - t;
    created++;
  }
  const totalMs = performance.now() - writeStart;

  console.log(
    JSON.stringify(
      {
        data_dir: args.dataDir,
        db_path: dbPath,
        count: created,
        seed: args.seed,
        total_ms: Math.round(totalMs),
        avg_write_ms: +(totalMs / created).toFixed(3),
        avg_graph_ingest_ms: +(ingestMs / created).toFixed(3),
      },
      null,
      2,
    ),
  );
}

main();

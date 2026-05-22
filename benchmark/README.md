# benchmark/

Load shape + comparison harness for Recall.

Inspired by `agentmemory/benchmark/load-100k.ts` (https://github.com/rohitg00/agentmemory),
adapted to Recall's daemon surface.

## Recall vs agentmemory — headline

LongMemEval-S, N=500 non-abstention. Same dataset agentmemory publishes.

| System | R@5 | R@10 | R@20 | NDCG@10 | MRR |
|---|---|---|---|---|---|
| agentmemory BM25 + vector | 95.2 % | 98.6 % | 99.4 % | 87.9 | 88.2 |
| **Recall (Tier 1 shipped)** | **97.4 %** | **99.4 %** | **99.6 %** | **90.1** | **89.5** |

Full numbers, per-type breakdown, ablation, and methodology → [`COMPARISON.md`](COMPARISON.md).

## Files

- `seed.ts` — Seeds N memories into an isolated SQLite DB. Used as a
  fixture for both the load harness and the demo recording so neither
  touches your real `~/.recall`.
- `load.ts` — Dependency-free p50/p90/p99 latency harness. Hits a
  running Recall daemon at `http://localhost:${RECALL_PORT}` (default
  `7890`) and writes a JSON report to `benchmark/results/`.
- `COMPARISON.md` — Side-by-side numbers vs agentmemory once both
  daemons have been run on the same matrix.

## Quick start

```bash
# 1) Build the daemon (needed for direct imports)
npm run build

# 2) Seed an isolated demo DB (default: ~/.recall-demo)
RECALL_DATA_DIR=~/.recall-demo \
  npx tsx benchmark/seed.ts --count 1000

# 3) Start the daemon against that same DB in another shell
RECALL_DATA_DIR=~/.recall-demo node dist/cli.js daemon

# 4) Run the load matrix
npx tsx benchmark/load.ts
```

## Tunables

Same convention as agentmemory's harness:

- `BENCH_N` — comma-separated seed sizes (default `1000,10000`).
- `BENCH_C` — comma-separated concurrency levels (default `1,10,100`).
- `BENCH_OPS` — ops per cell (default `200`).
- `BENCH_OUT_DIR` — JSON output dir (default `benchmark/results/`).
- `RECALL_PORT` — daemon port (default `7890`).

## Endpoints under test

Recall is MCP-first, so its REST surface differs from agentmemory's:

| Concern        | agentmemory                    | Recall (this harness)       |
|----------------|--------------------------------|-----------------------------|
| read (search)  | `POST /agentmemory/smart-search` | `POST /compile`           |
| graph traverse | n/a                            | `POST /graph/query`         |
| list latest    | `GET /agentmemory/memories?latest=true` | `GET /memories?latest=true` |
| write          | `POST /agentmemory/remember`   | direct `createMemory` (no REST) |

Write latency is therefore measured in-process, not over HTTP, so the
write numbers are a floor — production callers add MCP/IPC overhead on
top.

## Why p99

p50 says the median feels fast. p90 says the bulk feels fast. **p99
says the tail user feels fast.** Capacity planning and SLOs live at
p99; p50 will lie to you.

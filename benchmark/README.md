# benchmark/

Benchmarks and load tests for Recall. Raw datasets, prepared inputs and model
outputs are written to `benchmark/data/`, which is kept out of the repository.

| Benchmark | Headline | Details |
| --- | --- | --- |
| LongMemEval-S answer accuracy | **474/500 (94.8%)**, best of two runs | [LONGMEMEVAL.md](LONGMEMEVAL.md) |
| LongMemEval-S retrieval vs agentmemory | **99.4%** R@10 with multilingual-e5-small | [COMPARISON.md](COMPARISON.md) |
| Temporal memory | Store works on structured facts; automatic capture stays off | [TEMPORAL.md](TEMPORAL.md) |
| Load and latency | p50/p90/p99 per endpoint | below |

## LongMemEval retrieval rankings

`longmemeval.ts` builds a disposable Recall index per question and writes the
top 20 sessions, with their exact positions in the original history, for the
answer harness and the retrieval comparison:

```bash
RECALL_EMBEDDING_PROVIDER=multilingual-e5 \
RECALL_HYBRID_MIN_SIM=0 RECALL_SIMILARITY_THRESHOLD=0 RECALL_FTS_MODE=or \
node --import tsx benchmark/longmemeval.ts \
  --cache-embeddings \
  --out benchmark/data/longmemeval-fresh-e5.json
```

`--cache-embeddings` reuses vectors for identical session text within one run.
`--out` must be a new path; the run also writes a `.jsonl` record stream and a
`.progress.json` snapshot, and only a report with `status: "complete"` should
be used as input.

## Load harness

- `seed.ts` seeds N memories into an isolated SQLite database, so neither the
  load harness nor demo recordings touch your real `~/.recall`.
- `load.ts` is a dependency-free p50/p90/p99 latency harness. It calls a
  running Recall daemon at `http://localhost:${RECALL_PORT}` (default `7890`)
  and writes a JSON report to `benchmark/results/`.

It is adapted from
[agentmemory's load harness](https://github.com/rohitg00/agentmemory).

### Quick start

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

### Tunables

- `BENCH_N`: comma-separated seed sizes (default `1000,10000`).
- `BENCH_C`: comma-separated concurrency levels (default `1,10,100`).
- `BENCH_OPS`: operations per cell (default `200`).
- `BENCH_OUT_DIR`: JSON output directory (default `benchmark/results/`).
- `RECALL_PORT`: daemon port (default `7890`).

### Endpoints under test

Recall is MCP-first, so its REST surface differs from agentmemory's:

| Concern        | agentmemory                    | Recall (this harness)       |
|----------------|--------------------------------|-----------------------------|
| read (search)  | `POST /agentmemory/smart-search` | `POST /compile`           |
| graph traverse | n/a                            | `POST /graph/query`         |
| list latest    | `GET /agentmemory/memories?latest=true` | `GET /memories?latest=true` |
| write          | `POST /agentmemory/remember`   | direct `createMemory` (no REST) |

Write latency is measured in-process, not over HTTP, so the write numbers are
a floor; production callers add MCP or IPC overhead on top.

The harness reports p99 because capacity planning and service targets depend
on the slowest requests: p50 shows the typical request, while p99 shows what
the unluckiest user experiences.

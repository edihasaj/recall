# Recall vs agentmemory — load shape

Side-by-side latency under the same `(N, concurrency, ops)` matrix as
[`rohitg00/agentmemory`](https://github.com/rohitg00/agentmemory)'s
`benchmark/load-100k.ts`.

> Numbers below are **placeholders**. Run both harnesses on the same
> machine and replace the tables. See *Methodology* for the steps.

## Mapping

Recall is MCP-first; agentmemory is REST-first. The harness pairs the
closest semantic operations on each side:

| Operation        | agentmemory                                | Recall                                |
|------------------|--------------------------------------------|---------------------------------------|
| smart search     | `POST /agentmemory/smart-search`           | `POST /compile` (with `query_text`)   |
| list memories    | `GET  /agentmemory/memories?latest=true`   | `GET  /memories?latest=true`          |
| graph traverse   | n/a (no first-class graph endpoint)        | `POST /graph/query`                   |
| capture/remember | `POST /agentmemory/remember`               | direct in-process `createMemory`*     |

\* Recall has no REST capture endpoint — captures flow through MCP or
the CLI. We measure the in-process write floor and call it out next to
agentmemory's HTTP write number; the comparison is approximate, not
apples-to-apples.

## Methodology

```bash
# Recall side
git -C ~/Projects/recall pull && npm -C ~/Projects/recall run build
RECALL_DATA_DIR=~/.recall-demo \
  npx tsx ~/Projects/recall/benchmark/seed.ts \
    --count 10000 --reset --data-dir ~/.recall-demo
RECALL_DATA_DIR=~/.recall-demo node ~/Projects/recall/dist/daemon.js &
BENCH_N=1000,10000 BENCH_C=1,10,100 BENCH_OPS=200 \
  npx tsx ~/Projects/recall/benchmark/load.ts

# agentmemory side (clone under ~/Projects/oss/agentmemory)
cd ~/Projects/oss/agentmemory && npm install && npm run build
npx @agentmemory/agentmemory &
BENCH_N=1000,10000 BENCH_C=1,10,100 BENCH_OPS=200 npm run bench:load
```

Hardware/runtime context to fill in once the runs land:

- Host:
- CPU / RAM:
- Node version:
- Recall sha:
- agentmemory version:

## Results (placeholder)

### N = 10,000 · C = 100 · ops = 200

| Endpoint                                | Recall p50 | Recall p99 | agentmemory p50 | agentmemory p99 |
|-----------------------------------------|------------|------------|-----------------|-----------------|
| smart-search / compile                  | —          | —          | —               | —               |
| list latest                             | —          | —          | —               | —               |
| graph traverse / smart-search w/ graph  | —          | —          | —               | —               |

### Tail (p99) growth with N

| N        | Recall `/compile` p99 | agentmemory smart-search p99 |
|----------|-----------------------|------------------------------|
| 1,000    | —                     | —                            |
| 10,000   | —                     | —                            |
| 100,000  | —                     | —                            |

## Caveats

1. Recall's `compile` is a richer operation than agentmemory's
   `smart-search` (it ranks, dedupes, injects history, optionally
   triggers bootstrap). Recall p99 will look worse on a like-for-like
   read; the win is in fewer round-trips per agent turn.
2. agentmemory's write path includes embedding generation on the hot
   path by default; Recall's write seeds graph relations synchronously
   but defers embeddings to a queue. Be careful comparing capture
   numbers without normalizing.
3. Both harnesses use nearest-rank percentiles; sample sizes (`BENCH_OPS`)
   must match between runs for the tail numbers to be comparable.

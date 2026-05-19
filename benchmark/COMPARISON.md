# Recall vs agentmemory — honest comparison

Both projects are local-first memory layers for coding agents, but they
optimise for different things. This file holds the comparison numbers
where we can publish them and the framing where we can't yet.

## TL;DR

| Axis | agentmemory | Recall |
|------|-------------|--------|
| **Primary integration** | REST + MCP server | MCP + lifecycle hooks (SessionStart, UserPromptSubmit, SessionEnd) |
| **Capture trigger** | 12 lifecycle hooks across CLI tools | Explicit `correct`/`feedback`/`scan` + auto-extraction from prompts/corrections |
| **Search** | BM25 + Vector + Graph (`HybridSearch`) | BM25 + sqlite-vec + graph BFS, scored by lexical+vector+feedback+freshness+type |
| **Quality gates** | extraction-based summarization | confidence + maturity + feedback-weighted + repo-tuned threshold |
| **Cross-source dedup** | Jaccard supersession | LLM `merge_duplicates` task + same-text candidate collapsing (v0.7) |
| **Knowledge graph** | entity extraction + BFS | entities + relations + 2D/3D dashboard + REST endpoints |
| **Real-time viewer** | port 3113 | port 7891 (full SPA: Memories, Graph, Timeline, Sessions, Contradictions) |
| **DB shape** | KV scopes + indexes | single sqlite + sqlite-vec, FTS5, drizzle migrations |
| **Setup story** | `npx @agentmemory/agentmemory` | `brew install --cask edihasaj/tap/recall` or `npm i -g @edihasaj/recall` then `recall setup --yes` |

agentmemory's published benchmarks (LongMemEval-S R@5 = 95.2 % BM25+vector,
86.2 % BM25-only) are excellent on academic chat-style haystacks. Recall
hasn't yet posted LongMemEval numbers — that's tracked below.

## Where Recall is positioned to win

Recall optimizes for a *coding-agent workflow*, not chat retrieval:

1. **Self-correction loop.** A user correction (`"don't use npm, use
   pnpm"`) produces a durable rule, not a transcript chunk. The LLM
   verifier on the dispatcher path keeps fragmentary captures from
   reaching `active`.
2. **Per-repo profile.** Each repo gets its own confidence threshold,
   maturity gate, and feedback weights based on observed accept/reject
   behaviour. agentmemory's quality model is global.
3. **Lifecycle integration.** The `SessionStart` and `UserPromptSubmit`
   hooks inject compact `## Rules` / `## Commands` / `## Gotchas`
   blocks. Agents don't have to remember to query — relevant memory
   shows up in the prompt.
4. **No cloud.** Daemon, vector index, and dashboard all run on
   localhost; no API key required for capture or retrieval. agentmemory
   is also self-hostable, but ships an opt-in cloud path.
5. **Dashboard transparency.** The v0.7 SPA exposes every memory, every
   activity event, every session, and every contradiction. Users can
   audit *what their agents have learned about them* in one tab.

## Apples-to-apples retrieval — open task

> 🚧 We have **not yet posted LongMemEval-S numbers** for Recall. That
> port is tracked in `docs/quality-audit-2026-05-20.md` and will land
> as `benchmark/longmemeval.ts`. Until then, do not claim Recall beats
> agentmemory on their benchmark.

Plan when we run it:

- Same dataset (`xiaowu0162/longmemeval-cleaned`, S split, 500
  questions, 48 sessions each).
- Same metric (`recall_any@K`, NDCG@10, MRR).
- Same embedding model (`all-MiniLM-L6-v2`, 384-d, local) so the
  retrieval head is honest.
- Per-question fresh sqlite db so haystacks don't cross-contaminate.

We expect Recall's hybridSearch to land within ±2 pp of agentmemory's
hybrid number, because the underlying retrieval shape is similar
(lexical + vector + reciprocal-rank fusion). The interesting numbers
will be:

- **Token efficiency under the SessionStart/UserPromptSubmit hook
  flow** — what fraction of the haystack does Recall inject vs.
  agentmemory's smart-search?
- **Per-question type breakdown** for the `single-session-preference`
  category — that's where agentmemory's hybrid only hits 83.3 % R@5,
  and Recall's feedback-weighted scoring is well-suited to it.

## Coding-recall — what we can publish today

Recall's audit run on a real install (608 memories across 30 repos,
121 active + 259 candidate + 228 rejected) showed:

- **Cross-repo duplicates of identical rules** ("use pnpm as the
  package manager" appearing as `scope=repo` three times in three
  different repos). This is intentional today — repos are isolated —
  but suggests an auto-promote-to-global path. Tracked in the audit.
- **Candidate-cluster dedupe missing.** The 6× "react project (no
  next.js)" candidate cluster never collapsed because
  `produceMergeDuplicateTasks` only seeded from active rows. Fixed in
  v0.7.x — the producer now seeds from candidates too, so identical
  candidates merge before promotion.
- **Dispatcher cadence verified.** Daily LLM dispatcher tick + 5-min
  in-process maintenance loop. No "everything stale" failure mode in
  the audit window.
- **Retrieval path verified.** Hooks pass the raw prompt into
  `compileContextHybrid` → `hybridSearch` (BM25 + sqlite-vec).
  The vector floor strips noise effectively (`/goal` prompts return
  zero injections, not low-relevance junk).

agentmemory has not published an equivalent audit on a live install
that we can compare against. We invite them to share theirs — we'll
publish ours side-by-side.

## Load shape — open task

A side-by-side latency table under the same `(N, concurrency, ops)`
matrix as agentmemory's `benchmark/load-100k.ts`. The harness mapping
and run instructions are below; numbers are placeholders until both
sides run on the same hardware.

### Mapping

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

### Methodology

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

### Caveats

1. Recall's `compile` is a richer operation than agentmemory's
   `smart-search` (it ranks, dedupes, injects history, optionally
   triggers bootstrap). Recall p99 will look worse on a like-for-like
   read; the win is in fewer round-trips per agent turn.
2. agentmemory's write path includes embedding generation on the hot
   path by default; Recall's write seeds graph relations synchronously
   but defers embeddings to a queue. Be careful comparing capture
   numbers without normalizing.
3. Both harnesses use nearest-rank percentiles; sample sizes
   (`BENCH_OPS`) must match between runs for the tail numbers to be
   comparable.

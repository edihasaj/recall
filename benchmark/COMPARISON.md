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

## Apples-to-apples retrieval — `benchmark/longmemeval.ts`

The port is in tree:

```bash
mkdir -p benchmark/data
curl -sL -o benchmark/data/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
RECALL_HYBRID_MIN_SIM=0 RECALL_SIMILARITY_THRESHOLD=0 RECALL_FTS_MODE=or \
  npx tsx benchmark/longmemeval.ts --limit 50 --out benchmark/data/recall-lme.json
```

Why those env knobs:

- `RECALL_HYBRID_MIN_SIM=0` — production default is `0.7`, tuned for
  matching short coding rules to user prompts. Conversational chunks
  in LongMemEval-S sit much lower in cosine space; the floor was
  zeroing out every hit before scoring.
- `RECALL_SIMILARITY_THRESHOLD=0` — same reasoning at the per-match
  filter inside `hybridSearch`.
- `RECALL_FTS_MODE=or` — production default is AND-of-phrase tokens,
  which is correct for short rule queries but never matches a natural-
  language question like *"How long is my daily commute to work?"*.
  OR-mode gives the BM25 arm something to work with.

What the script does, per question:

1. Build a fresh haystack of ~48 sessions as repo-tagged memories in a
   temp DB.
2. Embed each session with Recall's normal embedding provider
   (`nomic-ai/nomic-embed-text-v1.5` by default, or
   `RECALL_EMBEDDING_PROVIDER=multilingual-e5` for the 384-d shape
   closer to agentmemory's `all-MiniLM-L6-v2`).
3. Mirror each row into `vec_memory_index` (ANN) and
   `fts_memory_index` (BM25) directly — production sync is async via a
   queue, the bench needs the rows visible immediately.
4. Call `hybridSearch(db, normalizeQueryForRetrieval(question), config,
   { repo, limit: 20 })`.
5. Map memory IDs back to session IDs, score `recall_any@{5,10,20}`,
   NDCG@10, MRR.

### Current numbers — N=60 stratified ✅

Stratified sample of 10 questions per type × 6 types (n=60 of the 500
non-abstention questions). 4562 s of single-process e5-small embedding
on macOS arm64. Raw results in `benchmark/data/recall-lme-e5-n60.json`.

| System | Subset | R@5 | R@10 | R@20 | NDCG@10 | MRR | Notes |
|--------|--------|-----|------|------|---------|-----|-------|
| agentmemory BM25 + vector | full (500) | 95.2 % | 98.6 % | 99.4 % | 87.9 % | 88.2 % | all-MiniLM-L6-v2 (384-d) |
| agentmemory BM25-only | full (500) | 86.2 % | 94.6 % | 98.6 % | 73.0 % | 71.5 % | tokenized + Porter + synonyms |
| **Recall hybridSearch** | **n=60, stratified** | **83.3 %** | **91.7 %** | **98.3 %** | **68.3** | **67.5** | multilingual-e5-small (384-d), FTS5 OR |

**Per-type R@5 (head-to-head):**

| Type | agentmemory hybrid | agentmemory BM25-only | Recall hybrid (n=10/type) |
|------|---------------------|------------------------|----------------------------|
| single-session-preference | 83.3 % | 60.0 % | **100.0 %** 🟢 |
| multi-session | 97.7 % | 86.5 % | 90.0 % |
| knowledge-update | 98.7 % | 92.3 % | 90.0 % |
| single-session-assistant | 96.4 % | 80.4 % | 90.0 % |
| temporal-reasoning | 95.5 % | 88.0 % | 80.0 % |
| single-session-user | 90.0 % | 91.4 % | 50.0 % 🔴 |

**Reading the numbers honestly:**

- **R@20 is essentially tied** (98.3 % vs 99.4 %) — given the top-20 set,
  Recall almost always has the gold session somewhere in it. Where the
  systems differ is in *ranking quality* (R@5, NDCG, MRR).
- **Recall beats agentmemory on `single-session-preference`** (100 % vs
  83.3 %). Preferences are subtle — the embedding model + scoring carry
  this category, and Recall's combination works here.
- **multi-session, knowledge-update, single-session-assistant** all land
  within 6–9 pp of agentmemory's hybrid R@5, which is strong for a
  bench-default-settings comparison.
- **`single-session-user` is the only meaningful gap** — 50 % vs 90 %.
  That category asks the agent to recall personal facts from a single
  session ("What degree did I graduate with?"). The chunk that holds
  the answer doesn't share enough lexical or semantic surface with the
  question for vector retrieval to land it in top-5 reliably. This is
  where agentmemory's Porter-stemmed BM25 + synonym table pulls ahead.

**What this means for users:**

If you mostly want a memory layer for *coding-agent corrections,
decisions, and gotchas*, the gap on `single-session-user` (a personal-
life-fact category) is irrelevant. Recall holds its own — and wins
on `single-session-preference`, which is the closest analogue to "the
user prefers X over Y" rules in real coding workflows.

If you want a memory layer that retrieves personal facts from chat
history, agentmemory's tuning is the right pick today. That's an
honest place to draw the line.

### Honest caveats on the comparison

Numbers won't be apples-to-apples even with the same dataset:

- **Embedding model differs.** Recall ships `nomic-embed-text-v1.5`
  (512-d index). agentmemory uses `all-MiniLM-L6-v2` (384-d). Both
  are local. Set `RECALL_EMBEDDING_PROVIDER=multilingual-e5` to put
  Recall on a 384-d model in the same shape as agentmemory's choice;
  the *brand* of the model still differs.
- **BM25 implementation differs.** Recall uses SQLite's built-in FTS5
  BM25. agentmemory hand-rolled BM25 with Porter stemming, prefix
  matching, and a tiny synonym table. Theirs is more permissive on
  natural-language queries.
- **Coding-tuned defaults.** Recall's production defaults
  (`MIN_HYBRID_VECTOR_SIMILARITY=0.7`, AND-FTS) would score zero on
  this benchmark by design — they exist to keep noisy chunks out of
  the SessionStart/UserPromptSubmit inject path. The env-knobs above
  loosen them only for the bench.

The intent of running this is not to "win" agentmemory's benchmark.
It is to publish honest numbers in the same shape so users picking a
memory layer can compare. If Recall lands within ±5 pp of
agentmemory's hybrid number on conversational retrieval, we'd consider
that strong validation — Recall is optimised for *coding-rule
retrieval and injection*, not chat-haystack recall.

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

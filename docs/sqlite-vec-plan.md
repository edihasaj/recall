---
summary: "Plan for adopting sqlite-vec in Recall for local vector retrieval while keeping SQLite as the canonical store."
read_when:
  - Planning vector retrieval in Recall with sqlite-vec instead of an external vector DB.
  - Wiring semantic ranking into compile/query without changing Recall's source-of-truth model.
  - Deciding how to scale local retrieval as memory/history volume grows.
---

# sqlite-vec Plan

## Decision

Use `sqlite-vec` as Recall's vector retrieval layer.

Keep plain SQLite as the canonical store for:

- memories
- evidence
- feedback
- audit trail
- activity/session logs
- sync state

Use `sqlite-vec` for:

- semantic candidate generation
- semantic reranking inputs
- future history/snippet retrieval

This matches Recall's local-first packaging and avoids adding a separate vector service.

## Why This Direction

Current Recall already has embeddings support, but it is not in the main query path:

- embeddings are optional (`EmbeddingConfig.enabled` defaults `false`)
- current compile/query path is mostly exact filter + confidence sort
- no ANN-style vector index
- semantic search (`recall search`) is brute-force: loads all memories into JS, computes cosine similarity in a loop
- no semantic reranking in `compileContext`

Today this means Recall gets weaker as:

- memory count grows
- wording drifts from the original phrasing
- more "soft" decisions and review patterns accumulate
- session history gets longer

`sqlite-vec` gives us local vector search without changing the app's operating model.

## Product Goal

Make retrieval hybrid, not vector-only.

Target flow:

1. hard filter by repo / scope / status
2. lexical match for exact or near-exact rules
3. vector search for semantic similarity
4. rerank with confidence, freshness, scope match, type priority
5. inject a conservative final pack

Accuracy comes from hybrid ranking plus gating, not from vectors alone.

## Non-Goals

- moving canonical memory out of SQLite
- making vector similarity the only ranking signal
- injecting low-confidence semantic matches aggressively
- blending hard rules and soft session history into one undifferentiated pool
- adding a separate networked vector DB
- changing compile behavior for `candidate` memories without explicit eval gating

## Current State

This plan is mostly implemented now.

Shipped:

- clean `initial_migration`
- canonical `memory_embeddings`
- `sqlite-vec` lane for durable memories
- `FTS5` lane for durable memories
- repo-first hybrid compile/query path
- candidate opt-in for hybrid compile/query
- pagination in memory query/list paths
- repo-scoped prune
- semantic dedup wired into correction/review capture
- daemon maintenance timer
- TTL cleanup for activity / feedback / implicit signals
- SQLite maintenance ops:
  - `ANALYZE`
  - WAL checkpoint
  - `PRAGMA optimize`
  - guarded `VACUUM`
- separate `history_snippets` lane
- history lexical + vector retrieval
- session rollup into history snippets
- repo-level history summarize
- cleanup of old covered session summaries
- retrieval eval harness with fixture files

Still polish / follow-up territory:

- add more real retrieval-eval fixture files for important repos
- decide whether low-trust history should participate more directly in compile injection
- optional path bucketing if eval shows it helps

## Proposed Architecture

### 1. Canonical Tables Stay Normal

Keep `memories` as the source of truth.

We are not planning an in-place migration path for old local DBs.

Decision:

- one clean `initial_migration`
- full local DB reset on rollout
- fresh schema only
- no legacy compatibility layer
- no inline embedding carry-forward

Add metadata needed for durable embedding management (via the new `memory_embeddings` table, not inline):

- `embedding_model`
- `embedding_dimensions`
- `embedding_updated_at`
- `embedding_version`
- `content_hash` (detect stale embeddings after text edits)
- optional `embedding_enabled` or `embedding_state`

This schema should be defined cleanly from day one rather than through transitional columns and compatibility logic.

Keep the raw memory text in canonical SQLite tables.

### 2. Add Derived Vector Index

Introduce a derived vector index powered by `sqlite-vec`.

Recommended shape:

- canonical table: `memory_embeddings`
- derived virtual table: `vec_memories`

`memory_embeddings` should own:

- `memory_id`
- embedding metadata
- checksum/content hash
- updated timestamp
- optional normalized embedding blob for rebuild/debug

`vec_memories` should own/search on:

- vector column
- filterable metadata: `repo`, `status`, `type`, `scope`
- optional coarse path bucket / path prefix metadata
- auxiliary `memory_id`

Reason for split:

- canonical metadata/versioning stays easy to reason about
- vector index can be rebuilt if needed
- sqlite-vec stays a derived layer, not the only copy of retrieval state

### 3. Add Lexical Search Too

Add `FTS5` over memory text.

Reason:

- exact rules often want lexical wins
- commands / flags / filenames are better served by text search
- hybrid retrieval is more accurate than dense vectors alone

Recommended:

- `memories_fts(text, memory_id, repo, type, status, scope)`

### 4. Compiler Query Becomes Hybrid

> **Behavioral change**: Currently `compileContext` only fetches `active` memories.
> The hybrid path introduces `candidate` memories (with stronger gating).
> This must be eval-gated before default cutover.

Replace the current compile path with a staged retrieval flow.

### Candidate generation

1. hard filter in SQLite:
   - `repo`
   - `status in ('active', 'candidate')`
   - scope/path compatibility
   - confidence floor
2. vector top-k within the filtered set
3. lexical top-k within the same filtered set
4. merge candidates by `memory_id`

### Final rerank

Score with a weighted blend:

`final_score = dense + lexical + confidence + scope + freshness + type`

Example starting weights:

- dense similarity: `0.40`
- lexical score: `0.20`
- confidence: `0.20`
- scope/path match: `0.10`
- freshness: `0.05`
- type priority bias: `0.05`

Guardrails:

- exact repo/path match still beats vague semantic similarity
- `rejected` never eligible
- low-confidence `candidate` memories need stronger semantic support than `active`
- `rule` and confirmed `decision` types remain more conservative than history-like items

### 5. Separate Hard Memory From History

Do not mix future session/history retrieval directly into `memories`.

Add a later object type, e.g. `history_snippets`, with its own vector index.

Use that for:

- "have we discussed this before?"
- resurfacing older decisions phrased differently
- softer long-tail context

Keep compile injection conservative:

- hard memory path first
- history snippets secondary, lower-trust, likely summarized before injection

## Schema / Storage Plan

### Canonical additions

Possible new table:

- `memory_embeddings`

Columns:

- `memory_id text primary key`
- `model text not null`
- `dimensions integer not null`
- `version text not null`
- `content_hash text not null`
- `updated_at text not null`
- `embedding blob`

Possible new FTS table:

- `memories_fts`

Possible future table:

- `history_snippets`

## Indexing Strategy

Use repo as the strongest partition/filter boundary.

Practical rule:

- always narrow to one repo first
- then narrow by status/scope
- then run vector + lexical retrieval inside that repo slice
- path filtering can be post-filtered if sqlite-vec metadata constraints are too coarse

Avoid overfitting the vector index to very narrow path partitions too early.

Start simple:

- repo metadata
- status metadata
- type metadata
- scope metadata

Then add path bucketing only if eval shows real benefit.

### Query plan

Default retrieval should be:

1. canonical SQLite prefilter:
   - `repo`
   - `status`
   - `scope`
   - optional `path`
   - optional confidence floor
2. vector search on that eligible slice
3. FTS search on that same slice
4. merge by `memory_id`
5. rerank

Do not do this:

1. global vector search across all repos
2. filter results down afterward

That is worse for both scale and accuracy.

### Table strategy

Start with:

- one vector index for durable memories
- one vector index for history snippets
- `repo` stored as filterable metadata

Do not start with one vector table per repo.

Reason:

- too much table/index churn
- harder rebuilds and migrations
- many repos will be too small to justify their own physical split

Recommended first version:

- global lane table for durable memories
- global lane table for history
- repo-first filtering in the query plan

Later optimization:

- if a few repos become very large, add repo partitioning / repo-specific physical layout only for those hot repos

## Scale Envelope

This design scales if we keep retrieval scoped and tiered.

Good fit:

- many repos
- thousands to low millions of memory/history vectors on one machine
- most queries constrained to one repo
- compile-time retrieval working on a small candidate slice, not the whole corpus

Not a good fit:

- global cross-repo search over the full corpus on every request
- unbounded raw session-event embedding with no condensation
- treating sqlite-vec as if it were a distributed serving system

Practical scaling rules:

- shard retrieval logically by `repo` first
- keep hard memories and history snippets in separate indexes
- keep compile/query top-k small
- prefilter in SQLite before vector ranking whenever possible
- run lexical + vector retrieval on candidate sets, not the full database
- add pagination to `queryMemories` and `listMemories` (both currently return full result sets)

Recommended search window:

- vector top-k: `30-80`
- lexical top-k: `20-50`
- final rerank set: `<=100`
- final injection set: usually `<=10-20`

This keeps vector work bounded even as total corpus size grows.

Current bottlenecks to fix before scale matters:

- `pruneMemories` does `db.select().from(memories).all()` — full table scan in JS, not repo-scoped
- `semanticSearch` and `findSemanticDuplicates` also do full table scans with in-JS cosine
- `activityEvents` and `feedbackEvents` grow unbounded — no TTL or pruning exists
- `recall_prune` MCP tool has no `repo` parameter — always operates on entire DB

Long-term expectation:

- `memories` stays relatively compact
- growth pressure mostly comes from `history_snippets` and event tables
- history and events need lifecycle management, not just more vectors

If Recall later needs:

- org-wide/global search across all repos by default
- team-shared remote retrieval
- tens of millions of vectors on one corpus
- stricter low-latency guarantees under heavy concurrency

then we should re-evaluate a dedicated vector service. For the current local-first product shape, sqlite-vec is still reasonable.

## Write Path

On memory create/update/confirm/reject:

1. write canonical memory row
2. decide whether the row should be embedded
3. generate embedding if needed
4. upsert canonical embedding metadata
5. upsert/remove sqlite-vec index row
6. upsert lexical FTS row

Suggested embedding policy:

- embed `active` and strong `candidate` rows
- skip `rejected`
- skip `transient` (confidence < 0.3, not durable enough to justify embedding cost)
- on status transition to `rejected`: remove from vec index and FTS

## Reset / Bootstrap / Rebuild Commands

Add explicit commands:

- `recall db reset`
- `recall embeddings bootstrap`
- `recall embeddings rebuild-index`
- `recall embeddings verify`

Behavior:

- reset local DB to the clean schema
- bootstrap embeddings/indexes from canonical rows
- rebuild vec index from canonical tables
- verify row counts and stale hashes

This makes sqlite-vec operationally safe even if the index needs regeneration.

## Migration Strategy

We want a clean break, not a long compatibility tail.

Plan:

1. create one new `initial_migration` representing the target schema
2. discard the old shipped migration path for local installs
3. on upgrade, remove the old local DB
4. initialize the fresh DB from `initial_migration`
5. rescan repos / recreate canonical memories
6. bootstrap embeddings, vec index, and FTS from the rebuilt canonical rows

Consequences:

- destructive local migration by design
- simpler schema
- simpler code
- no dual-read / dual-write period
- no old inline `embedding` column support
- no blob backfill from previous local installs

This is acceptable only if cold-start rebuild from scans and new writes is reliable enough for Recall.

## Background Maintenance Jobs

Yes: Recall should optimize memory over time with background work.

Currently there is no automatic scheduling — the launchd plist has `KeepAlive` but no `StartInterval` or `StartCalendarInterval`. All pruning is manual via `recall_prune` MCP call.

Need a small maintenance loop in the daemon / app (via `StartInterval` in launchd or an internal timer):

### Index maintenance

- embed newly eligible memories asynchronously
- refresh stale embeddings when text/model/version changes
- remove vec/FTS rows for `rejected` or deleted items
- verify canonical row count vs vec row count
- rebuild vec index if drift detected

### Storage maintenance

- periodic SQLite `ANALYZE`
- periodic WAL checkpoint
- periodic `VACUUM` / `PRAGMA optimize` during idle windows, not on active query path
- FTS optimize/rebuild when needed
- `activityEvents` TTL: delete events older than N days (default 90)
- `feedbackEvents` TTL: delete events older than N days (default 180, longer because feedback is higher signal)

### Quality maintenance

- merge or supersede near-duplicate memories (wire `findSemanticDuplicates` into create/confirm path)
- decay stale low-signal candidates
- demote memories with bad follow/override history
- refresh confidence from feedback signals
- scope `pruneMemories` to per-repo instead of full table scan

### History compaction

Hard memories should stay lossless.

History should compact over time:

- raw session events -> snippets
- snippets -> summarized episodes / decisions
- drop or archive low-value raw history after it has been summarized

This is the main answer to long-term growth.

Do not keep every historical utterance as a first-class vector forever.

## Compaction Policy

Use two lanes:

### Lane 1: durable memory

- rules
- confirmed decisions
- stable gotchas
- repeated review patterns

Policy:

- no lossy compaction
- dedup / supersede only
- preserve evidence and audit trail

### Lane 2: history

- session traces
- corrections before promotion
- review discussions
- intermediate snippets

Policy:

- summarize aggressively
- keep short windows of raw detail
- retain references to source activity IDs
- archive cold history outside the hot retrieval path

Recommended jobs:

- `history rollup`: convert recent raw events into snippets
- `history summarize`: merge related snippets into durable summaries
- `history archive`: move cold raw history out of primary retrieval
- `memory dedup`: merge semantically duplicate durable memories

## Operational Defaults

Recommended background cadence:

- on write: enqueue embed/index sync
- every few minutes: process small embed/index batches
- daily idle job: verify index drift, optimize SQLite, compact history
- weekly idle job: deeper rebuild/verify and dedup sweep

Keep all maintenance idempotent and resumable.

If a job fails:

- canonical SQLite data remains intact
- vec/FTS indexes can be rebuilt
- compile/query should degrade gracefully to lexical/exact retrieval

## Ranking Rules

Recommended default behavior:

- exact lexical hits on strong rules should win often
- semantic search should surface semantically similar decisions/review patterns
- confidence still matters
- recency matters a little, not a lot
- path-scoped exact matches should outrank repo-global vague matches

One practical policy:

- `rule`: highest trust (current priority: 0)
- `command`: lexical-heavy bias (current priority: 1)
- `gotcha`: semantic-friendly, but confidence-gated (current priority: 2)
- `review_pattern`: semantic-friendly, but confidence-gated (current priority: 3)
- `decision`: high trust when confidence is solid (current priority: 4 — lowest in existing sort; reranker should likely promote this)

## Rollout Plan

### Phase 1: Embedding lifecycle

Status: shipped

- `memory_embeddings` table exists
- clean `initial_migration` exists
- `recall db reset` exists
- `recall embeddings bootstrap` exists
- auto-embed on create/update exists
- inline embedding storage is gone

### Phase 1.5: Fix existing full-scan bottlenecks

Status: shipped for the intended scope

- `pruneMemories` is repo-scoped
- `recall_prune` accepts `repo`
- `queryMemories` and `listMemories` have pagination
- semantic dedup is wired into correction/review capture

### Phase 2: sqlite-vec index

Status: shipped

- durable memory vec index exists
- rebuild/verify tooling exists
- index tests exist

### Phase 3: lexical index

Status: shipped

- durable memory FTS exists
- lexical + vector candidate generation exists

### Phase 4: compiler integration

Status: shipped

- hybrid compile path exists
- reranking exists
- candidate opt-in exists
- thresholds stay conservative

### Phase 5: background lifecycle

Status: shipped

- daemon maintenance timer exists
- prune / index verify / TTL cleanup exist
- SQLite maintenance ops exist
- history rollup + summarize + cleanup exist

### Phase 6: history retrieval

Status: shipped

- separate `history_snippets` lane exists
- independent history lexical/vector retrieval exists
- low-trust history remains separate from hard memory injection

## Testing / Eval

Offline retrieval eval exists now.

Measure:

- top-k relevance for known compile/query cases
- injection accept rate
- override rate
- contradiction rate
- token budget fit

Add regression tests for:

- semantically similar wording retrieves the right memory
- exact command text still beats fuzzy semantic matches
- rejected memories never resurface
- path-scoped memory outranks repo-global memory when both match

## Risks

### sqlite-vec maturity

`sqlite-vec` is still earlier-stage than SQLite itself.

Mitigation:

- pin exact version
- wrap usage behind a small adapter
- keep canonical data outside the virtual table
- support full rebuild from canonical tables

### Destructive reset rollout

Dropping old DBs is operationally simpler, but still destructive.

Mitigation:

- make reset explicit in release notes / setup flow
- keep schema initialization deterministic
- verify repo-scan/bootstrap path before cutover
- test cold-start rebuild time on realistic repo sets

### Accuracy regressions

Vector search can over-surface vaguely related memories.

Mitigation:

- hybrid rerank
- conservative thresholds
- status/confidence gating
- eval harness exists; it should keep growing with real repo fixtures

### Performance surprises

Naive search may still degrade if we search too broadly.

Current remaining risks are mostly operational polish, not missing core architecture.

Mitigation:

- repo-first filtering
- top-k candidate limits
- optional path bucketing later
- derived index rebuild tooling
- paginate list/query APIs
- event table TTL to prevent unbounded growth

## Recommendation

Adopt `sqlite-vec`, but do it as part of a hybrid retrieval rewrite.

The winning shape for Recall is:

- SQLite remains canonical
- `sqlite-vec` handles semantic retrieval
- `FTS5` handles lexical retrieval
- compiler reranks both
- injection stays conservative

That gets better scale and better selection quality without changing Recall's local-first model.

## Remaining Work

1. Add more real retrieval-eval fixture files for important repos.
2. Decide whether history snippets should influence compile injection beyond low-trust secondary retrieval.
3. Add optional path bucketing only if eval shows measurable benefit.

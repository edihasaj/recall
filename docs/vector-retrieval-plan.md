---
summary: "Plan for moving Recall from SQLite-only retrieval to hybrid SQLite + embeddings with better semantic ranking for memories, decisions, and longer history."
read_when:
  - Planning vector retrieval improvements for Recall.
  - Deciding whether embeddings should remain local or move to a separate vector DB.
  - Extending Recall beyond exact repo/path filtering into semantic recall.
---

# Vector Retrieval Plan

## Current State

Recall already has a first pass at embeddings:

- embeddings stored on `memories.embedding` as a blob in SQLite
- OpenAI embedding generation in `src/embeddings/embeddings.ts`
- batch embed support via `embedAllMemories`
- brute-force cosine semantic search via `semanticSearch`

What is missing:

- embeddings are optional and not part of the default recall path
- compile/query path does not use semantic ranking
- no embedding refresh/versioning strategy
- no separate handling for long-lived session/history snippets
- no ANN index or retrieval cache

## Goal

Keep SQLite as the source of truth, but add vector-backed semantic retrieval so Recall scales better as:

- memory count grows
- soft decisions/preferences increase
- session history becomes longer
- user wording varies from the original saved phrasing

## Product Direction

Primary integration stays:

- Recall.app runs the local service
- Recall MCP is the main read/write path

Retrieval should become hybrid:

1. exact repo/path/status filters
2. confidence and freshness
3. vector similarity ranking
4. compiler chooses the final injected pack

## Recommended Architecture

### 1. Keep SQLite as canonical store

Do not move canonical memory out of SQLite.

SQLite remains the source of truth for:

- memory records
- evidence
- activity/session logs
- confidence/state transitions

### 2. Use embeddings as a retrieval layer

Add embeddings for:

- repo memories
- especially `decision`, `rule`, `review_pattern`, `gotcha`

Later, optionally add embeddings for:

- condensed session/history snippets
- accepted review summaries
- major architectural decisions

### 3. Stay local-first first

Do **not** jump to a separate vector DB yet.

Why:

- local app already owns the data
- current memory volume is still small
- separate vector DB adds packaging/sync/ops overhead

Short-to-medium term best path:

- SQLite + embedding blobs
- a lightweight local ANN structure or cached index on top

Only move to a dedicated vector DB if:

- memory/session corpus becomes very large
- latency becomes unacceptable
- cross-device/shared-team semantic retrieval needs it

## Phased Plan

### Phase 1: Make embeddings first-class

Use existing code, but wire it into the main path.

Changes:

- add `recall embeddings backfill` or reuse `embed`
- auto-embed new memories on create when embeddings are enabled
- add embedding model/version metadata
- skip brute-force embedding of rejected memories

Output:

- every active/candidate memory can have an embedding
- semantic retrieval is available without manual one-off steps

### Phase 2: Hybrid query path

Update `recall_query` / compiler flow:

1. fetch exact repo/path/status candidates
2. if embeddings enabled and query text exists:
   - embed the query
   - compute semantic similarity
   - rerank candidates
3. merge with confidence/status heuristics

Important:

- semantic similarity should rank, not fully override confidence
- exact scope match still matters

Recommended score shape:

`final_score = semantic_similarity * a + confidence * b + freshness * c + scope_match * d`

### Phase 3: Better indexing

Current search is brute-force over all embedded rows.

That is fine early, but not ideal long term.

Upgrade path:

- maintain a repo-scoped in-memory index on daemon start
- rebuild lazily when new embeddings are written
- optionally persist a lightweight ANN index per repo under `~/.recall/indexes/`

Still local.

### Phase 4: History embeddings

Add a second object type later, separate from `memories`:

- `history_snippets`
- derived from activity/review/corrections/session summaries

Use it for:

- semantic “have we talked about this before?”
- decision resurfacing when phrasing differs
- richer future recall beyond hand-authored memory items

This should be separate from `memories` so hard rules and softer historical evidence do not blur together.

## Schema Changes Likely Needed

Current schema has:

- `memories.embedding`

Likely additions:

- `embedding_model`
- `embedding_dimensions`
- `embedding_updated_at`
- `embedding_version`

For future history support:

- new `history_snippets` table
- `repo`, `session_id`, `text`, `kind`, `created_at`
- `embedding`, `embedding_model`, `embedding_updated_at`

## Retrieval Rules

### Strong memories

- rules
- confirmed decisions
- repeated review patterns

These should still dominate results when highly relevant.

### Soft decisions/preferences

- use semantic similarity to surface them
- keep lower default confidence
- require repetition/evidence for aggressive injection

### Open questions

Do not embed unresolved questions into the same retrieval path as memory items.

If stored at all later, they should live in history/snippets, not in primary memory ranking.

## Performance Notes

Current brute-force cosine search is simple but O(n).

Short term:

- acceptable for small memory counts
- probably fine per repo for now

Medium term:

- repo-scoped caching/indexing is the biggest win
- avoid global full-table scans

## Safety / Quality Notes

- embeddings should improve recall, not create hallucinated repo rules
- semantic results must still respect:
  - repo filter
  - path/scope filter
  - status
  - confidence floor

Recommendation:

- use semantic search for candidate generation + ranking
- keep final injection conservative

## Immediate Next Steps

1. Add embedding metadata/versioning to memory rows.
2. Auto-embed new/updated memories when embeddings are enabled.
3. Rerank `recall_query` results semantically within repo/path scope.
4. Add tests for semantic surfacing of soft decisions.
5. Keep separate vector DB out of scope for now.

## Recommendation

Best path for Recall now:

- SQLite remains canonical
- embeddings become first-class
- local hybrid retrieval
- no external vector DB yet

That gives better recall quality without overcomplicating the product.

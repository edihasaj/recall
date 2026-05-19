# Quality audit — 2026-05-20

Snapshot of the live `~/.recall` install on Edi's machine taken just after the
`v0.7.0` cut. Sample size: 608 memories, 226 maintenance tasks completed in the
last 7 days, 4 abandoned, 1 pending. DB file: 530 MB (mostly history+vector
indexes, not memory rows).

## Memory mix

| status    | count |
|-----------|-------|
| active    | 121   |
| candidate | 259   |
| rejected  | 228   |

Candidate-to-active ratio is **2.1×**. That's the first smell: roughly twice
as many tentative rules sit unresolved as durable rules in production.

## Duplicate clusters (active, repo-scope)

Same canonical rule, multiple `active` rows across repos:

| text | repos with active copy |
|------|------------------------|
| use pnpm as the package manager | 3 |
| use pnpm as the package manager (lockfile: pnpm-lock.yaml) | 3 |
| use yarn as the package manager | 3 |
| use \`uv\` for python dependency management | 3 |

These are *legitimate* per-repo facts (different repos pick different package
managers), but **they suggest no `scope=global` promotion path** for rules
that recur identically across many repos. A rule observed in 3+ repos is
indistinguishable from "this is how the user works" and should be lifted.

## Duplicate clusters (candidate purgatory)

`merge_duplicates` only runs against `status=active`, so candidate dupes never
get merged:

| text | candidate copies |
|------|------------------|
| react project (no next.js) | 6 |
| linting/formatting: eslint (flat config) | 4 |
| all imports at file top - never inside functions | 4 |
| type hints required for all functions | 3 |
| in routers: always pass current_user (never use _ for admin endpoints) | 3 |
| pass \`current_user\` in router (never use \`_\`) | 3 |
| all user-facing text must use i18n translations | 3 |

7 candidate clusters with ≥3 copies each. The 6× "react project" is the
clearest signal — the heuristic+LLM capture path emitted the same low-signal
rule once per repo without ever consulting the existing set.

## Dispatcher health

- Daily LLM dispatcher cadence configured (`RECALL_DISPATCHER_INTERVAL_SECONDS`
  default `86400`). Last completed task: ~3h before the audit. ✅ running.
- In-process maintenance loop fires every 5 min
  (`RECALL_MAINTENANCE_INTERVAL_SECONDS`). Handles vacuum, retention, light
  pruning.
- Task kinds enqueued in the last 7 days:

  | kind | count |
  |------|-------|
  | extract_rules_from_prompt | 143 |
  | summarize_history | 57 |
  | summarize_session | 4 |

  Notably **zero `merge_duplicates` enqueued** in the window, despite the
  duplicate clusters above. Either the producer ran with nothing to merge
  (only same-repo + active is considered) or the embedding floor blocks it.

## Retrieval path (hook → /query)

The `UserPromptSubmit` hook passes the raw user prompt to
`compileContextHybrid`, which calls `hybridSearch` (BM25 + sqlite-vec). The
vector floor `QUERY_VECTOR_RELEVANCE_FLOOR` strips matches with cosine
similarity below threshold. This already shapes retrieval by *what the user
asked for* — there is no LLM reformulation step in the middle, but the
embedding model handles paraphrase and intent natively.

Verified live: ~1ms p50 query path on 121 active memories. Vector floor
filters noise effectively (a "/goal" prompt that doesn't match any memory
returns zero injections instead of low-relevance junk).

## Followups (ordered by impact)

1. **Cross-repo merge + promote-to-global.** When `(text, type)` appears in
   ≥3 repos with `status=active`, enqueue a merge task that proposes a
   `scope=global` consolidation. Today these silently accumulate.
2. **Candidate dedupe.** `produceMergeDuplicateTasks` should accept
   `status IN ('active','candidate')` so the 4–6× candidate clusters get
   collapsed before they ever go active. Today they accumulate forever.
3. **Rejected retention.** 228 rejected rows are 38% of the table. Add a
   `RECALL_REJECTED_RETENTION_DAYS` (default 90) that drops them so the
   table stays focused on the durable+candidate working set.
4. **Optional: LLM query distillation.** For prompts >300 chars, run a
   distill-into-search-terms task before `hybridSearch`. Embedding already
   handles paraphrase, so the gain is small — measure first against the
   LongMemEval-S haystack before shipping.

---
status: active
read_when: "Two-week quality check — run on or after 2026-05-13"
---

# Quality cleanup follow-up — check on 2026-05-13

Snapshot of the work shipped on 2026-04-28/29 and what to verify two weeks
later. This file is meant to be self-contained so a future Claude can pick
it up cold.

> **2026-05-11 update — capture architecture flipped.** When an LLM provider is configured, capture no longer goes through the regex extractor + `qualityReasons` gate. Instead the prompt is judged by an `extract_rules_from_prompt` LLM task (priority 14) and the regex path is now a fallback for offline/airgapped runs. The fragment-filter signals documented below still apply under that fallback. See `docs/configuration.md → Capture path` for the full flow.

## Baseline (recorded 2026-04-28)

- Snapshot id: `2b07bd49`, note `phase-1+2+3 baseline`
- followed-rate of resolved injections: **0.7 %** (11 followed / 1691 resolved)
- active rule count: **41**
- candidate user_correction count: **18**
- 1674 of those 1691 "resolved" rows were the legacy-`ignored` bucket from
  before Phase 2.3's honest detector landed — they will age out of the
  14-day window naturally.

## What we shipped (commits e5b43d3 → fef838f)

- Phase 1: deterministic cleanup tier (dedupe / reject fragments / promote
  rule-shaped corrections) + cleanup log + revert + CLI.
- Phase 1.5: daemon `scheduleCleanupLoop` runs the cleanup tier daily.
- Phase 2.1: merge-duplicates threshold lowered to 0.85 for `type=command`.
- Phase 2.2: `expireStalePendingTasks` abandons pending tasks older than
  `summary_max_age_days * 2`.
- Phase 2.3: outcome detector stops writing `ignored` for non-applicable
  injections — leaves `memory_injections.outcome=NULL`.
- Phase 3: `recall maintenance cleanup --revert/--list`,
  `recall maintenance quality`, doctor `## Cleanup` section.
- Phase 4: 13 cleanup tests + `quality_snapshots` table +
  `--snapshot/--history` for trend tracking.
- #1: `auto_inject` column + cleanup action `suppress_unproductive_command`
  (demoted 5 commands with 50+ injections / 0 followed).
- #3: capture-time fragment filter mirrors `qualityReasons()` so trash never
  enters the candidate queue. `too_short` floor lowered to 14 chars.
- #7: daemon `scheduleQualitySnapshotLoop` records a snapshot weekly with
  `notes='auto'`.
- #2: `scope='global'` enum + cleanup action `globalize_cross_repo` + guard
  that skips clusters where another repo holds a contradicting active
  memory.
- #5: `detectContradictions` runs after every cleanup tick and logs new
  pairs. `scopesOverlap` learned `scope='global'`.
- #4: `getMemoryFeedbackSummaries` + `feedbackWeightedScore` blend
  confidence with empirical followed-rate (Bayesian smoothing, weight ramps
  from 0 to 1 across 5 resolved samples). `compileContext` and
  `compileContextHybrid` both use the weighted score now.
- #8: `recall maintenance dispatch --preview` prints prompts without
  calling an LLM. Doctor surfaces dispatcher state. Daemon logs once when
  dispatcher is dormant.

Total: 13 commits, 336 tests passing.

## What to check on 2026-05-13

Run these in order, then write down the deltas.

### 1. Take a fresh quality snapshot
```bash
recall maintenance quality --snapshot --note "two-week check"
```

### 2. Compare against baseline
```bash
recall maintenance quality --history
```
Expected output ends with a `Δ since first snapshot` block. Look for:
- `followed rate`: should move off 0.7 %. Hypothesis: it climbs because
  Phase 2.3 stopped polluting the denominator with `ignored`. A two-week
  window should be entirely post-fix.
- `resolved`: decreasing is fine — fewer false `ignored` writes.
- `followed`: should grow (>11) as honest `followed` events accumulate.
- `contradicted`: should stay at 3 (no new conflicts; the guard works).
- `active rules`: should drift up if Phase-1 promotion is still finding gold.
- `candidates`: should stay flat or shrink — Phase 3 stops capturing trash.

If `followed_rate_delta_pp` < 5pp, something else is suppressing positive
signal. Check the outcome detector heuristic (`isPromptRelevant`,
`toolCallTouchesMemory` in `src/cli/hook.ts`) — it may be too strict.

### 3. Doctor sanity
```bash
recall doctor
```
Verify:
- `## Cleanup`: total runs ≥ 14, last run within 24 h, pending correction
  candidates ≈ 0 (the daemon should be sweeping them).
- `## Dispatcher`: pending tasks should be ≤ 5 (the dispatcher drains at
  5/day, queue had 15 on 2026-04-28). If pending >> 15, dispatcher stalled.
- 14-day followed rate should match the snapshot.

### 4. Spot-check the cleanup log
```bash
recall maintenance cleanup --list
```
Most recent ~14 runs should each have small action counts (1–5). Large
counts mean the daemon is finding new trash daily — investigate whether
the capture-time filter or fragment regex is missing a case.

### 5. Contradictions
```bash
recall contradictions detect
```
Should report 0 new pairs. Three stale ones from 2026-04-28 may still sit
in the table; resolve manually if you want a clean board:
```bash
recall contradictions resolve <id>
```

## If followed-rate didn't move

Most likely causes, ordered by probability:

1. **Outcome detector still too strict.** The new heuristic only labels
   `followed` when a tool call literally touches the memory — many real
   "the agent followed the rule" cases don't show up that way. Loosen
   `toolCallTouchesMemory` or accept a broader "session ended without a
   correction matching this rule" → `followed`.
2. **Memories are too generic.** Most active rules are pan-repo guidance
   that's hard to verify per-session. Consider tightening promotion
   threshold or splitting rules by intent.
3. **Auto-suppression went too far.** `auto_inject=false` rows can't earn
   followed events. Spot-check via `select * from memories where
   auto_inject=0` — if any look genuinely useful, flip them back.

## If everything looks healthy

Then the real next steps are:
- Document the new commands in `README.md`.
- Consider tagging globals (`tags: ["language=python"]`) so "Use uv" only
  injects in Python repos.
- Wire `autoResolveContradictions` to also resolve stale rows where
  `scopesOverlap` no longer holds.

That's it. Come back fresh and run the five steps above.

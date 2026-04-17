---
summary: "Plan for delegated LLM-powered memory maintenance. Recall's daemon stays purely deterministic (TTL, dedupe, decay, SQLite maintenance); any task that needs judgment (summarize, merge, refine, promote) is enqueued as work for whichever agent is already running, claimed and submitted via MCP. Zero tokens billed to Recall."
read_when:
  - Touching `src/maintenance/` or designing new maintenance behaviors.
  - Adding MCP tools that move/merge/refine memory content.
  - Deciding whether a new cleanup job belongs in the daemon or the delegated queue.
  - Considering adding direct OpenAI/Anthropic calls from Recall (don't — read this first).
---

# Memory Maintenance Plan

## Decision

Split maintenance into two tiers:

- **Tier 1 — Deterministic (daemon, already shipped).** TTL prune, rejection cleanup, health-score demotion, candidate promotion on repetition, stale-embedding refresh, template-based history rollup, SQLite `ANALYZE/OPTIMIZE/WAL/VACUUM`. Pure SQL + heuristics. Runs on the `runMaintenanceCycle` timer.
- **Tier 2 — Delegated LLM (new).** Summarize history snippets into prose, merge semantic duplicates, refine candidate text before promotion, summarize closed sessions, synthesize repo-level knowledge. The daemon enqueues tasks into a `memory_maintenance_tasks` table. Caller agents (Claude Code, Codex, future) claim tasks via new MCP tools, do the LLM work on their own token budget, and submit results back.

Recall's process never makes an outbound LLM call. Kill switch: `RECALL_MAINTENANCE_LLM_DISABLED=true` — daemon still enqueues; no agent will see the tasks.

## Why this direction

### Recall's constraint is "runs on any laptop"
No API keys, no cloud dependency, no separate billing. The moment the daemon needs an LLM budget, we've broken the product promise — Recall stops being a free-to-run helper and becomes a service you subscribe to. Delegation keeps the daemon free.

### Caller agents already have tokens
Whoever is chatting with you — Claude Code, Codex — is already authenticated and already spending against your subscription. Asking them to pick up a 2-KB summarization task between turns is marginal cost the user has already paid for. Recall just has to be good at **asking**.

### Tier-1 vs Tier-2 is a clean cut
Everything the daemon does today is pure SQL. Everything it *can't* do (good summaries, good merges, good refinement) is exactly where judgment is needed. The boundary is natural, not forced.

### MCP queue = pull, not push
We can't schedule work on an agent we don't control. But if the agent polls (via MCP on session start / idle / explicit `recall_maintenance_*` calls), the daemon can lazily produce tasks and the first agent that checks in does the work. No coordination, no push, no webhooks.

## Non-Goals

- Adding any direct LLM call inside the Recall daemon or CLI. If it needs an LLM, it's a Tier-2 task.
- Guaranteeing tasks complete within a timeframe. Delegated work is best-effort; Tier-1 cleanup always runs.
- Replacing existing deterministic work with LLM work. Tier-1 stays as the floor.
- A server-side "maintenance worker" process. No new daemons, no schedulers beyond `runMaintenanceCycle`.
- Cross-machine task sharing. Tasks live in the local `~/.recall/*.db` and are claimed by local agents only.
- Auto-executing tasks without any agent attached. Recall is happy to idle indefinitely with a backlog.

## Current State (2026-04)

- `runMaintenanceCycle` in `src/maintenance/lifecycle.ts` runs every `RECALL_MAINTENANCE_INTERVAL_SECONDS` (default 300s).
- It prunes memories, refreshes embeddings, rolls up history snippets, and runs SQLite housekeeping.
- `rollupSessionHistory` and `summarizeHistorySnippets` exist but produce **template-based** summaries — no LLM involvement.
- `promoteRepetitionCandidates` promotes candidates when they cross `repeat_sessions_required` — deterministic.
- No table for delegated tasks; no MCP tools for claiming work.
- `recall_quality`, `recall_audit`, `recall_contradictions` all run locally with zero token cost.

## Task Taxonomy

Tasks are typed. Each type has a deterministic producer (what makes the daemon enqueue one) and a clear input/output contract.

| Task kind | Producer (Tier-1 signal) | Input | Output | Agent effort |
|---|---|---|---|---|
| `summarize_history` | `summarizeHistorySnippets` finds a snippet with raw turns but no LLM summary | session turns, repo, existing template summary | refined summary text, tags | small (~500 tokens) |
| `merge_duplicates` | `findSemanticDuplicates` finds cosine ≥ 0.92 cluster with ≥2 active members | N memory texts, their scopes | winning text + list of merged IDs + rationale | small-medium |
| `refine_candidate` | A candidate crosses `repetition_count` threshold but scope is weak (`repo:*` only) | candidate text, capture_context, prev_assistant_turn | tighter text, inferred scope, path_scope | small |
| `summarize_session` | `recall hook session-end` fires and session had ≥5 corrections or ≥20 tool calls | session event stream | one-paragraph session note for history | small |
| `synthesize_repo` | Repo accumulates ≥20 active memories with no repo-level summary | list of active memory texts | repo-level "how this codebase works" note | medium |

Every other future LLM-shaped need lands here as a new kind. Deterministic jobs never become tasks; tasks never fall back into the daemon's inline path.

## Schema

```sql
CREATE TABLE memory_maintenance_tasks (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,         -- see task taxonomy
  status           TEXT NOT NULL,         -- pending | claimed | submitted | completed | abandoned
  priority         INTEGER NOT NULL DEFAULT 0,
  repo             TEXT,                  -- scoping; nullable for cross-repo tasks
  payload          TEXT NOT NULL,         -- JSON input for the agent
  result           TEXT,                  -- JSON result on submit
  failure_reason   TEXT,                  -- agent-reported failure; null on success
  claimed_by       TEXT,                  -- agent name (claude-code | codex | …)
  claimed_at       TEXT,
  claim_expires_at TEXT,                  -- after this, pending again
  submitted_at     TEXT,
  completed_at     TEXT,
  created_at       TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3
);

CREATE INDEX idx_mmt_status_priority ON memory_maintenance_tasks(status, priority DESC, created_at);
CREATE INDEX idx_mmt_repo_status     ON memory_maintenance_tasks(repo, status);
CREATE INDEX idx_mmt_claim_expires   ON memory_maintenance_tasks(claim_expires_at) WHERE status = 'claimed';
```

Additive migration (new `drizzle/000N_memory_maintenance_tasks.sql`) — no reset required. Task backlog is disposable; dropping the table on future resets is acceptable.

## MCP Tools

Four new tools. Descriptions are explicit about **when** to call them so models use them without system-prompt nudging.

### `recall_maintenance_peek`

Read-only. Returns up to N pending tasks the caller could claim, filtered by agent capability and repo.

```ts
input:  { repo?: string, kinds?: TaskKind[], limit?: number }      // limit default 3, hard cap 10
output: { tasks: Array<{ id, kind, priority, repo, created_at, payload_summary }> }
```

Description hint: *"Call at session start or between turns to see pending memory maintenance work. Returns small tasks an agent can pick up in one turn."*

### `recall_maintenance_claim`

Atomic claim. Marks a task `claimed` with a TTL (default 10 min). Fails if already claimed.

```ts
input:  { task_id: string, lease_seconds?: number }                 // default 600
output: { task: { id, kind, payload, lease_expires_at } }
```

One claim per call. No batch claim — keeps the agent's turn small.

### `recall_maintenance_submit`

Submit result. Daemon validates (JSON shape + kind-specific schema), applies the effect (e.g. writes the merged memory, replaces the template summary), and marks `completed`.

```ts
input:  { task_id: string, result: Record<string, unknown> }
output: { status: "applied" | "rejected", applied_changes?: AuditSummary, reason?: string }
```

Validation failure bumps `attempts`; `attempts >= max_attempts` transitions to `abandoned` with `failure_reason`.

### `recall_maintenance_release`

Release a claim without submitting (user interrupted the agent, context compacted, agent can't handle this kind, etc.).

```ts
input:  { task_id: string, reason?: string }
output: { status: "released" }
```

Released tasks go back to `pending`. Lease-expired tasks return to `pending` automatically via the Tier-1 sweep.

## Effect Application

Each `submitted` task's `result` is turned into a concrete mutation. This is the only place Tier-2 work touches canonical memory.

| Task kind | Applied effect |
|---|---|
| `summarize_history` | Replace `history_snippets.summary_text` for the referenced snippet; mark `summary_kind = 'llm'`. |
| `merge_duplicates` | Create audit row per merged memory; set `status = 'merged'` and `merged_into = <winner_id>` on losers; overwrite winner's text + scope from result. |
| `refine_candidate` | Update `memories.text`, `scope`, `path_scope`; audit with `reason = 'refined:<task_id>'`. |
| `summarize_session` | Insert one row into `history_snippets` with `kind = 'session'`. |
| `synthesize_repo` | Upsert into `repo_summaries(repo, text, generated_at)`; surfaced via `compileContext`. |

**Every applied effect writes an audit row** so rollback via `recall_rollback` works. An applied Tier-2 mutation is indistinguishable from a user-driven one except for its `reason` field.

## Producer: Enqueueing from the Daemon

`runMaintenanceCycle` grows a fifth step between existing work and return:

```ts
if (!llmDisabled) {
  const enqueued = enqueueMaintenanceTasks(db, {
    max_pending: config.maintenance_max_pending,       // default 50
    max_per_kind: config.maintenance_max_per_kind,     // default 10
    priority_floor: config.maintenance_priority_floor, // drop below-floor tasks if over budget
  });
  result.tasks_enqueued = enqueued;
}
```

Policy:

- **Backlog caps** prevent runaway growth if no agent ever claims. Above cap, drop lowest-priority pending tasks to stay under.
- **Idempotent producers.** Each producer checks "is there already a pending/claimed task for this exact target?" before inserting. History-snippet summarization is keyed by `snippet_id`; merge tasks keyed by the cluster's canonical hash.
- **Priority**: user-visible tasks (merge active duplicates, refine near-promotion candidates) > background tasks (repo synthesis).
- **Lease expiry sweep.** In the same cycle, any `claimed` row with `claim_expires_at < now` is reverted to `pending`, `attempts += 1`.

## Agent UX

The four MCP tools are usable by any agent, but the expected flow is:

1. Session starts. Adapter-side hook (or the model on its own) calls `recall_maintenance_peek`.
2. If tasks exist and the user turn is idle (no pending user prompt), the agent picks one, calls `recall_maintenance_claim`, does the LLM work, and calls `recall_maintenance_submit`.
3. If the user speaks before the agent finishes, the agent calls `recall_maintenance_release` and prioritizes the user.

**Agents never auto-claim during an active user turn.** Tool descriptions make this explicit.

No special model prompt is needed — descriptions are enough. Heavy users can install a hook (already wired in `src/agents/` and `src/cli/hook.ts`) that calls `recall_maintenance_peek` on `session_started` and surfaces the backlog as an injection-context line: *"3 memory maintenance tasks available — call `recall_maintenance_claim` when idle."*

## Safety

- **No user data off machine.** Task payloads contain memory text, session excerpts, and scopes — same material the agent already sees. No new egress path.
- **No silent overwrites.** Every Tier-2 mutation goes through the same audit trail as user actions and is reversible via `recall_rollback`.
- **Validation before apply.** Submitted results must match the task kind's JSON schema (lengths, required fields, shape). Invalid submissions are rejected, not applied.
- **Max attempts.** Tasks that fail validation `max_attempts` times are abandoned with `failure_reason` and never re-enqueued for the same target within a cooldown window (default 24h).
- **Kill switch.** `RECALL_MAINTENANCE_LLM_DISABLED=true` turns off enqueueing entirely. MCP tools remain callable but return empty backlogs.
- **Privacy filter at enqueue.** Producers strip known secret paths (`~/.ssh`, `~/.aws`, `*.env`) from payloads before writing the task row — defense-in-depth even though agents only see what they'd see anyway.

## Observability

- `recall hook stats` already exists; extend with `recall maintenance stats` to show backlog by kind, mean latency from create → complete, abandonment rate.
- `recall_audit` surfaces Tier-2 mutations with `reason` prefixes (`summarized:`, `merged:`, `refined:`, `session-summary:`, `repo-synth:`) so the user can see exactly which memories the delegated layer touched.
- Telemetry row per submit in a `maintenance_runs` table (kind, agent, duration_ms, ok, applied_changes_count) — local-only, bounded retention via Tier-1 pruning.

## Phases

### Phase 1 — Schema + producer scaffold

- Add `memory_maintenance_tasks` table (migration folded into the destructive reset).
- Implement `enqueueMaintenanceTasks(db, config)` with producers for `summarize_history` and `refine_candidate` only.
- Unit tests for producer idempotence + backlog cap.

### Phase 2 — MCP tools (peek, claim, submit, release)

- Wire the four tools into `src/mcp/server.ts`.
- Validation schemas per task kind.
- Lease TTL + expiry sweep in `runMaintenanceCycle`.
- Integration test: fake agent claims, submits, effect is applied and audit row written.

### Phase 3 — Effect appliers

- `summarize_history` applier → update history snippet.
- `refine_candidate` applier → update memory text/scope with audit.
- Rollback fixture confirming `recall_rollback` undoes Tier-2 mutations.

### Phase 4 — Remaining task kinds

- `merge_duplicates` producer (reuse `findSemanticDuplicates`) + applier.
- `summarize_session` producer (on `session_ended` hook) + applier.
- `synthesize_repo` producer (low priority) + applier.

### Phase 5 — Observability + CLI

- `recall maintenance stats` CLI subcommand.
- `recall maintenance list [--status …]` to inspect backlog.
- `recall maintenance drop <id>` to manually drop a task.

### Phase 6 — Hook-side surfacing (optional)

- Extend Claude Code / Codex adapters to peek on `session_started` and surface the backlog count.
- Opt-in via `RECALL_MAINTENANCE_SURFACE_ON_START=true`.

### Phase 7 — Eval coverage

- Fixture comparing template-only vs delegated-LLM summaries for `summarize_history` on a held-out set; hand-rated quality delta.
- Track merge-precision (how often the agent merges things a human wouldn't) in `recall eval report`.

## Risks

### Backlog grows forever with no agents
If nobody ever claims, enqueueing wastes disk. Mitigation: backlog caps per-kind + total, priority-floor drops when over cap, kill switch for users who never want this.

### Agent hallucinates results
A merge result invents text not in any input memory, or refine adds a rule the user never gave. Mitigation: validation schemas enforce shape; an audit diff makes it obvious; `recall_rollback` undoes it. **Tier-2 is not trusted blind** — the user's corrections stay the source of truth, Tier-2 only restructures.

### Model repeatedly fails on the same task kind
Some kinds may be too hard for small/cheap models. Mitigation: `attempts >= max_attempts` abandons with `failure_reason`; operator can inspect via CLI and disable that kind (`RECALL_MAINTENANCE_DISABLE_KINDS=merge_duplicates`).

### Claim leaked by crashed agent
Agent crashes mid-task, lease sits claimed until TTL. Mitigation: short default lease (10 min); lease-expiry sweep returns to pending; `recall_maintenance_release` available for manual recovery.

### Double-apply race
Two agents claim and submit near-simultaneously on a lease boundary. Mitigation: submit is a compare-and-swap on `(task_id, claimed_by, status='claimed')`; second submitter gets `status: "rejected", reason: "not-claim-holder"`.

### Token cost surprises users
Even though it's the user's existing subscription, a full backlog could be ~100 small tasks. Mitigation: tool descriptions say "call when idle"; peek returns small batches (default 3); `recall maintenance stats` shows total work done so users see the picture.

## Phase Dependencies

- Phase 1 — additive migration, no external deps.
- Phase 2 — depends on Phase 1.
- Phase 3 — depends on Phase 2.
- Phase 4 — depends on Phase 3. `session_ended` signal already wired in `src/cli/hook.ts`.
- Phase 5 — depends on Phase 2.
- Phase 6 — depends on Phase 2. Hook adapters in `src/agents/` are already shipped.
- Phase 7 — depends on Phase 4.

## Recommendation

Ship Phases 1–3 together as the minimum useful unit: one producer (`refine_candidate`), the four MCP tools, one applier, and rollback. That alone demonstrates the whole pattern end-to-end and lets us stop patching LLM-shaped work into the deterministic path.

Add `summarize_history` next (Phase 4) — highest user-visible quality win, smallest validation surface. Keep `synthesize_repo` last; it's the biggest payload and the most error-prone, and it only matters once the rest are stable.

## Cross-References

- `src/maintenance/lifecycle.ts` — Tier-1 home; `enqueueMaintenanceTasks` lives alongside `runMaintenanceCycle`.
- `src/agents/` + `src/cli/hook.ts` — hook layer that surfaces `session_ended` (producer signal for `summarize_session`) and can peek the backlog on `session_started`.
- `src/capture/correction.ts` + `memories.capture_context` — inputs to `refine_candidate`.
- `findSemanticDuplicates` (embeddings module) — producer signal for `merge_duplicates`.

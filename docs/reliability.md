---
summary: How Recall measures delivery uncertainty and checks long-running installations.
read_when:
  - Diagnosing whether agents receive and use memories
  - Setting reliability targets or operating Recall over time
  - Testing database backups, local embeddings, or candidate retention
---

# Reliability and uncertainty

Recall reports what it can prove. A selected memory is not evidence that the
agent received it, and receiving a rule is not evidence that the agent followed
it. The reliability report keeps these stages separate:

1. `selected`: the compiler chose the memory and recorded an injection row.
2. `emitted`: the lifecycle hook returned a context block containing it.
3. `observed use`: an assistant completion matched the emitted memory.
4. `resolved outcome`: later tool or correction evidence marked the memory as
   followed, overridden, contradicted, or ignored.

Daemon HTTP feedback, hooks, and MCP now write the same canonical injection
outcome and value-event records. The separate device sync client exports
followed outcomes only for distinct resolved sessions whose original compiler
text snapshot matches the current memory. Reconstructed history and unresolved
delivery provide no positive proof; later negative evidence wins.

Run the report over the default 14-day window:

```bash
recall reliability
recall reliability --json
recall reliability --repo owner/repo
recall reliability --since 2026-09-01T00:00:00Z
```

The report treats existing directories without a Git checkout, such as
organization folders under `~/Projects`, as unscoped. They do not lower
repository-attribution coverage because no repository identity is established.
`session_scope_coverage` separately warns when fewer than half of recorded
sessions are scoped, and lists their common working directories. A perfect
attribution rate among a small scoped minority is not proof of broad delivery.

Repository discovery reads Git metadata directly, including worktree `.git`
files and `commondir`. It does not depend on `git` being available on a hook's
PATH. Deleted directories retain conservative path-based uncertainty rather
than automatically becoming unscoped.

## Reliability targets

The report starts with these operating targets:

| Signal | Target |
| --- | --- |
| Repository attribution for scoped sessions | at least 95% |
| Sessions with repository scope | at least 50% (warning only) |
| Selected memories emitted by the hook | at least 99% |
| Resolved outcomes once 20 or more memories were emitted (`outcome_loop`) | at least 1 |
| Emitted memories with a resolved outcome (`outcome_coverage`) | at least 80% (warning only) |
| Used or missed retrieval observations per 14 days | at least 20 (warning only: sample sufficiency) |
| Candidates still eligible for automatic injection | at most 50 in one repo |

A small retrieval sample cannot prove a retrieval failure. Database integrity and
the real retrieval canary are measured separately. A sustained failure streak
resets whenever the set of failing checks changes, so a new failure never
inherits the duration of a different resolved failure. On startup, the daemon
keeps the saved verdict available for diagnostics but only enables alerts after
a fresh computation with the running build.

An empty denominator is `warn`, not `pass`. Missing evidence never becomes a
successful outcome.

Recall resolves an outcome only from observable evidence: a tool call or
correction that matches the rule. A rule that did not apply in a session stays
unresolved, so unresolved injections mix "not applicable" with "missed".
`outcome_loop` therefore fails only when nothing resolves at all, which points
to broken tool or session-end hooks. A low `outcome_coverage` warns about
over-broad rules that are injected where they never apply.

## Agent-authored prompts

Codex records each thread's origin in the first rollout line. Prompts in
`exec`, subagent, and `mcp` threads are written by another agent or a script.
Recall still injects memory into those threads, but it never learns
corrections or outcomes from their prompts. The prompt event is recorded with
`automated: true`. An unreadable rollout is treated as an interactive thread.

Rules captured before this check existed are removed by the daemon's cleanup
tick (`reject_agent_authored`). A rule is rejected only when every piece of its
evidence is a session correction or repetition, and every one of those sessions
is a local Codex rollout with an automated origin. Explicit confirmation,
reactivation, other evidence, and sessions from another machine keep the rule.
Each rejection is audited and reversible with
`recall maintenance cleanup --revert <run-id>` or `reactivate`.

## Disposable canary

The canary creates a temporary database, teaches one synthetic rule, starts a
new lifecycle session, emits the rule, records assistant and tool evidence,
ends the session, and checks SQLite integrity. It removes the temporary data
afterward.

```bash
recall reliability --canary
recall reliability --canary --real-embeddings
recall reliability --probe --real-embeddings
```

The real-embedding form also generates the configured local embedding, verifies
the derived vector index, and performs native semantic retrieval. It lowers the
score cutoff only inside the disposable test because ranking and the product's
relevance policy are separate checks.

The daemon runs the complete real-embedding probe in a child process once per
day, so SQLite page cache, model memory, and native-extension failures leave
with that process instead of accumulating in the daemon. The probe checks
the live database and the newest backup with SQLite `quick_check`. `/health`
returns the latest probe and exact build information: commit SHA, build time,
and native/embedding dependency versions.

```bash
RECALL_RELIABILITY_PROBE_ENABLED=true
RECALL_RELIABILITY_PROBE_INTERVAL_SECONDS=86400
RECALL_RELIABILITY_PROBE_REAL_EMBEDDINGS=true
```

## Candidate retention

Candidates are provisional evidence. Recall keeps them searchable, but removes
them from automatic prompt injection after 30 days when they have never been
selected and have no second-session repetition. It does not reject or delete
them. Explicit confirmation restores automatic injection.

"Never selected" only counts as evidence when selection was possible. Recall
archives a candidate only when the injection ledger (`memory_injections`)
covers the whole window for the candidate's repository, with no stretch longer
than seven days without an injection. A global candidate counts injections in
any repository. When the daemon was not running, hooks were missing, or the
repository was not used, the candidate was unmeasured: the prune report lists
it under `Unconfirmed skipped (loop inactive)` and leaves it in rotation. The
same guard applies to stale candidates (`Stale skipped (loop inactive)`);
stale active memories are still archived. A candidate the compiler selected
but no agent reported an outcome for is excluded from the never-selected rule.

Preview or apply the same rule manually:

```bash
recall prune --candidate-days 30 --dry-run
recall prune --candidate-days 30
```

Restore candidates that were archived while the loop could not select them:

```bash
recall prune --restore-unmeasured --dry-run
recall prune --restore-unmeasured [--min-confidence 0.6] [--lookback-days 30]
```

This restores archived candidates at or above the restoration threshold (default
`0.60`) that were never injected and whose repository lacked injection coverage
both at archival time and during the current lookback window. Restoration
requires a matching auto-pruner archival audit whose after-snapshot still
matches the current memory. Foreign-sync quarantine, deliberate opt-outs,
missing archival history, and changes since archival remain untouched and
appear under `No pruner proof`. It skips destructive or trigger-shaped rules and
memories backed only by generated or non-user context; those need
`recall confirm`. Each restore is audited as `policy_applied` by
`auto-pruner`, and a second run restores nothing.

Set `RECALL_CANDIDATE_UNCONFIRMED_DAYS` to change the daemon maintenance limit.

The guards above keep measurement honest, but alone they would let a candidate
stay in automatic injection forever: repositories worked on from another
machine never show loop coverage, and a candidate that keeps being selected is
never "never selected". A hard age limit closes that gap. A candidate still
unconfirmed and seen in fewer than two sessions 60 days after creation leaves
automatic injection regardless of loop coverage or selection. It stays
searchable, `recall confirm` restores it, and `--restore-unmeasured` does not
reverse it. An explicit restore restarts the clock. Set
`RECALL_CANDIDATE_MAX_AGE_DAYS` to change the limit, or `0` to disable it.

## Backup guarantees

Daily backups use SQLite `VACUUM INTO`, which includes committed WAL data in a
consistent snapshot. Recall runs `quick_check` before placing the snapshot into
rotation. A failed snapshot is deleted and the existing backups remain intact.
Recall keeps two daily snapshots and the newest versioned install snapshot.
The daily reliability probe rechecks the newest retained backup.

## Release evidence

A release is ready for staged rollout when:

- the full test, typecheck, docs, and production-build gates pass;
- Windows x64 and ARM64 native-vector jobs pass;
- the disposable canary passes with real embeddings;
- a real agent process retrieves a newly taught memory from an isolated DB;
- a representative database copy passes pruning, backup, integrity, and soak
  checks;
- the deployed `/health` build SHA matches the release revision.

Roll out to one development machine first, then the second Mac, Linux services,
and Windows. Check the reliability report and daemon logs after each stage.

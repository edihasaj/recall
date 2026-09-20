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

Run the report over the default 14-day window:

```bash
recall reliability
recall reliability --json
recall reliability --repo owner/repo
recall reliability --since 2026-09-01T00:00:00Z
```

The report treats sessions at a workspace root or temporary test directory as
unscoped. They do not lower repository-attribution coverage because no repository
memory could apply there.

## Reliability targets

The report starts with these operating targets:

| Signal | Target |
| --- | --- |
| Repository attribution for scoped sessions | at least 95% |
| Selected memories emitted by the hook | at least 99% |
| Emitted memories with a resolved outcome | at least 80% |
| Used or missed retrieval observations per 14 days | at least 20 |
| Candidates still eligible for automatic injection | at most 50 in one repo |

An empty denominator is `warn`, not `pass`. Missing evidence never becomes a
successful outcome.

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

Preview or apply the same rule manually:

```bash
recall prune --candidate-days 30 --dry-run
recall prune --candidate-days 30
```

Set `RECALL_CANDIDATE_UNCONFIRMED_DAYS` to change the daemon maintenance limit.

## Backup guarantees

Daily backups use SQLite `VACUUM INTO`, which includes committed WAL data in a
consistent snapshot. Recall runs `quick_check` before placing the snapshot into
rotation. A failed snapshot is deleted and the existing backups remain intact.
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

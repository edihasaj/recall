---
status: active
read_when: "Commercial readiness check — run on or after 2026-05-09"
---

# Commercial readiness follow-up — check on 2026-05-09

One-week review for the memory-management and daemon reliability work shipped
through `6d71884`. Goal: decide whether Recall is ready for private alpha,
open-source preview, or paid commercialization.

## Current verdict

As of 2026-05-02:

- Personal daily use: yes.
- Private alpha with technical users: yes, with direct support.
- Open-source preview: likely, after docs/install polish.
- Paid commercial launch: not yet.

## Baseline from 2026-05-02

- DB version: `9/9`.
- Daemon health: `/health` responds immediately and after delayed embedding warmup.
- Memories: 267 total, 62 active, 143 candidate, 62 rejected.
- History snippets: 451.
- Memory injections: 2143.
- History injections: 0.
- Followed rate: about 0.6% of resolved injections over 14 days.
- Pending maintenance tasks: 18.
- Pending correction candidates: 79.
- Last cleanup run seen by doctor: 2026-04-28T22:48:38.

## What to check after one week

### 1. Reliability soak

```bash
recall doctor
curl --max-time 5 -fsS http://127.0.0.1:7890/health
```

Check:

- Launchd is installed, loaded, and running.
- `/health` responds without hanging.
- Last cleanup run is within 24 hours.
- Dispatcher last run is recent and successful.
- Pending task count is shrinking, not growing.

Commercial bar: no restart hangs, no wedged daemon, no silent stalled scheduler.

### 2. Memory quality

```bash
recall maintenance quality --snapshot --note "one-week commercial-readiness check"
recall maintenance quality --history
```

Check:

- Followed rate moved meaningfully above the 0.6% baseline.
- `ignored` is not still dominating the resolved outcome bucket.
- Candidate corrections are flat or decreasing.
- Contradicted/overridden counts are not growing quickly.
- `history_injections.total` is greater than 0.

Commercial bar: Recall can prove reused context is useful, not just frequently injected.

### 3. Duplicate/self-healing behavior

```bash
recall maintenance cleanup --list
recall contradictions detect
```

Check:

- Daily cleanup runs are happening.
- Cleanup action counts are small after the first few runs.
- No large new duplicate clusters.
- Contradiction count is stable or decreasing.

Commercial bar: routine dedupe should happen automatically. Manual cleanup should be rare.

### 4. Product trust controls

Check whether a normal user can answer these without reading code:

- What did Recall remember?
- Why was this memory injected?
- How do I fix a wrong memory?
- How do I delete/export my data?
- Is capture local-only, and what leaves the machine?

Commercial bar: user-visible inspect, correct, delete, and export paths are obvious.

### 5. Packaging/supportability

Check:

- App is signed/notarized or there is a clear distribution plan.
- Install and uninstall paths are documented.
- `recall doctor` gives enough detail for support.
- There is a logs/diagnostics bundle command or documented equivalent.
- Migration recovery is documented.

Commercial bar: a non-developer can install, diagnose, and safely remove Recall.

## Decision guide

- **Private alpha**: OK if daemon health is stable, doctor is clean, and support is direct.
- **Open-source preview**: OK if docs explain install, privacy, memory inspection, and cleanup.
- **Paid launch**: only after reliability soak passes, memory quality improves, and trust controls are user-facing.

If the one-week check still shows `history_injections=0`, stale cleanup, or a followed rate near baseline, do not commercialize yet. Continue with reliability and memory-quality work first.

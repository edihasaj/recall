# Capacity-controlled continuation

The first post-fix development run completed all 106 fresh requests, but
25 timed out under the unchanged 45-second transport deadline. Keep that
complete result as `temporal-ump-v2-fresh-2026-10-19.json`; do not replace its
scores or retry selected failed requests.

Read-only worker metrics after the run showed substantial other traffic:
both workers repeatedly approached their eight-sequence capacity, with observed
completion times exceeding the deadline. Router health alone reports liveness
and does not establish available inference capacity.

`temporal-v4-capacity-run.py` waits for both workers to have at most the configured
number of running requests and no waiting requests in three samples 20 seconds apart. It then
runs the following complete stages in sequence, applying the same admission
gate before each stage:

1. A fresh complete 106-call development repetition, saved separately as
   `temporal-ump-v2-capacity-fresh-2026-10-19.json`.
2. The fresh 57-call authored challenge.
3. The full fresh 434-question public comparison.

The controller verifies the frozen snapshot before starting. Model, prompts,
source data, token caps, transport timeout, concurrency limits and scoring are
unchanged. It never cancels another workload, changes router configuration,
retries a model request or hides the overloaded first attempt. Its state and
capacity samples are saved in the ignored data directory.

Admission occurs at stage boundaries. Other workloads can arrive during a
stage, so this does not reserve capacity or guarantee zero timeouts. Any later
failures still count under the frozen protocols.

```bash
uv run --no-project python benchmark/temporal-v4-capacity-run.py \
  --root . \
  --snapshot "$(cat /tmp/recall-v4-isolated-path.txt)" \
  --state benchmark/data/temporal-v4-headroom-controller-2026-10-19.json \
  --max-running 3
```

The metrics check uses the existing authenticated SSH path through MacBook to
the Spark cluster. No model keys or source prompts are printed. `--once` reads
one metrics sample without making any model requests.

The first controller used the default one-running-request threshold and was
superseded while still waiting, before making any model calls. The replacement
uses at most three other running requests per eight-slot worker, leaving at
least five free slots on each worker at stage admission. Both controller
records remain available. This changes operational admission only; it does not
change the frozen model, request deadline, case selection or scores.

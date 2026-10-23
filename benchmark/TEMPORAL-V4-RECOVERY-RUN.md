# Public repetition after a confirmed provider outage

Recorded on 19 October 2026 before this repetition's model calls.

The first complete public attempt remains at
`benchmark/data/temporal-v4-real-2026-10-19.json`. Both Spark hosts rebooted
at approximately 13:27:50–52 UTC. Router stacks restarted at 13:28:02–05,
and the Bubble model API finished starting at 13:30:58, after that attempt
ended at 13:30:13. Its HTTP 503 failures therefore include an observed backend
outage. The reboot cause is unknown.

At 13:33–34 UTC, read-only checks found both routers healthy, both worker
health endpoints returning HTTP 200, and two registered workers. No model
requests, workload cancellations, restarts or configuration changes were used
to restore service for this experiment.

Repeat the complete public comparison with the exact frozen runtime and
[public protocol](TEMPORAL-V4-REAL-PROTOCOL.md). Preserve all 434 exposed IDs,
the candidate, source/dependency hashes, prompts, Qwen model, reasoning mode,
temperature, output limit, 45-second deadline, concurrency, budgets and scoring.
Use fresh capture, query, answer and judge calls. This is another development
repetition, not a new holdout. There is no selective retry, source correction
or historical-answer reuse. The clean synthetic development repetition and
the completed authored challenge are not rerun.

Before launch, verify the original 21-file frozen runtime and require the same
capacity admission policy: both workers at most three running requests, zero
waiting requests, in three samples 20 seconds apart. Use the existing
controller's `--once` mode to obtain and retain each sample. Admission does not
reserve capacity or guarantee continued availability; any subsequent failure
still counts.

New artifacts:

- `benchmark/data/temporal-v4-real-recovery-2026-10-19.json`
- `benchmark/data/temporal-v4-real-recovery-2026-10-19.json.log`
- `benchmark/data/temporal-v4-recovery-controller-2026-10-19.json`

After admission, the command in the original isolated runtime is:

```sh
dgx run -- node --import tsx benchmark/temporal-real-v4.ts \
  --provider qwen-local --rerun-exposed-ids \
  --out benchmark/data/temporal-v4-real-recovery-2026-10-19.json
```

Use the original Node 22 environment and SQLite binding. The first public
attempt and its complete failure accounting remain visible in the results
report. The known event-versus-state capture defect remains in this frozen
candidate and must be audited in the repetition as well.

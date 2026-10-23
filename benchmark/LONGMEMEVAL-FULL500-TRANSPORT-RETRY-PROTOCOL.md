# LongMemEval full500 rerun with transport retry, 22 October 2026

## Why

The [premise-check full500 run](LONGMEMEVAL-FULL500-PREMISE-RECOVERY-PROTOCOL.md)
scored 454/500. Sixteen consecutive calls failed with `request_failed` during
a model-server outage and count as wrong; on the other 484 questions it scored
93.8%. That run's result stays as recorded. This protocol was written before
any call in this run.

## Configuration

Identical to the premise-check full500 run (minimal policy, supplemental
top-20 evidence on exact fresh E5 rankings, adaptive/16,384 answers, v4
premise check, one lower-effort retry for timeouts and unfinished answers,
one sample, concurrency three, unchanged none/4,096 judge), with one addition:
`--answer-recovery lower-effort-transport`. Any answer, premise-check or judge
call that fails before reaching the model (`request_failed`) is repeated with
the same prompt and settings up to three times, two minutes apart. The rule
depends only on the error type, never on the answer, verdict, reference or
question identity. Failed attempts are kept in `transport_failures`.

## Scoring and rules

Raw judged score is primary; the adjusted score uses the same pre-declared
model-kit rule as the previous run. Targets: 457/500, 27/30 unanswerable,
25/30 preferences, all seven original cases. One run. Remaining errors count
as incorrect. No reruns, rejudging, repair or reference changes after seeing
results. This is the second full500 run of this configuration family, so it
is not unseen data.

## Results

| Measure | This run | 454 run | 457 run | Target |
| --- | ---: | ---: | ---: | ---: |
| Correct (raw = adjusted) | **464/500** | 454 | 457 | 457 ✅ |
| Unanswerable | **27/30** | 29/30 | 24/30 | 27 ✅ |
| Preferences | **26/30** | 27/30 | 22/30 | 25 ✅ |
| Original seven | 4/7 | 5/7 | 6/7 | 7/7 ❌ |
| Errors | 0 | 16 | 6 | — |

No call failed, so the transport retry never fired; the lower-effort retry
recovered 3 answers. The premise check made 29 overrides, 6 of them on
answerable questions (the same 6 as the 454 run). Original-seven misses:
`0a995998`, `6d550036`, `dd2973ad`. Hindsight's published 473/500 uses
different models. The
[decision record](data/longmemeval-full500-transport-retry-decision-2026-10-23.json)
binds the supervisor, state, report and frozen source.

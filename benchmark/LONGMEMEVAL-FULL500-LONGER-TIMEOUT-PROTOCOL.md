# LongMemEval full500 run with same-effort timeout retry, 23 October 2026

## Why

The [transport-retry full500 run](LONGMEMEVAL-FULL500-TRANSPORT-RETRY-PROTOCOL.md)
scored 464/500 with zero errors and met the overall, unanswerable and
preference targets, but only 4/7 original cases. Two of those misses
(`0a995998`, `6d550036`) were counting questions whose high-reasoning answer
timed out; the lower-effort retry then answered at low reasoning and
miscounted. Dropping effort after a timeout trades an empty answer for a
likely wrong count. This protocol was written before any call in this run.
That run's result stays as recorded.

## Configuration

Identical to the transport-retry run, with one change:
`--answer-recovery longer-timeout-transport`. When an answer call times out,
exactly one more call is made with the same prompt at the same reasoning
effort and a 1,200-second deadline. When an answer returns an incomplete
response (output budget exhausted), the single retry still drops one effort
level as before. Calls that fail before reaching the model are still repeated
up to three times, two minutes apart. The rule depends only on the error type.

The premise check is unchanged. Its six recurring wrong overrides were seen
in full500 outcomes, so changing its wording now would tune on the test set.

## Scoring and rules

Raw judged score is primary; the adjusted score uses the same pre-declared
model-kit rule. Targets: 457/500, 27/30 unanswerable, 25/30 preferences, all
seven original cases. One run. Remaining errors count as incorrect. No reruns,
rejudging, repair or reference changes after seeing results. This is the
third full500 run of this configuration family, so it is not unseen data,
and the change was chosen after seeing the previous run's misses.

## Results

| Measure | This run | 464 run | 454 run | 457 run | Target |
| --- | ---: | ---: | ---: | ---: | ---: |
| Correct (raw = adjusted) | **472/500** | 464 | 454 | 457 | 457 ✅ |
| Unanswerable | **28/30** | 27/30 | 29/30 | 24/30 | 27 ✅ |
| Preferences | **28/30** | 26/30 | 27/30 | 22/30 | 25 ✅ |
| Original seven | **7/7** | 4/7 | 5/7 | 6/7 | 7/7 ✅ |
| Errors | 0 | 0 | 16 | 6 | — |

All four targets were met. The same-effort timeout retry fired once and
recovered that answer; no call failed before reaching the model. The premise
check made 29 overrides, 5 of them on answerable questions. Hindsight's
published 473/500 uses different answer and judge models, so the one-question
gap is not a matched ranking. Scores across three near-identical runs
(454, 464, 472) show large run-to-run variation; this is one run, not a
stable estimate. The
decision record
binds the supervisor, state, report and frozen source.

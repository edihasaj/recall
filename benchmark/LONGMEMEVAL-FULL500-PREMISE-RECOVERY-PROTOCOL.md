# LongMemEval full500 run: premise check with answer recovery, 22 October 2026

## Decision

The maintainer chose to stop using development60 as a pass/fail gate and to run the full
500-question benchmark once with the best supported configuration. This
protocol was written before any call in this run.

Development60 has been answered about ten times. Fresh runs of the same
answer path scored 53 to 58, and re-scoring the saved answers showed that the
answers change from run to run while the judge stays mostly consistent
(correction record).
A 58/60 bar with all seven original cases therefore measured chance more than
quality. Follow-up100 is skipped for the same reason; the full run contains
all of its questions.

## Configuration

The frozen [answer-recovery candidate](LONGMEMEVAL-ANSWER-RECOVERY-GATES-PROTOCOL.md),
unchanged: `benchmark/longmemeval-qa.ts` with supplemental top-20 evidence on
the exact fresh E5 rankings, `--answer-policy minimal`, adaptive Qwen
reasoning with a 16,384-token answer limit, robust transport, the v4 separate
premise check (`--answer-check premise`), one lower-effort retry for timed-out
or unfinished answers (`--answer-recovery lower-effort`), one answer sample,
question concurrency three and the unchanged none/4,096 judge. Three-sample
voting is left out because it roughly triples answer tokens.

Source: the read-only copy archived as
`data/longmemeval-answer-recovery-source-2026-10-22.tar.gz`. Pins:
`longmemeval-qa.ts` `bcb0a853…`, `longmemeval-qa-support.ts` `8271c057…`,
`longmemeval-premise-check.ts` `31cd42ca…`, Node v22.23.4 `2cc28a18…`.

## Scoring

The raw judged score is the primary result and is never edited.

An adjusted score changes one question only. `gpt4_59c863d7` (model kits)
has a reference of five, but two independent source reviews
([review](LONGMEMEVAL-MODEL-KIT-SOURCE-REVIEW.md)) found the evidence supports
four or five. In the adjusted score that question counts as correct when the
first number written as a count of kits in the saved answer ("4 model kits",
"five kits", up to four words between the number and "kit") is 4 or 5. The
rule reads only the answer text and is applied by the supervisor after the
run. Before any call it read 4 from all four saved development answers to
this question; a model designation such as "B-29 bomber model kit" can only
withhold credit. The supervisor's SHA-256 is recorded in its state file.

Both scores are reported against Hindsight's published 473/500 (94.6%) and
Recall's previous 457/500 (91.4%), with the earlier full-corpus targets as
descriptive checks: 457/500, 27/30 unanswerable, 25/30 preferences and all
seven original cases. Different answer and judge models mean neither
comparison is a matched system ranking.

## Rules

One run. Remaining errors count as incorrect. No other retries, answer
repair, rejudging, reference changes or reruns after seeing the result.

## Results

| Measure | This run | Previous 457 run | Target |
| --- | ---: | ---: | ---: |
| Correct (raw) | **454/500** | 457/500 | 457 |
| Correct (adjusted) | 454/500 | — | — |
| Unanswerable | **29/30** | 24/30 | 27 |
| Preferences | **27/30** | 22/30 | 25 |
| Original seven | 5/7 | 6/7 | 7/7 |
| Errors | 16 | 6 | — |

Sixteen consecutive calls (rows 242–257, mostly temporal questions) failed
with `request_failed` during a model-server outage; the runner does not retry
that error, so they count as wrong. On the 484 questions without an error the
run scored 93.8%. The premise check made 31 overrides, 6 of them on answerable
questions; the recovery retry fired 3 times and recovered all 3. `0a995998`
and `32260d93` missed. The model-kit question was judged correct, so the
adjusted score equals the raw score. The
decision record
binds the supervisor, state, report and frozen source.

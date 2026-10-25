# LongMemEval premise check with answer recovery, 22 October 2026

## Candidate

This candidate is the [v4 premise-check candidate](LONGMEMEVAL-PREMISE-CHECK-GATES-PROTOCOL.md)
plus `--answer-recovery lower-effort`. When an answer call ends in `timeout`
or `response_not_completed`, the runner makes exactly one more answer call
with the same prompt at the next lower reasoning effort: high or medium to
low, low to none. An answer already at none is not retried. Any other error
is not retried. The rule depends only on the error type, never on the answer,
judge verdict, reference or question identity. Both calls are kept in the row
as `failed_answer_call` and `answer_call`, with `answer_recovered`.

## Why this rule

Unfinished answers decided the last several gates. The 457/500 run lost five
preference questions to three 600-second timeouts and two exhausted output
budgets. The minimal-policy follow-up100 lost one unanswerable case to an
exhausted budget, and the v4 premise-check development60 failed gate 1 by one
answer that spent all 16,384 tokens without finishing. Retrying at the same
effort and temperature zero would likely repeat the same loop, so the retry
lowers effort. This rule was written before any run that uses it.

Earlier protocols banned selective retries. This rule is not selective: it is
a fixed part of the candidate, applied to every question by error type, and
declared before its first call. It does not rescue earlier rejected runs.

## Serial gates

1. Fresh development60 on the protected extended rankings: at least
   **58/60 and all seven original cases**.
2. Only after that pass, the locked lexical follow-up100: at least
   **93/100 and 14/16 unanswerable**.
3. Only after that pass, all500 on the exact fresh E5 top-20 rankings: at
   least **457/500, 27/30 unanswerable, 25/30 preferences and all seven
   original cases**.

A failed gate stops later stages. Errors that remain after the one recovery
call count as incorrect. No other retries, answer repair, rejudging,
reference changes, gate relaxation or tuning from follow-up or full-corpus
outcomes is permitted. Development60 has been run repeatedly and is not
unseen data.

## Runtime

Runs use the read-only Node v22.23.4 copy (ABI 127) recorded in the premise
check protocol, `dgx run`, a frozen read-only source copy and one supervisor
that records each gate verdict.

## Results

| Stage | Result | Gate | Outcome |
| --- | ---: | --- | --- |
| Development60 | **57/60**, 6/7 original, 0 errors | 58/60, 7/7 | Fail |
| Follow-up100 | Not started | 93/100, 14/16 | Not run |
| Full500 | Not started | 457/500, 27/30, 25/30, 7/7 | Not run |

No answer timed out or ran out of budget in this run, so the recovery rule
never fired, and the premise check made no overrides. The misses were
ordinary answer misses: the disputed model-kit count, `852ce960`, and
original-seven `3a704032`, answered as 1 or 2 plants against a reference of 3.
The decision record
binds the supervisor, state, report and frozen source.

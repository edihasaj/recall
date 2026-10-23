# LongMemEval three-sample answer voting, 22 October 2026

## Candidate

This candidate is the [answer-recovery candidate](LONGMEMEVAL-ANSWER-RECOVERY-GATES-PROTOCOL.md)
(minimal policy, supplemental top-20 evidence, adaptive/16,384 answers, v4
premise check, lower-effort recovery) plus `--answer-samples 3`.

Each question gets three independent answer calls with the same prompt and
settings; each may use the one recovery call. For every pair of parsed
answers, a reasoning-none check sees only the question and the two final
answers and reports whether their core results match. Identical texts skip
the check. The answer that agrees with the most others is used; ties go to the
earliest sample, so three different answers fall back to the first. The
premise check then runs on the chosen answer as before. Selection never sees
evidence, references, judge verdicts or question identity. All samples and
agreement calls are kept in `answer_samples`. Question concurrency is two, so
at most six answer calls run at once.

## Why this rule

Six fresh development60 runs on the same answer path scored 53 to 58, and
different original-seven cases failed from run to run (`dd2973ad`,
`32260d93`, `3a704032`, `0a995998`). The last two candidates failed gate 1 on
ordinary answer misses, with no premise override or recovery involved. A
majority of independent samples should reduce this run-to-run variation. It
roughly triples answer tokens. Unlike the rejected two-draft comparison, no
model writes a new answer; a fixed vote picks one of the sampled answers.
This rule was written before any run that uses it, and no number of samples
or agreement wording was tuned on outcomes.

## Serial gates

1. Fresh development60 on the protected extended rankings: at least
   **58/60 and all seven original cases**.
2. Only after that pass, the locked lexical follow-up100: at least
   **93/100 and 14/16 unanswerable**.
3. Only after that pass, all500 on the exact fresh E5 top-20 rankings: at
   least **457/500, 27/30 unanswerable, 25/30 preferences and all seven
   original cases**.

A failed gate stops later stages. Remaining errors count as incorrect. No
other retries, answer repair, rejudging, reference changes, gate relaxation
or tuning from follow-up or full-corpus outcomes is permitted. Development60
has been run repeatedly and is not unseen data.

## Runtime

Runs use the read-only Node v22.23.4 copy (ABI 127), `dgx run`, a frozen
read-only source copy and one supervisor that records each gate verdict.

## Results

| Stage | Result | Gate | Outcome |
| --- | ---: | --- | --- |
| Development60 | **57/60**, 6/7 original, 0 errors | 58/60, 7/7 | Fail |
| Follow-up100 | Not started | 93/100, 14/16 | Not run |
| Full500 | Not started | 457/500, 27/30, 25/30, 7/7 | Not run |

The three samples agreed on 49 questions and split two to one on 11. The vote
chose a later sample on 7 questions, and all 7 were judged correct, including
four original-seven cases that missed in earlier runs (`0a995998`,
`6d550036`, `3a704032`, `dd2973ad`). The three misses were shared by the
samples: the disputed model-kit count, and the preference questions
`32260d93` and `caf03d32`, where every sample recommended several categories.
A vote cannot fix a miss that every sample makes. Answer calls used 6.8 million
tokens. The [decision record](data/longmemeval-answer-voting-gates-decision-2026-10-22.json)
binds the supervisor, state, report and frozen source.

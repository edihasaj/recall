# LongMemEval minimal-policy v2 with voting, 22 October 2026

## Candidate

This candidate is the [three-sample voting candidate](LONGMEMEVAL-ANSWER-VOTING-GATES-PROTOCOL.md)
(supplemental top-20 evidence, adaptive/16,384 answers, v4 premise check,
lower-effort recovery, three samples with a fixed vote) with one change:
`--answer-policy minimal-v2` replaces `minimal`. Version 2 is the minimal
policy with one line removed: "Do not invent negative preferences to balance
positive interests. If the request asks what the person would not prefer and
the evidence does not establish that, say that the negative preference is not
established." Every other line is unchanged.

## Why this change

The removed line conflicts with the task's own answer guidelines, which ask
recommendation answers to say "They would not prefer [what to avoid based on
context]." Re-scoring every saved development60 answer five times with the
unchanged judge (correction record)
showed that gate 1 is decided by the answers, not judge variation. The four
preference answers that said no negative preference was established averaged
a 0.5 re-score rate, against 0.92 for the other 36. Four answers are too few
to prove a cause; the change was chosen after seeing development data, and
the locked follow-up and full cohorts decide whether it holds.

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
or tuning from follow-up or full-corpus outcomes is permitted. The disputed
model-kit case `gpt4_59c863d7` still counts as written. Development60 has
been run repeatedly and is not unseen data.

## Runtime

Runs use the read-only Node v22.23.4 copy (ABI 127), `dgx run`, a frozen
read-only source copy and one supervisor that records each gate verdict.
Question concurrency is two.

## Results

| Stage | Result | Gate | Outcome |
| --- | ---: | --- | --- |
| Development60 | 26/28 when stopped, 2 original-seven misses | 58/60, 7/7 | Fail |
| Follow-up100 | Not started | 93/100, 14/16 | Not run |
| Full500 | Not started | 457/500, 27/30, 25/30, 7/7 | Not run |

Two original-seven cases missed within the first 28 questions, so gate 1
could no longer pass and the supervisor was stopped; the partial report is
kept. `0a995998`: all three samples answered 2 and offered 3 only as a
conditional reading. `32260d93`: all three samples again recommended several
categories, so removing the negative-preference line did not fix it. The
decision record
binds the supervisor, state, partial report and frozen source.

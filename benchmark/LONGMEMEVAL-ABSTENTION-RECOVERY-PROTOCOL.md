# LongMemEval abstention recovery replay, 23 October 2026

## Hypothesis and scope

The historical 472/500 run replaced 29 draft answers after a negative premise
check. Twenty-four replacements were correct abstentions; five were answerable
questions. A bounded source search and answer review might recover an overly
strict rejection while preserving useful abstentions.

An offline screen on repeatedly evaluated public data tested global keyword/E5
fusion. None of the tested variants improved complete marked-source coverage.
Applying the smallest keyword reservation only to the historical negative
premise cohort recovered one missing marked source without losing marked-source
coverage for another answerable member of that cohort. This post-hoc diagnostic
motivates the treatment; it is not held-out evidence or an answer score.

This experiment is separate from the paired high-effort pilot. Neither its
selection nor its decision rule changes the earlier pilot's fixed rules.

## Frozen treatment

Use the complete, unchanged 500-row historical report, SHA-256
`9cba4555cad8031eec9e404d96ae4f7065c302cbacfa8a87f1232c0b9e0105f0`,
and the original input and ranking files whose hashes that report records.
Select every row with `premise_override === true`, regardless of correctness,
reference answer, question category or abstention label. There are 29 such rows.
No question-specific exception is permitted. The new freeze uses Node 24 and
its pinned dependencies; the historical baseline used Node 22. This replay
does not control for that shared runtime refresh.

For each selected question:

1. Retain the first 18 exact E5-ranked source occurrences. Retrieve up to 40
   sources with the existing production keyword implementation using the
   original question. Append the first two distinct occurrences outside those
   18. Preserve neutral source labels and the original source fingerprints.
   Fail preparation before model calls if two distinct sources are unavailable.
2. Render the resulting 20 sources with the existing supplemental renderer,
   its system evidence policy, and the same 180,000-character context budget.
3. Review the original pre-premise draft using the existing grounded answer
   review prompt, original question, reference clock and task contract, and
   the refreshed evidence. Reviewers receive no answer key, judge verdict,
   original source IDs, category, or abstention label.
4. Use Qwen with strict JSON, medium reasoning and an 8,192-token output
   budget. Preserve the existing History and minimal-answer system policies.
   Use the bounded native transport with a 600-second request deadline, no
   additional review retry, and at most three question pipelines. Existing
   transient HTTP backoff in the model-call adapter remains unchanged.
5. Judge the reviewed answer with the original fixed judge prompt, Qwen,
   no reasoning, and a 4,096-token output budget. References enter only this
   scoring call. Do not rejudge an unfavorable verdict.

This is a combined retrieval-and-review treatment. It does not isolate either
component's effect. Retain failed calls, unknown usage, answers, source changes
and prompt hashes. Journal logical-call starts and finishes, with adapter HTTP
attempt counts. The adapter preserves final-response usage only; earlier HTTP
attempt usage is unknown, and reported known tokens are a lower bound.
An error or malformed review/judge output makes the trial
ineligible to advance; it must not silently disappear from the denominator.
No live calls occur without `--live`. Injected test calls are invalid as
benchmark evidence. Reserve fresh output paths and freeze code, dependencies,
runtime, protocol and inputs before starting model calls.

## Accounting and decision

Keep the other 471 historical answers and verdicts unchanged. Report the
500-question **mixed saved-answer replay**, its difference from 472/500,
the 29 newly reviewed cases, paired gains/losses, every error, actual usage
and latency. This is not a fresh full500 run and cannot replace the public
94.4% result.

A numerical advancement screen requires all 29 reviews and judges to finish
without unresolved errors, a mixed replay score of at least **476/500**, and
no historically correct unanswerable case becoming incorrect. Independent
source review of all paired gains is additionally required before advancement;
preserve ambiguity and unsupported-claim findings alongside the judge's score.
A fresh full-corpus run of the integrated treatment would need its own frozen
protocol before a new public benchmark result could be considered.

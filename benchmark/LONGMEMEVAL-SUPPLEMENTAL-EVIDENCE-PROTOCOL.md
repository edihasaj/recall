# LongMemEval supplemental evidence experiment

## Motivation and scope

The fixed-high E5 full run scored 457/500. An offline diagnostic excludes both
the original validation100 and locked follow-up100 before inspecting outcomes.
The remaining 300 questions contain 25 failures: 13 with missing marked source
turns, ten with all marked turns visible, and two answer timeouts. Marked-turn
coverage is a scorer proxy; it does not establish necessary or sufficient
evidence.

A same-budget top20 rendering diagnostic recovers evidence for some failures
but also displaces previously visible evidence. Simply increasing the number
of equally budgeted full sessions is therefore not the proposed change.
The diagnostic is repeated public-corpus development, not new validation.
The reserved cohorts and all numerical gates remain unchanged.

## Fixed representation hypothesis

Preserve the original ten-source highlighted evidence byte for byte. Use only
remaining space in the same 180,000-character budget to append query-focused
verbatim excerpts from ranked sources 11 through 20. This tests whether deeper
retrieval can add useful evidence without displacing existing source text.

The primary ten receive the original full budget and unchanged renderer.
Process supplemental sources in ranked order. Use the application's complete
unit renderer with its existing speaker preference and 4,000-character
per-source ceiling. Selection receives only the original question and source
text. Preserve roles, scope, negation, dates and exact UTF-16 ranges.

Every included supplement has a unique neutral label and its source date.
Count all framing and omission marks against the same cap. Omit a supplement
when no complete unit fits; record its reason and empty ranges. Do not crop
units, change original ten-source text, or discard an invalid source silently.
No source IDs, relevance labels, references, categories or judge outcomes may
influence the runtime representation.

For at most ten sources, the output must match the existing highlighted
renderer. For more sources, the original evidence must remain an exact prefix,
and its first ten source metadata entries must remain identical. Reject inputs
with more than twenty rows. Supplemental selection validity does not establish
relevance or accuracy.

## Offline gates before any answer experiment

1. Synthetic tests must verify byte preservation, exact ranges, role and scope
   preservation, hard budgets, omission accounting, neutral labels, duplicate
   source occurrences and rejection of unsupported inputs.
2. Independently review the implementation and verify prior modes unchanged.
3. Freeze source and protocol before corpus rendering. Exclude both reserved
   validation cohorts before inspecting scorer annotations or outcomes.
4. Render all 300 diagnostic cases before scoring source coverage. Make no
   answer or judge calls. Record every rendering failure.
5. Require zero lost primary evidence ranges and no lower complete marked-turn
   coverage. Report extra sources and characters, recovered and still missing
   turns, and errors. A coverage gain is not an answer-accuracy gain.

Do not tune size limits or routing from these coverage outcomes. Reject this
representation if the offline invariants fail. If it passes, integration into
the answering harness and a separately frozen answering plan require their own
implementation checks, source/dependency provenance and independent review.
No model calls are authorized by an offline preflight alone.

## Accuracy gates remain fixed

Any future answering trial must use the original development60 cohort and
retain at least 58 correct answers and all seven original cases. Only a pass
permits the locked lexical follow-up100, requiring 93/100 and 14/16
unanswerable. Only that pass permits exact fresh-E5 full500, requiring at least
457/500, 27/30 unanswerable, 25/30 preferences and all seven original cases.

The raw corpus, reference answers, judge, original task contract and rejected
outputs remain unchanged. No selective answer retries, output repairs,
rejudging, gate relaxation or scoring exceptions are allowed. The separately
documented reference errors remain visible.

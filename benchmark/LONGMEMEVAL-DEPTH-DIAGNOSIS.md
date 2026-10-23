# LongMemEval retrieval depth diagnosis

The best fixed-high E5 run scored 457/500, but a relevant-session hit did not
guarantee that every needed source was retrieved. This offline review examines
the 300 questions outside the original validation100 and locked follow-up100.
Both reserved cohorts were excluded before inspecting their outcomes.

## Failure accounting

| Evidence condition | Correct | Incorrect |
| --- | ---: | ---: |
| Every marked turn visible, request completed | 273 | 10 |
| At least one marked turn missing | 2 | 13 |
| Answer request failed | 0 | 2 |
| Total | 275 | 25 |

These are previously evaluated public development questions, not an unseen
holdout. Source annotations are scorer proxies: missing a marked turn does not
prove it was necessary, and showing every marked turn does not prove semantic
completeness.

## Deeper retrieval under the same budget

All 300 cases were rendered at top10 and top20 using the same frozen E5 cache,
highlighted renderer and 180,000-character cap. All 600 rendering attempts
finished before source annotations or answer outcomes entered scoring.
Top10 text and source metadata matched the historical report for every case.

| Coverage | Top10 | Top20 |
| --- | ---: | ---: |
| Questions with all marked turns visible | 285/300 | 281/300 |
| Visible marked turns | 593/609 | 584/609 |
| Rendering failures | 0 | 2 |

Top20 recovered complete marked evidence for ten of the thirteen failures with
missing evidence. It also lost complete coverage on fourteen previously
correct cases: twelve through clipping and two through rendering failures.
It regained ten turns and lost nineteen. The remaining three failed questions
have four marked turns outside the entire cached top20 list; this cannot
distinguish a lower rank from a retrieval miss.

Simply increasing the number of full sessions under the same shared budget
therefore has regression exposure. This experiment made no new answer calls
and establishes no answer-accuracy change.

The two rendering errors were distinct:

- `2788b940`: `Highlighted full-session markers exceed context cap`, from the
  bounded full-block allocation loop.
- `8cf51dda`: `max_chars is too small to render an evidence label and a complete
  source unit`, from preview selection.

Both remain recorded as failed renders. The old source and outcomes were not
repaired.

## Embedding prefix limitation

The local E5 tokenizer has a 512-token limit, and Transformers' feature
extraction pipeline enables truncation. A tokenizer-only diagnostic found
sixteen missing marked turns across fifteen eligible questions, including two
questions answered correctly. Eight of those turns begin conservatively beyond
the retained embedding prefix.

This supports investigating representations of long sessions. It does not
establish why hybrid retrieval missed a source: keyword retrieval indexes the
full text. No embedding inference, answer calls, or model downloads were
performed for this diagnostic.

## Original development evidence

A separate audit of the original development60 cohort found 112/113 marked
turns visible and 59/60 cases completely covered, both before and after
supplementation. The broader 300-case coverage gain therefore does not describe
an added marked-turn gain on these sixty cases.

The sole missing marked turn belongs to `6d550036` and concerns presenting the
user's research. It is absent from both frozen ranking lists, rather than
clipped. An independent source-only review then scanned all 249 user turns in
that case without reading its reference, judge verdicts or Azure partial
answers. It found direct past and current team-leadership statements, including
unmarked source context about leading five engineers. All three direct
self-leadership assertion turns and their full sessions were already
delivered. The missing poster source does not explicitly establish leadership.

This confirms a marked-source retrieval gap while leaving its relevance to
the answer unresolved. Neither adding that source nor counting marked sessions
alone can establish the correct project count. The bounded role/entity review
records its interpretation and identity uncertainties without forcing a count.
Evidence and reproduction scripts are preserved under
`longmemeval-original60-marked-coverage-diagnosis-*` and
`longmemeval-6d550036-all-user-source-review-*` in `benchmark/data`.

## Proposed next experiment

The [supplemental-evidence protocol](LONGMEMEVAL-SUPPLEMENTAL-EVIDENCE-PROTOCOL.md)
preserves the original top10 evidence exactly and uses spare context space for
complete excerpts from deeper results. It must first pass implementation,
independent review and offline coverage checks. No answering gain is claimed.
Existing accuracy gates and both reserved cohorts remain unchanged.

The frozen supplemental implementation passed independent review, strict type
checking and a full copied-app integration run with 1,310 tests passed and three
skipped. Its complete offline300 audit then passed:

| Coverage | Original top10 | Supplemental |
| --- | ---: | ---: |
| Questions with all marked turns visible | 285/300 | 293/300 |
| Visible marked turns | 593/609 | 601/609 |
| Lost original evidence | — | 0 |
| Rendering failures | 0 | 0 |

All eight coverage gains were previously incorrect answers. Every primary
prefix and its source metadata matched the historical report. Supplemental
text added 7,056,229 framed characters in total, about 23,521 per question,
while retaining the same per-question 180,000-character cap. There were 2,890
included extra sources and 110 omissions: 108 for budget and two with no
complete selectable unit. Seven cases still lack complete marked coverage.

The independent result checks verified 28,927 exact UTF-16 ranges and all
budgets. The allocator uses a conservative framing adjustment; this does not
prove maximal packing or semantic completeness. The coverage audit generated
and rejudged no answers.

The answer integration has since passed independent review, 118 controlled tests
across fifteen explicit files, and 1,316 current-app tests with three skipped.
The [answer-trial protocol](LONGMEMEVAL-SUPPLEMENTAL-ANSWER-PROTOCOL.md)
retains the original development sources while extending every ranking by a
gold-blind merge of two frozen retrieval runs. The source and dependencies are
frozen, and the fresh development60 answering stage completed at **57/60 with
zero request errors and six of seven original cases correct**. It failed both
gates; no follow-up100 or full500 answering stage started.

The failures were the clothing count (`0a995998`), an overly narrow model-kit
count (`gpt4_59c863d7`) and dismissal of a later mortgage correction (`852ce960`).
Compared with the frozen adaptive control, two answers improved and two
regressed. The total remained 57/60. These graded failures had the relevant text
delivered. The clothing count remains a documented source ambiguity rather than
an established model error; added coverage did not resolve the grading
disagreement or the other two interpretation failures.

The independent completed-run audit verified every source, evidence and prompt
hash, verdict, inference setting, indexed JSONL record and pinned dependency.
All 120 calls completed on their first attempt with usage known. The run used
2,278,473 tokens in 2,065.367 seconds. The source experiment and coverage gain
remain preserved; neither is an accepted answer-accuracy improvement.

## Evidence and reproduction

Depth audit source, bootstrap, frozen provenance, exclusions, full compressed
render records and scorer evidence are retained under
`benchmark/data/longmemeval-depth-diagnostic-*`. The bootstrap verifies the
frozen archive and reconstructs the diagnostic without rebuilding dependencies.
The original copied dependencies were unavailable; existing root dependencies
were used, with all renderer source hashes and 300 historical top10 render
matches verified.

Tokenizer evidence and its reproduction script are
`longmemeval-e5-token-prefix-diagnostic-2026-10-20.json` and `.mjs` in
`benchmark/data`. Temporary first-attempt audit files disappeared before
preservation; the preserved artifacts come from complete reruns, with that
limitation recorded.

Supplemental source, implementation review, freeze manifest, complete renders,
source-coverage scoring, and separate result checks are preserved under
`longmemeval-supplemental-*`. A failed shared-runtime test attempt and missing
assets in an initial copied integration attempt remain recorded. During native
dependency setup, an isolated `npm rebuild` unexpectedly changed the shared
SQLite binary too. Direct compilation in a separate package copy reproduced
the exact original Node24 binary; only those matching original bytes were
restored. The final full gate used a separate Node22 binary. The before/after
hashes and recovery record are preserved; no shared-byte-preservation claim is
made for the intervening setup.

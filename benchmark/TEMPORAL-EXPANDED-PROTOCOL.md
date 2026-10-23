# Expanded temporal evaluation protocol

Recorded on 18 October 2026 before the expanded model runs.

The 25-case development pilot is insufficient evidence for replacing Recall's
memory engine. The next experiment keeps the temporal resolver and answer
prompt fixed while testing fresh synthetic scenarios, repeated inference,
source attribution, and extraction from source language.

## Questions being tested

1. Does temporal selection remain correct across many dates, source cutoffs,
   explicit replacements, conflicts, and repositories?
2. Does the answer gain persist on fresh scenario families and repeated model
   runs, rather than depending on the original 25 development questions?
3. Does the gain preserve exact source-event citations and static facts?
4. Can the model obtain the necessary structured fields from ordinary source
   statements without access to question answers?

## Frozen comparison

The model-answer experiment uses Recall's default SessionStart compiler, the
temporal snapshot prototype, full source history, and a stronger query-scoped
history control. The latter retains every version for the same supplied
subject/property and lets the model resolve dates; it tests whether simple
relevance filtering explains the gain. These controls do not claim to represent
every configured Recall hybrid-search or connected-model path.

All arms receive the same original source assertions, answer prompt, model,
reasoning mode, evidence cap, and output cap. The planned model is
`qwen3.8-flash-next` with reasoning disabled, an 8,000-character evidence cap,
and a 512-token answer limit. Answer failures and malformed output count as
incorrect. Failed questions are not selectively retried.

The store, existing development fixtures, and answer instructions remain fixed
for the expanded evaluation. Harness refactoring may accept an explicit new
dataset and record repeated runs, but must preserve the development defaults.
Source hashes and invocation metadata identify each experiment's actual code.
The frozen resolver SHA-256 is
`4c2d92e70be999007086b79f591cb4e75090989f3e32a3cf1927e89d65e83cc2`;
the assembled answer-system prompt SHA-256 is
`7c6141b301a5fcb96e9aaec8ebeaf4aaa3ce31f1160016f358ef7d6eb32a6a64`.

## Fresh synthetic scenarios

Ten new scenario templates generate four worlds each, with two questions per
world: 40 worlds and 80 questions. Half include irrelevant facts in the same
repository. The categories include planned switches, retrospective corrections,
exclusive expiry, expired successors, independent conflicts, replacement chains,
out-of-order independent intervals, static facts, repository isolation, and
unknown answers.

Three runs reuse the same 80 questions, for 240 question trials and 960 answer
attempts across four representations. A shared limiter keeps total active model
calls at six even when two runs execute concurrently.

These worlds are generated variants within ten authored templates. Neither
renaming entities nor repeating inference creates new independent real-world
evidence. Results must report the 80 distinct questions, 40 worlds, ten
templates, and three repeats separately.

## Measurements

The primary quality metric requires exact values, conflict status, and source
`event_id` citations. Exact answers without citation correctness are secondary.
Report failures separately while retaining them in both denominators.

Report each representation's evidence size, source coverage, token measurements
or explicit unknowns, and model latency. Static-fact cases are a regression
control. Category and clean/noise results expose concentrated failures.

Average repeated observations for each question before computing paired
differences. Aggregate within worlds and use paired cluster resampling for
uncertainty. World-level intervals are exploratory because worlds share
templates. Report template-cluster intervals and leave-one-template-out paired
differences for the integration recommendation. With ten templates, uncertainty
remains substantial.

A separate deterministic check uses at least 500 generated worlds and 1,000
queries against independently authored expectations. This measures the
structured resolver's semantics and does not count as model answer accuracy.

## Extraction probe

A separate fixed-schema raw-source probe contains eight worlds, sixteen source
statements, and nineteen natural-language questions. It presents only source
statements, identifiers, source timestamps, and earlier raw sources to an
extractor. It receives no evaluation question, expected answer, or gold field
values. Independently annotated fields measure extraction and replacement-link
errors. A separate parser receives question text and repository metadata.
Evaluate all downstream queries, including upstream failures, against the
extracted store as well as the ideal structured-input store.

This probe must include ordinary dated source language and static facts.
Changing facts, one-task instructions, and multi-valued properties need explicit
boundaries; this prototype does not solve general conversational memory by
receiving perfect structured inputs.

## Adoption rule

No automatic deployment or wholesale memory replacement follows from these
runs. A consistent gain on fresh synthetic scenarios can justify further
integration work. It does not establish public-benchmark superiority or
production reliability.

For further integration work, the predeclared useful gain is at least five
percentage points in grounded accuracy against the strongest control, with
the paired template-cluster 95% interval above zero. The static-fact regression
margin is five percentage points. Request/malformed failures should be at most
5%; the small extraction probe should reach at least 90% exact source records
and 90% grounded downstream queries before it supports automatic intake.
These are development hurdles, not production guarantees, and a failed hurdle
must be reported rather than relaxed after results arrive.

Existing coding-rule capture,
promotion, scope, and lifecycle injection remain distinct responsibilities.
Cloud synchronization and real-session validation still require separate work.

# Temporal integration rehearsal: 18 October 2026

Keep the structured temporal prototype experimental. Broader source-language
testing exposed capture and entity-resolution failures that block automatic
integration. The timeline engine and ordinary-memory coexistence passed their
deterministic checks.

The [protocol](TEMPORAL-CATEGORIES-PROTOCOL.md) was recorded before these model
runs. Preflight review corrected evaluator defects before freezing the source:
opaque fixture identities, a declared predicate ontology, exact calendar
validation, failure accounting, separate empty-result scores, preserved
timestamp precision, complete abstention matching, a reserved augmentation
budget, and shared request permits. The source and prompts remained unchanged
during the completed evaluations.

## Ordinary-memory coexistence

The matrix covered five memory types, five sources, five scopes and four
statuses: 125 worlds containing 500 ordinary rows. Each world also received
four temporal rows, including independent and replacement assertions.

The existing default compiler, the compiler with the actual SessionStart limits
(three lines and 500 tokens), and the query-aware compiler with vectors disabled
were compared before and after temporal writes. Four request contexts per
compiler yielded **1,500 comparisons, with zero selection differences**.
Rejected and transient rows had otherwise eligible confidence, so their
exclusion could not be explained by a low-confidence threshold.

Replay, conflicting replay, repository isolation, earlier snapshots, current
snapshots, source history, and `VACUUM INTO` backup/reopen controls passed.
Inherited relevance-model, reranker and HyDE settings were disabled and restored;
sentinels verified that this deterministic experiment made no model calls.
Whole-store purge was not tested.

This matrix checks coexistence on manually seeded rows. It does not establish
that automatic capture produces every valid type/source/scope combination, nor
does it prove all existing scope behavior correct. The query-aware arm exercised
its lexical path with embeddings disabled, rather than a fresh vector search.

## Source-language routing and extraction

The fixed-ontology probe used **71 source statements in 14 worlds**, spanning
28 authored families, and **45 structured downstream questions**. Source
identities and repository names were opaque in model inputs. Extraction saw
only the current source and earlier raw sources, without evaluator labels,
questions or answers. All 71 model calls used `qwen3.8-flash-next`, reasoning
disabled, and a 512-token output limit; three worlds could run concurrently.

| Measurement | Result |
| --- | --- |
| Correct route | 68/71 (95.8%) |
| Ordinary route and exact memory type | 38/42 (90.5%) |
| Temporal source with every exact field | 11/18 (61.1%) |
| Ideal structured timeline queries | 45/45 (100%) |
| Extracted timeline queries, including empty results | 35/45 (77.8%) |
| Queries requiring supported evidence | 12/21 (57.1%) |
| Empty-result and boundary queries | 23/24 (95.8%) |
| Sources with request/schema/ingestion errors | 1/71 (1.4%; a rejected replacement link) |
| Ignored or deferred sources incorrectly stored | 0/11 |

The empty-result score is separate because an extractor that stored nothing
would receive 24/45 aggregate downstream credit. It would recover zero of the
21 questions requiring evidence.

All 42 ordinary sources stayed in the ordinary lane. Their exact types were:

| Expected type | Exact type |
| --- | --- |
| Rule | 8/9 |
| Command | 6/9 |
| Gotcha | 8/8 |
| Decision | 8/8 |
| Review pattern | 8/8 |

Some rule-versus-command annotations are debatable. They are a diagnostic of
the proposed router under the declared labels, not a measurement of the current
production capture classifier.

The temporal errors included:

- Both independent pool-size reports were deferred, losing the conflicting
  evidence that the store should preserve.
- A successor changed the subject from `search` to `search ranking`. The store
  correctly rejected its predecessor link, leaving the change unrecorded.
- Another source changed `payroll` to `payroll schedule`, so the intended entity
  lookup could not find it.
- A corroborating report was deferred.
- Two exact-field misses were value casing (`USD` versus `usd`, and `HTTPS`
  versus `https`). Those are representation differences rather than different
  underlying claims. They remain failures under the frozen exact metric.

Dates, exclusive expiry, the relative-date anchor and the timezone boundary
worked in the successful records. This remains a small, authored, fixed-schema
probe; it is not open-ended conversational capture.

## Public conversations across six categories

The public sample used five questions from each of the six LongMemEval types
and six unanswerable questions. Answerable cases reused the existing
multilingual-e5 retrieval cache; the unanswerable supplement used SQLite FTS5
BM25. This was not a fresh run of Recall's current configured retrieval stack
or an official LongMemEval evaluation.

Both approaches received identical bounded source snippets, at most 10,000
characters in total, with 2,000 additional characters reserved for optional
temporal assertions. Extraction saw only those same snippets, without the
question or gold answer. A separate model judged freeform answers; unanswerable
cases required a complete abstention.

| Category | Existing source evidence | Temporal sidecar with fallback |
| --- | --- | --- |
| User facts | 1/5 | 1/5 |
| Assistant facts | 2/5 | 2/5 |
| Preferences | 0/5 | 0/5 |
| Multiple sessions | 3/5 | 3/5 |
| Updated knowledge | 2/5 | 2/5 |
| Temporal reasoning | 3/5 | 3/5 |
| Unanswerable supplement | 6/6 | 6/6 |
| Total | 17/36 (47.2%) | 17/36 (47.2%) |

**The sidecar supplied temporal evidence for zero of the 36 questions.** The
parser selected fallback on 35 cases and produced malformed output on one.
Every candidate evidence block therefore equaled its baseline block.
Consequently, this comparison demonstrates no temporal gain; equal scores
cannot establish that temporal reasoning works across these categories.

The absolute scores also reflect the small sample, cached retrieval, tight
snippet truncation, and answering model. They should not be presented as
Recall's general accuracy. In answerable cases, both arms produced syntactically
valid citations on 30/30 questions but cited a gold answer session on only 12/30.
Citation validity alone is not grounded correctness.

The public pipeline made 528 model calls: 360 session extractions, 36 query
parses, 72 answers and 60 judges. There were no transport errors. One extraction,
one query parse and one judge output were malformed. All remained in their
respective denominators. Of the 360 source extractions, 283 deferred.
The model emitted 99 parseable facts; 35 had zero-length effective intervals and
were correctly rejected by the store. These failures reinforce that a working
timeline selector does not provide reliable conversational intake.

This run took 342 seconds and recorded 352,339 tokens. Dollar cost was unknown.
It used one model, one inference run per case and a model judge that can err.
Five questions per category cannot establish general production reliability.

## Integration decision

The 95% ordinary route/type hurdle and the 90% exact temporal extraction and
downstream-lookup hurdles were not met. A low request-error rate and correct
ignore/defer boundaries do not compensate for losing supported facts.

The earlier expanded experiment also did not establish the required positive
grounded gain with an interval above zero. Its compiler arm used default
instruction-compiler limits, rather than the exact compact SessionStart hook.
That distinction does not change the old scores, but limits their interpretation.

Automatic intake and normal-query routing therefore remain disconnected.
Existing coding-rule memory retains its capture, promotion and delivery behavior.
Recall Cloud synchronization, retention, individual removal, portability and
the treatment of sensitive evidence still require explicit integration work.

The next candidate should stabilize entity identity, preserve reported conflicts
and corroboration, and define value normalization before another held-out
evaluation. The current fixtures and results should remain unchanged.

## Scale and evidence limits

A separate synthetic probe checked 1,000, 10,000 and 100,000 hourly versions of
one property, using real append and query APIs. Ten snapshot and ten history
queries at each size returned their expected values and truncation status.

| Assertions for one property | Median snapshot | Median history |
| --- | --- | --- |
| 1,000 | 2.5 ms | 2.2 ms |
| 10,000 | 25.7 ms | 22.3 ms |
| 100,000 | 389.3 ms | 353.8 ms |

These are local workload observations, not latency guarantees. Querying still
loads all visible versions before limiting the output. The process reported
about 796 MB RSS after the largest workload; this is process-wide memory,
not a per-request allocation estimate or evidence of a memory leak.

The independent audit also identified a pre-existing UMP lexical-fallback path
that ignores its requested repository and noted that temporal capture does not
inherit ordinary correction redaction. These are separate findings from the
measured extraction errors. The device/Cloud implementation was not certified
by this local evaluation.

## Artifacts

Raw local artifacts are stored under the ignored `benchmark/data/` directory:

- `temporal-integration-frozen-2026-10-18.json` and
  `temporal-integration-source-2026-10-18.tar.gz` identify the frozen experiment.
- `temporal-categories-real-2026-10-18.json` preserves source outputs, per-family
  scores, stage failures and token measurements.
- `temporal-preservation-real-2026-10-18.json` contains matrix and recovery checks.
- `temporal-scale-real-2026-10-18.json` contains scale samples; the adjacent
  `temporal-scale-source-2026-10-18.mjs` reproduces its method.

The category run recorded 93,734 model tokens. Dollar cost was unknown.
APEX-MEM was not run. None of these results establishes competitor superiority.

`temporal-public-real-2026-10-18.json` preserves the public sample's evidence,
extraction outputs, fallback decisions, answers, judge outputs, citations and
usage. The frozen file hashes were checked after both runs and still matched.

Validation passed: **1,113 tests**, with three existing opt-in skips; source
TypeScript; strict TypeScript for the new harnesses and tests; docs check; and
the production build. Independent review identified and rechecked the evaluator
and coexistence-control fixes. The original timeline resolver and earlier
evaluation results remained unchanged. No automatic intake, Cloud integration,
commit, push, app installation or deployment followed from these experiments.

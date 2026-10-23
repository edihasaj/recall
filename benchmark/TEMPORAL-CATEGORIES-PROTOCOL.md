# Temporal integration rehearsal

Recorded on 18 October 2026, before the new model runs.

This evaluation extends the earlier synthetic timeline experiment with broader
source language, ordinary instruction controls, and sampled public conversation.
It evaluates proposed integration components in disposable databases. It does
not enable a router, modify live memory, or change Cloud synchronization.

## Coverage

| Layer | Coverage | Measurement |
| --- | --- | --- |
| Ordinary memory | All five `MemoryType` values: rule, command, gotcha, decision, review_pattern | Correct route and type; no temporal operational assertion |
| Temporal intake | Explicit changes, corrections, expiry, gaps, conflicts, relative dates, timezone boundaries, leap day, corroboration, observation cutoffs | Exact source fields and downstream values, conflict, and source IDs |
| Capture boundaries | Pretend/denied/example/one-task text, ambiguous dates, unconfirmed plans, cancellation, multiple facts/values, uncertain aliases | Ignore or defer, without inventing a temporal fact |
| Public conversation | Five cached-retrieval questions from each of six LongMemEval categories, plus six unanswerable cases | Paired answer quality, citations, failures, and actual sidecar usage |
| Runtime boundaries | Existing scope, provenance, promotion, retrieval, backup, deletion, and synchronization code/tests | Independent audit and regression gates, separately from model accuracy |

These are authored scenarios and a small public sample, not exhaustive coverage
of every conversation. The source router handles one assertion at a time.
Public questions include user facts, assistant facts, preferences, multiple
sessions, updated knowledge, and temporal reasoning.

## Frozen comparisons and leakage controls

The existing resolver, earlier answer instructions, gold, results, and thresholds
remain unchanged. New harnesses and prompts are versioned separately and frozen
before their first live evaluation. Model errors and invalid output count as
failures; failed cases are not selectively retried. New changes after results
require a new experiment and fresh validation.

The category extractor receives only source identifiers, repository, source
timestamp, current raw source, and earlier raw sources. Family labels, expected
routes, fields, questions, answers, and later sources remain evaluator-only.
Downstream queries use explicit gold query fields; this experiment does not
measure natural-language query parsing or freeform answering.
Opaque source and repository identities prevent descriptive fixture labels from
revealing routes or types. The router uses an explicitly declared, fixed
predicate ontology; this is not an open-schema extraction test. Report queries
with supported evidence separately from empty-result boundary checks.

The public experiment reuses ranked session IDs from the existing
`recall-lme-e5-n60.json` artifact. Selection uses a fixed seed, never answer
session IDs or answers. These rankings and public data may have prior development
exposure. The unanswerable supplement uses SQLite FTS5 BM25 and is reported
separately; it must not be called the same hybrid-retrieval experiment.

The baseline and candidate receive the same retrieved source sessions, model,
output limit, and 12,000-character evidence cap. Session extraction is
question-blind. The sidecar uses the real temporal store for supported parsed
questions, and falls back to baseline evidence for unsupported or unreliable
results. Raw evidence remains available. Measure the number of actual temporal
augmentations: identical fallback answers cannot prove temporal improvement.
Dataset timestamps lack timezone information; treating them as UTC is an explicit
experimental assumption.
Preflight reserves 2,000 characters for optional assertions in both arms, leaving
an identical raw-source block of at most 10,000 characters. Extraction receives
only those same snippets. Augmentation preserves the complete shared raw block;
an oversized augmentation falls back. Same-day observation timestamps retain
their precision. Unanswerable cases require a complete abstention, not a guess
containing the word "unknown."

Public freeform answers are judged by a separate, arm-blind model call against
the reference. This judge can err and shares the answering model; report its
limitations. Citation validity and answer-session coverage are separate metrics,
not proof of complete grounding. Keep raw answers and verdicts for inspection.

All model stages use `qwen3.8-flash-next`, reasoning disabled, with 512 output
tokens. Category runs allow at most three concurrent requests; the public run
allows six across its stages. Run the two experiments sequentially. Record
actual token usage and unknown cost, prompt/source/data hashes, incomplete
attempts, and progress reports. Hashes in each raw report identify the precise
implementation.

## Decision rules

The earlier integration hurdles remain prerequisites: at least five percentage
points of grounded improvement over the strongest control with a template-cluster
95% interval above zero; no static regression beyond five points; failures at
most 5%; exact extraction and downstream lookup each at least 90%. The earlier
experiment did not meet all these hurdles. New extraction or routing results
cannot retroactively turn that outcome into a pass.

For this rehearsal, ordinary route/type accuracy must reach at least 95%
overall, temporal exact extraction and downstream lookup each at least 90%, and
model/request/schema failures at most 5%. Any observed storage of a source that
should be ignored or deferred is an automatic-intake blocker. Correct deferral
does not count as successful temporal extraction or an answer.

Public results must show no overall regression beyond five percentage points,
report every category, and account for abstention and failures. With five
questions per category, these are diagnostics, not statistical proof of a
production gain. The earlier positive-gain requirement still needs independent
evidence before automatic integration.

Integration also requires explicit handling of plans versus confirmed events,
privacy/redaction, provenance and scope, retention/export/deletion, and Cloud
schema/authorization. Passing a local answer test does not certify these.
Ordinary rule capture, promotion, and instruction delivery retain their own
semantics. Automatic integration proceeds only when these checks support it;
otherwise the optional structured prototype remains experimental and the report
identifies the observed blockers.

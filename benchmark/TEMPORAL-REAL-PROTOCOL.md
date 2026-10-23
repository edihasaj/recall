# Larger public-conversation temporal evaluation

Recorded on 18 October 2026 before this experiment's model calls.

This is an offline test of the frozen temporal v2 language adapter. Earlier
experiments, fixtures and scores remain unchanged. It does not install the
candidate, connect it to normal capture, or change Recall Cloud.

## Cases and exposure

Use every question in the locally cached LongMemEval-S cleaned dataset after
excluding the union of question IDs in `recall-lme-e5-n60.json` and
`temporal-public-real-2026-10-18.json`. The expected selection is 434 questions:
410 answerable and 24 unanswerable. Selection uses IDs, never reference answers,
answer-session annotations or observed candidate performance.

| Category | Answerable cases |
| --- | ---: |
| User facts | 54 |
| Assistant facts | 46 |
| Preferences | 20 |
| Multiple sessions | 111 |
| Temporal reasoning | 117 |
| Knowledge updates | 62 |

These are additional questions from a previously exposed public corpus.
Question-ID exclusion does not establish that conversations are disjoint, that
the corpus was absent from model training, or that earlier retrieval experiments
never used it. This is not a newly collected human-conversation study or an
official LongMemEval score.

## Retrieval and evidence

Use fresh Recall `hybridSearch` with its lexical path, embeddings disabled,
conversation-appropriate FTS OR matching, and reranking and HyDE disabled.
Index original session text with role labels in an isolated database per case.
Exclude sessions observed after the question timestamp before retrieval.
Retrieve ten sessions without consulting gold metadata.

Preflight found ten cases with a repeated session ID whose identical text has
different observation dates. Exclude all occurrences of each repeated ID,
record their IDs and dates, and retain the questions. Do not choose a favorable
date or use answer-session membership to decide which occurrence to keep.

This measures the existing lexical retrieval path plus an experimental
augmentation. It does not measure the complete deployed vector, reranker,
capture, promotion, lifecycle or Cloud pipeline.

Three arms use the same answering model and a maximum evidence length of
24,000 characters:

| Arm | Evidence |
| --- | --- |
| Shared raw control | Retrieved session snippets within 20,000 characters. |
| Temporal v2 | The entire shared raw block plus at most 4,000 characters of resolved assertions. |
| Full raw control | The same retrieved sessions within the entire 24,000-character budget. |

The full raw control prevents an unused assertion reserve from making the raw
baseline artificially weak. Character budgets are not exact token budgets;
record actual model token usage separately.

Capture sees only the same shared snippets, sorted by source observation time
and stable source ID. It receives no question, gold field, expected key or
reference answer. Snippet retrieval itself depends on the question, so this is
retrieval-time augmentation rather than question-independent full-history
ingestion. The temporal adapter's existing catalog comes only from assertions
it actually stored. Use no benchmark-specific predicate ontology.

The existing adapter and store remain frozen. Empty, invalid, truncated,
oversized or unsupported lookup results fall back to the shared raw block.
Conflicting results may appear only as explicitly conflicting source assertions.
The candidate must preserve the entire shared raw block. Identical evidence
reuses the exact same answer result, with reuse recorded and usage counted once.
Fallback answers therefore cannot create a spurious temporal benefit.

## Inference and scoring

Use `qwen3.8-flash-next`, reasoning disabled, temperature zero and 512 output
tokens for every model stage. Permit at most six simultaneous model requests.
Do not selectively retry failed cases. Checkpoint completed cases and retain
raw outputs, validation failures, timing, usage and hashes. Any resumed run
must preserve completed cases and validate its frozen inputs.

Answers contain a freeform answer and supplied source-session citations.
Score meaning, including required entities, dates, numbers and answer parts.
Casing and presentation alone must not change semantic correctness.

For answerable questions, a separate arm-blind judge receives the question,
question category, reference clock, reference answer and unique candidate
answers under shuffled opaque IDs.
It does not see arm names, evidence, temporal usage or preferred results.
Preference references describe desired personalization; a response may use
different valid recommendations if it addresses the request and incorporates
those preferences. Other categories require the relevant facts, dates, numbers
and answer parts, without requiring literal reference wording.
Unanswerable questions require a complete abstention. The judge shares the
answering model and can err; audit disagreements and sampled agreements
separately without silently replacing the frozen primary scores.

Citation validity and whether an answer cites a gold answer session are
separate diagnostics. They do not prove that every generated claim is entailed.
Do not label semantic correctness alone as grounded correctness.

All selected questions remain denominators, including transport, model,
schema, validation and case failures. Partial reports distinguish completed
cases from the full planned denominator.

Report all categories, abstention, actual nonempty temporal augmentations,
fallback reasons, capture rejections, request/schema failures, latency and
token usage. Dollar cost remains unknown when no reliable price is supplied.
Do not call deferral a successful extraction. This dataset does not provide
gold temporal assertions, so exact capture accuracy is not established.

## Decision

Report paired wins, losses and ties against both controls. Compute a fixed-seed,
10,000-resample cluster bootstrap for the difference in semantic accuracy.
Connect cases sharing gold answer-session IDs and corresponding abstention IDs
into clusters. Gold is used only for scoring and clustering, never inference.
This clustering cannot remove every correlation in a reused public corpus.

The diagnostic gain hurdle is at least five percentage points over the full raw
control, with the lower 95% interval above zero. Ordinary user, assistant and
preference categories must not regress by more than five points; request/schema
failures must remain at most 5%. Show the underlying counts even if a hurdle
fails.

Passing this test would justify another staged check. It would not establish
superiority to APEX-MEM, which has not been run, or readiness for broad integration.
Representative production retrieval, independently checked capture quality,
privacy, retention, removal, portability and Cloud round trips remain separate
requirements.

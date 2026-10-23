# Temporal v4: repeated public-conversation evaluation

Recorded on 19 October 2026 before this experiment's model calls.

This is an offline test of a new temporal v4 language adapter. Earlier
experiments, fixtures and scores remain unchanged. It does not install the
candidate, connect it to normal capture, or change Recall Cloud.

## Cases and exposure

Use exactly the 434 planned question IDs in the frozen completed report
`benchmark/data/temporal-real-holdout-real-2026-10-18.json`. Preserve that
manifest's order and require every ID to exist in the current cached dataset.
Require 410 answerable questions, all six categories, and 24 abstentions.
Only the original planned IDs are read for selection; no old extraction,
answer or grade is used for inference or primary scoring.

The explicit `--rerun-exposed-ids` flag labels this a development-exposed rerun.
These same questions have already been evaluated and informed development.
Fresh model calls do not make the questions an independent holdout. The prior
v2/v3 scores may be historical context, but this three-arm rerun does not
isolate a causal v4 gain against a fresh matched v3 capture arm.

| Category | Answerable cases |
| --- | ---: |
| User facts | 54 |
| Assistant facts | 46 |
| Preferences | 20 |
| Multiple sessions | 111 |
| Temporal reasoning | 117 |
| Knowledge updates | 62 |

These are repeated questions from a previously exposed public corpus.
The original question-ID exclusion did not establish that conversations were
disjoint, that the corpus was absent from model training, or that earlier
retrieval experiments never used it. This is not a newly collected
human-conversation study or an official LongMemEval score.

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
| Temporal v4 | The entire shared raw block plus at most 4,000 characters of resolved assertions. |
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

The frozen original harness, helpers, v2/v3 adapters and historical outputs
remain unchanged. The new harness imports the separate v4 capture/query
candidate. Capture receives no declared predicate policies or benchmark
property vocabulary.

Trusted speaker spans come only from the dataset's structured turn roles and
content boundaries. The raw source representation remains exactly
`role: content` joined by newlines. A span covers actual content, excluding its
printed role label. Clip spans to the exact shared-evidence source prefix,
including partial final turns; never extend a span into unselected text.
Canonical subjects are `user` and `assistant`, from structured roles. Text that
looks like a role label inside content never establishes speaker identity.
Do not silently drop excessive spans: the adapter's bounded source contract
may defer and the report retains that result.

The capture callback appends the same trusted-speaker metadata instruction as
the matched UMP pilot, plus JSON spans, to the frozen base capture prompt.
All resulting request hashes are recorded. Capture must distinguish established
states from plans, suggestions, hypothetical states and unsupported events.
No extra ontology or fixture-specific rules are passed by this public harness.

Metadata receipts (versions 3 or 4) remain in the store. Unwrap their original
source text for the frozen assertion-evidence formatting and source-session
mapping so JSON metadata does not displace the source excerpt.

Empty, invalid, truncated,
oversized or unsupported lookup results fall back to the shared raw block.
Conflicting results may appear only as explicitly conflicting source assertions.
The candidate must preserve the entire shared raw block. Identical evidence within the same question
reuses a freshly generated answer result, with reuse recorded and usage counted
once. No answers, capture results, queries or judge grades are imported from
any previous experiment.
Fallback answers therefore cannot create a spurious temporal benefit.

## Inference and scoring

Use `qwen3.8-flash-next`, reasoning disabled, temperature zero and 512 output
tokens for every model stage. Permit at most six simultaneous model requests.
Every executed capture, query, answer and judge request is fresh. Empty stores
may bypass query generation, identical within-case evidence may share its new
answer request, and abstentions use the frozen exact abstention rule rather than
a judge. Do not label these deliberate bypasses as fresh requests.
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
Validate each arm's citations against its own evidence source IDs: the full raw
control uses `full.snippets`, while the shared raw and temporal arms use
`shared.snippets`. This makes each arm's citation scope explicit. The frozen
prefix-allocation helper preserves every retrieved source label in both
budgets, so the ID sets coincide in the present experiment. This is defensive
bookkeeping and does not change the historical scoring interpretation.

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

## Execution and checkpoint contract

Prepare the full case selection without making provider calls:

```sh
npx tsx benchmark/temporal-real-v4.ts --prepare --rerun-exposed-ids \
  --out /tmp/temporal-v4-real-prepared.json
```

After the SDK dependency and candidate source are frozen and reviewed, use a
new output path for the actual provider run:

```sh
dgx run -- npx tsx benchmark/temporal-real-v4.ts --provider qwen-local \
  --rerun-exposed-ids --out benchmark/data/temporal-v4-real-2026-10-19.json
```

Provider runs select the full 434-case manifest; `--limit` is restricted to
preparation or explicitly synthetic programmatic diagnostics. At most six
worlds and six model calls run concurrently. Each question has its own temporal
and lexical database. Existing output is refused unless `--resume` is explicit.
Resume requires matching dataset, original-ID report, exposure reports, harness,
protocol, support, prompt and source/dependency hashes, invocation and question
IDs. It retains only completed cases from this same new run. Failed completed
cases stay in the planned denominator and are not retried.

The new report preserves raw outputs, citations, metadata, validation failures,
actual call identities, hashes, model usage, stage timing, all category counts,
abstentions and paired cluster-bootstrap diagnostics. Unknown usage and dollar
cost stay explicitly unknown. Full production retrieval, ordinary UMP server
routing and Recall Cloud are not measured by this harness.

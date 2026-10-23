# V3 bug-fix diagnostic: 18 October 2026

The corrected validator passes its targeted regression checks, but its
434-case replay shows **no answer-quality improvement**:
165/434 (38.0%) before and after, versus 182/434 (41.9%) for the full-budget
raw-history control.

These are replay-based diagnostic scores. Original model extraction outputs
and raw-control answers were reused. This is not a fresh end-to-end extraction
run, independent holdout, production Recall/Cloud score or competitor result.

## Implemented candidate

`src/temporal/intake-v3.ts` is a separate experimental module. The original
v2 adapter, store, prompts and completed results remain unchanged.

The candidate corrects exact underscore-label grounding and scopes a limited
set of independent continuations without discarding governing conditions or
later contradictions. It also refuses newly tested hedged or negated claims
and associates relative and natural dates with their own clauses.

An optional `speaker_spans` input supplies trusted structured-message identity.
It permits narrowly supported direct first-person assertions with matching
relation and owned value. It refuses ambiguous repeated quotes, third-person
possessives, reported speech, mismatched roles and invalid/overlapping spans.
It does not infer trusted roles from source text.

Metadata-backed evidence is stored as a bounded version-3 receipt containing
the original text and normalized spans. Replay compares that structured
identity, and raw text that collides with the receipt format is refused.
Receipts exceeding the store's 16,000-character evidence cap defer before
inference.

This remains a narrow English contract. It does not provide general
coreference, semantic predicate mapping or event arithmetic. Some source-supported
facts in complex sentences still defer conservatively.

## Capture replay

The [protocol](TEMPORAL-V3-PROTOCOL.md) was recorded before live diagnostic
query calls. Each original source snippet and model response was replayed in
its original order into separate v2 and v3 in-memory stores. Observation
times, opaque source/repository IDs and predicate policies stayed unchanged.
V3 alone received speaker spans derived from the dataset's structured role and
content fields, with exact snippet-prefix validation.

The v2 replay reproduced the original 44 assertions, confirming the baseline
reconstruction. No live capture calls or repairs to model proposals occurred.

| Measurement | V2 | V3 |
| --- | ---: | ---: |
| Questions replayed | 434 | 434 |
| Stored assertions | 44 | 43 |
| Sources storing assertions | 42 | 41 |
| Question-local stores containing facts | 42 | 41 |

Two assertions were added and three removed.

The additions concern starting and finishing reading books. The source text
supports those reports, but they describe events outside the promised
state-only contract. They are not evidence of improved state-extraction
accuracy.

The removed boot-polishing statement is explicitly hedged. The removed router
upgrade and bedding-replacement statements are supported actions inside
sentences containing other uncertainty or negation. Their rejection illustrates
remaining conservative coverage loss rather than demonstrated improvement.

| Rejection reason | V2 | V3 |
| --- | ---: | ---: |
| Ungrounded new key | 1,169 | 1,103 |
| Ungrounded predicate | 144 | 139 |
| Missing temporal anchor | 42 | 49 |
| Unsupported clause | 95 | 142 |
| Value absent from quote | 46 | 44 |
| Invalid observation-based start | 11 | 12 |
| Quote absent from source | 15 | 15 |
| Unproven first-person value ownership | 0 | 19 |

Reducing one rejection label can expose another invalid field. These counts
do not establish recall, precision or a gold capture-accuracy percentage.
Literal predicate requirements and the narrow first-person grammar remain
substantial limits.

## Answer-quality diagnostic

The diagnostic preserved each frozen 20,000-character shared raw block and
the same 4,000-character augmentation reserve. It reused the exact original
answer and grade whenever evidence was unchanged. Stores without facts
deterministically fell back.

| Query path | Cases |
| --- | ---: |
| Empty store; no query call | 393 |
| Identical query prompt; frozen response reused | 38 |
| New live query call | 3 |

All three new query calls returned fallback. There were no fresh answer or
judge calls. Exactly one case retained its original temporal augmentation:
the volleyball record `5-2`, which all original arms answered correctly.
Every final candidate answer and correctness result was therefore reused.

| Category | Cases | V2 | V3 replay | Full raw |
| --- | ---: | ---: | ---: | ---: |
| User facts | 54 | 7 | 7 | 9 |
| Assistant facts | 46 | 28 | 28 | 34 |
| Preferences | 20 | 4 | 4 | 5 |
| Multiple sessions | 111 | 37 | 37 | 39 |
| Knowledge updates | 62 | 28 | 28 | 32 |
| Temporal reasoning | 117 | 38 | 38 | 40 |
| Unanswerable | 24 | 23 | 23 | 23 |
| **All cases** | **434** | **165 (38.0%)** | **165 (38.0%)** | **182 (41.9%)** |

Against shared raw evidence, v3 has zero wins, zero losses and 434 ties.
Against full raw, it has six wins, 23 losses and 405 ties: −3.92 percentage
points, with the same 409-cluster bootstrap interval of [−6.44, −1.60].
This interval describes the reused evidence/control comparison; it is not new
independent evidence about generalization after the fixes.

The live diagnostic used three calls and 984 tokens with no request failures.
Dollar cost remains unknown. Original provider failures, snippet truncation,
public-corpus exposure and model-judge limits still apply.

## Validation and decision

Eight supplied regression tests passed. Independent review closed the four
material follow-up findings using five additional test harnesses, including
40 asserted acceptance/refusal expectations and ten ownership/date-edge
checks. Strict TypeScript passed. The isolated full suite passed
**1,152 tests**, with three existing skips.

The fixes improve the tested validator behavior. They have not shown a
broader answer-quality benefit. Keep the candidate experimental. General
conversational relation extraction, event representation and representative
evidence retrieval require further design and fresh end-to-end measurement.

Artifacts under ignored `benchmark/data/`:

- `temporal-v3-frozen-2026-10-18.json`.
- `temporal-v3-validation-replay-2026-10-18.json`.
- `temporal-v3-answer-quality-2026-10-18.json`.
- `temporal-v3-replay-source-2026-10-18.mjs`.
- `temporal-v3-answer-eval-source-2026-10-18.mjs`.
- The independent source and result reviews.

No normal-query, lifecycle, app or Cloud integration was enabled.

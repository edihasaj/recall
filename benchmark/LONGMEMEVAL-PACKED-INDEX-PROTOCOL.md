# LongMemEval packed index and standalone answer

The completed units-only development run scored 57/60 with six original cases
correct. One index exceeded 18,000 rendered characters; two counting answers
gave conditional totals. The candidate failed both gates. Its frozen source,
complete report and independent audit remain unchanged.

## Combined candidate

This separately frozen experiment changes two mechanisms. It does not claim
to isolate either mechanism's effect.

1. `--evidence-ledger packed` asks for ranked neutral unit references, then
   deterministically packs whole quoted units under the rendered budget.
2. A benchmark-only answer-system instruction makes the delivered `answer`
   field self-contained, with the requested result and essential support.

The existing `units` and `quoted` modes keep their behavior, including rejecting
oversized output. Do not transform or rejudge old outputs. The application
History contract, reference answers, original task requirements, retrieval,
source evidence, inference routing and judge remain unchanged.

## Deterministic budget allocation

The extractor returns the same strict reference-only schema as units mode,
with at most 24 selections ranked by usefulness to the original question.
It emits no factual annotation, answer, count or calculated date.

Validate every reference, schema property and visibility constraint before
packing anything. An invalid reference anywhere fails the entire case; it
cannot be discarded as a budget omission. Deduplicate valid references stably.
In the returned priority order, include a complete unit only if the complete
escaped and framed index still fits 18,000 characters; otherwise record that
valid reference as omitted for budget and continue to later units.

Record the original ranking, duplicates, included references and every valid
budget omission, including the case where no unit fits. Never truncate a
quotation. Budget metadata and framing must themselves fit the cap, including
boundary cases. During admission, reserve the two-character maximum omission
count (`24`), even when the final count has one digit. This conservative
one-character margin may omit a unit that would exactly fit after the final
count is known; record it as a budget omission. Original raw evidence remains fully available to the answer,
so a derived-index omission does not remove source evidence.

This declared packing contract is routine resource allocation. It does not
accept unsupported annotations or silently repair malformed extraction.
Selection, source provenance and budget compliance do not prove relevance,
completeness or semantic correctness.

## Delivered answer contract

The `answer` string is the sole user-delivered and judged response. Require it
to contain the requested result and essential supporting facts rather than
placing indispensable facts only in the separate `reasoning` string. Counting
answers should identify counted instances and their supported states.

Preserve the original genuine-ambiguity contract. Prefer a primary
interpretation only when evidence supports that preference. State assumptions
and retain equally supported alternatives. Never force a definitive count,
discard a contrary update or manufacture certainty to match an expected
reference. This guidance contains no benchmark facts, entities, values, IDs,
category routing or judge feedback.

The guidance applies only to packed-mode answer system content. It must not
reach extraction or judging. Disabled, units and quoted native payloads remain
unchanged. Retain both changes as one combined experiment; any later causal
ablation requires a separately frozen plan.

## Fixed evaluation

Keep Qwen, robust requests, system History policy, low/8,192 extraction,
question-only adaptive/16,384 answering, none/4,096 judging and concurrency
three. The grounded post-answer checker remains disabled. Preserve the
180,000-character source budget plus at most 18,000 derived characters.
Record all calls, usage gaps, actual context sizes, omissions and effective
settings. Invalid extraction remains incorrect without retries or repair.

Freeze source, prompts, schema, dependency inventories, inputs and this
protocol before calls. Use the same separate current-app integration and
controlled-parent QA verification as the
[unit-index protocol](LONGMEMEVAL-UNIT-INDEX-PROTOCOL.md).

Run fresh, protected stages serially:

1. Complete the original development60 cohort on its verified rankings.
   Require at least 58/60 and all seven original cases correct.
2. Only after development passes, run the existing locked lexical
   follow-up100. Require at least 93/100 and 14/16 unanswerable.
3. Only after follow-up passes, run all 500 questions on the exact fresh E5
   rankings used by the high control. Require at least 457/500, 27/30
   unanswerable, 25/30 preferences and all seven original cases correct.

Any failed gate stops later stages. Do not relax thresholds, change cohorts,
tune from locked follow-up outcomes, selectively rerun failures or
counterfactually credit old outputs. Repeated public-corpus development is
adaptive; even a future pass needs separate validation for broad claims.

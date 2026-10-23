# LongMemEval minimal sufficient answer policy

## Hypothesis and scope

The completed paired inference trial scored 59/60 for both arms, with all
original seven cases correct. Extra drafts did not improve accuracy and
increased sampled unsupported/contradicted propositions from 29 to 36.
Its treatment remains rejected.

This separate prospective trial tests whether a one-pass answer policy can
reduce unnecessary unsupported claims and token use while preserving observed
accuracy and task completeness. It does not assume that fewer words imply
better grounding. The policy is informed by prior public development results;
fresh outputs do not make these questions an unseen holdout.

`MINIMAL_ANSWER_POLICY` in `longmemeval-minimal-answer-policy.ts` is the sole
generation change. It requests the exact result, all requested content,
necessary evidence and uncertainty, while avoiding unrelated recaps and
unsupported additions. It imposes no length cap, desired count, category
lookup, case-specific example or routing rule.

## Fresh paired execution

Both arms use the exact Recall side of the existing sixty-question input,
SHA-256 `02cf0ab2fd22d6144d3c85a08bf049a2ac950242a93414eb04bdf63cb0d69fc7`.
The original AMB question, clock, task requirements and complete user prompt
remain byte-identical. The existing History policy remains unchanged.

| Stage | Control | Comparison |
| --- | --- | --- |
| Answer calls per question | One | One |
| Answer instructions | History policy | History policy plus minimal policy |
| Answer model | Qwen 3.8 Flash Next | Same |
| Reasoning/output limit | Adaptive / 16,384 | Same |
| Temperature/schema | Zero / original strict JSON | Same |
| Judge | Existing none / 4,096 rubric | Same, independent call |

The original sixty identities and case order remain fixed. Alternate submitted
arm order by case index. There are 120 arm tasks and at most 240 logical model
invocations, globally at most three active. Existing bounded transient HTTP
retries may make physical HTTP attempts exceed logical calls; record both.
No selective retries, answer repair, rejudging, survivor fallback or stopping
for observed accuracy is permitted. Failures count as incorrect out of sixty.

Reserve all result, row journal, call journal and progress paths before
credential setup. Journal every call before its successor; guard every
underlying invocation against a shared abort latch. Use authenticated DGX,
Node22 and private pinned dependencies. Freeze code, instructions, inputs,
selection, dependencies and launch reviews before calls. Preparation defaults
to offline; injected results are explicitly invalid as benchmark evidence.

## Prospective blinded review

Reuse the existing seventeen-question selection by identity: two per original
category, union the original seven. The identities are already development
exposed. Use a new committed mask seed, 20261024, and the existing SHA-256
case/arm ordering algorithm. Commit the private identity-map core before any
outputs, and bind the completed report and full review packet before reviewer
dispatch. Lock all ratings before semantic unmasking or arm aggregation.

Fresh reviewers see only the masked question, trusted clock, unchanged source
context and final answers. No drafts, references, model reasoning, judge
verdicts, historical outputs or arm maps are supplied.

For this trial, make question metadata anchorable without changing the model's
evidence. Render a deterministic review-only evidence string with separately
labeled sections for:

1. The question, which establishes requested scope but does not prove its
   historical presuppositions.
2. The trusted question clock, which establishes the reference time.
3. The original delivered context, whose roles, dates, negation and scope
   remain untrusted historical evidence.

Recompute the original context's UTF-8 SHA-256 and preserve it separately from
the rendered review-evidence hash. Freeze section boundaries and use exact
half-open UTF-16 offsets for anchors. Temporal inferences need the relevant
source and clock premises. This schema applies equally to both fresh arms;
no old ratings are changed or directly compared with these new labels.

Assess every minimal independently checkable proposition as supported,
supported-inference, unsupported, contradicted or unresolved. Deduplicate
repeated propositions while retaining all answer spans. Count the union of
unsupported and contradicted claims and the number of affected answers across
all seventeen cases. Requested versus ancillary claims may be descriptive
annotations; both remain in the gate's denominator.

Assess task completeness separately from answer generation. Each blinded
review records whether the response addresses every explicit requested
component, retains independently supported items necessary for enumeration,
and preserves necessary qualifications and genuine uncertainty. Recommendations
need not exhaust every possible suggestion. A missing answer, omitted requested
component or unresolved completeness assessment cannot pass. Unsupported
presuppositions do not require invented content: explicitly acknowledging
missing evidence can be complete.

## Advancement requirements

All original numerical gates remain:

1. Development at least 58/60, with all original seven correct.
2. Locked lexical follow-up100 at least 93/100 and 14/16 unanswerable.
3. Exact fresh-E5 full500 at least 457/500, 27/30 unanswerable,
   25/30 preferences and all original seven correct.

This new same-call policy must additionally satisfy, on the fresh paired run:

- Comparison correct count is at least the fresh control's count.
- Strictly fewer total unsupported/contradicted propositions **and** strictly
  fewer affected answers in the seventeen paired source reviews.
- No loss of generated-answer coverage. Every sampled comparison answer is
  complete, with necessary qualifications preserved and no unresolved
  completeness. Both arms must have zero unresolved grounding claims and
  complete, undisputed segmentation; control uncertainty cannot be ignored.
- Lower observed total tokens across comparable completed answer/judge stages,
  with both arms completing all 120 expected logical calls without case errors,
  and all input/output/total usage known. Otherwise resource benefit is unproven.

Report answer/judge input, output, reasoning, cached and total tokens separately,
alongside retries, unknown usage, answer lengths and timings. Cached tokens are
not subtracted from total-token accounting. Do not claim latency or monetary
savings from token counts alone.

Maintained observed accuracy is not a statistical noninferiority result.
The source sample does not prove general grounding improvement. The earlier
more-expensive architecture's strict accuracy-gain gate is not retroactively
relaxed; this policy has a different prospective benefit requirement.
Only all required passes permit subsequent stages. Do not tune from locked
follow-up outcomes or change references, judges, thresholds or prior results.

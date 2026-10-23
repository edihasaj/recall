# LongMemEval paired inference comparison

## Hypothesis and decision

The completed saved-context replay scored 58/60 for Recall and 56/60 for
Hindsight, using the same Qwen answerer and judge. Substituting the saved
Hindsight context did not demonstrate a benefit. Unchanged Recall contexts
and answer settings also produced different misses across its completed
57/60 and 58/60 runs. That establishes observed variation, not its cause.

This single prospective trial tests whether **additional inference plus
comparison of separately generated drafts** improves final answers without
worsening sampled grounding. Resource cost is descriptive; production
cost-based adoption remains undecided. It cannot isolate draft diversity,
reasoning depth or arbitration individually. The drafts share a model and
source evidence; they are not statistically independent.

The model, evidence selection, original answer prompt, History policy,
reference, judge rubric and numerical acceptance gates remain unchanged.
Additional arbitration instructions are an explicit part of the treatment.

## Two fresh arms

Both arms use the exact same saved Recall evidence, pinned AMB question and
clock, source blinding and unchanged History system policy. All sixty original
questions run in both arms, including every original failure.

| Arm/stage | Qwen reasoning | Output budget | Visible prior drafts |
| --- | --- | ---: | --- |
| Fresh control | Adaptive | 16,384 | None |
| Comparison: draft A | Low | 8,192 | None |
| Comparison: draft B | Adaptive | 16,384 | None |
| Comparison: final arbitration | Adaptive | 16,384 | Both drafts, as untrusted data |
| Each final-answer judge | None | 4,096 | Final answer only |

Adaptive routing remains the existing question-only policy. Drafts A and B
receive byte-identical original answer prompts and History instructions,
with only the recorded native inference settings differing. Draft B and the
arbiter use the existing adaptive route because the earlier fixed-high full
run exhausted its output budget on six preference cases. Reintroducing high
reasoning for every preference question would repeat a known failure mode.
For non-enumeration questions, both drafts therefore use low reasoning with
different output limits. Inference diversity is limited and is not assumed.

Arbitration retains the original complete answer prompt and context. It adds
the two full draft responses as serialized, untrusted data with fixed
comparison instructions. It must verify claims against source evidence,
may reject both drafts, and must not treat agreement as proof. It must
preserve genuine uncertainty, distinguish inference from a recorded
preference, and avoid inventing exclusions or completion of actions.
It receives no reference, annotation, category, historical answer or verdict.
No desired count, specific preference or benchmark-case correction is added.

All stages use `qwen3.8-flash-next`, temperature zero, strict JSON and the
existing robust transport. Judges retain the original none/4,096 contract,
receiving neither drafts, arbitration instructions nor the opposite arm.

## Execution and failure accounting

Use the original sixty IDs and order from the frozen development manifest.
Take each complete Recall context byte for byte from the reviewed replay
input, SHA-256
`02cf0ab2fd22d6144d3c85a08bf049a2ac950242a93414eb04bdf63cb0d69fc7`.
The input builder and 206-member runtime parent remain frozen. Hindsight's
saved contexts are not used in either arm.

Alternate which arm is submitted first by case index. Also counterbalance
draft presentation order by case index. Fixed stage identities retain their
low/adaptive settings regardless of presentation order.

Run at most three case-arm workers, each making its model calls sequentially.
Global concurrency across all stages must never exceed three. Both draft
generations run for each comparison case, even if the first draft fails.
If either fails or is malformed, that arm counts as incorrect without
arbitration or judging; it must not fall back to the other draft.
An arbitration or judge failure also counts as incorrect. Every call and
failure remains recorded.

Both arms have a fixed denominator of sixty. Do not repair outputs, retry
an unfavorable answer, rejudge a verdict, select a preferred old response,
restart partial output or stop the trial because of observed accuracy.
Only the existing bounded transient HTTP retry policy applies.
There are at most 360 model calls: 120 in the control and 240 in comparison.

Before calls, freeze source, input, protocol, stage instructions, task order,
grounding-review selection and effective dependency bytes. Require tests,
strict types and independent review, including actual CLI execution through
macOS path aliases. Reserve report, JSONL and progress outputs before credential
setup. Keep all raw draft/final calls, model settings, prompts, hashes,
attempts, usage, unknown usage, context sizes and per-stage timings.
Do not rebuild shared native bindings.

## Grounding review selected before outcomes

Freeze a seeded sample of two questions per original category, then union it
with the original seven failures. Selection uses only IDs and category
metadata, never verdicts or answers. Review both final answers for every
selected question, including failures as failures rather than silently
dropping them.

Prepare a separately shuffled, masked review packet containing only the
question, clock, delivered source context and final answers under neutral arm
labels. Hide arm identities, stage reasoning, historical outputs, references,
annotations and judge verdicts. Keep the private arm map separate.

Mask case order by ascending SHA-256 of
`mask_seed|case-order|question_id`. Label A is control when the first byte of
SHA-256 of `mask_seed|arm-order|question_id` has its low bit clear; otherwise
A is comparison. Label B is the other arm. Neutral review IDs follow masked
case order. The mask seed is 20261022.

The identity/label map core is committed before any new trial outputs exist.
Its canonical JSON SHA-256 is
`dde13cc9f5b13b46231ed12f4a7f20f6cdfc078281a8740c60beb7860d7d5829`.
The pretrial commitment artifact's raw SHA-256 is
`bf88e0ad68bd308499942cb43ae201fb16daa693304e042b78834443893196dd`.
The private map values are not shown to reviewers.

After trial completion, packet preparation must verify that original map
core and write an exclusive packet-preparation commitment binding the full
packet, private map, report, source, input, selection and pretrial commitment
hashes. Create this before sending any packet to reviewers. Once blinded
ratings are complete, validate and exclusively lock their raw bytes against
that commitment without loading the private map. Only the subsequent
aggregation phase may load and verify the map. Aggregation requires the
external commitment's fixed raw hash and the matching ratings-lock record;
recomputing a caller-supplied map checksum is insufficient.

Keep phase artifacts and reviewer-start evidence to establish this ordering.
Hashes prove byte identity, not by themselves whether someone read a file
earlier. Do not describe these checks as cryptographic proof of blinding.

Reviewers must distinguish directly supported claims, explicitly labeled
inferences, unsupported claims, contradictions and genuine source ambiguity.
Positive interest does not prove dislike of alternatives; a newer unrelated
interest does not cancel an older one. Support anchors must be verbatim,
with exact source ranges validated in code.

Split each response into minimal independently checkable propositions.
Separate conjunctions, numbers, entity/status claims and exclusions when
they could differ in support. Count a repeated proposition once per answer;
retain repeated spans in its record. A bare recommendation is assessed as
a suggestion, not as an assertion of historical preference. Its stated
rationale and any claimed preference, dislike or past event are separately
checkable. A hedge alone does not make an unsupported assertion acceptable.

Give each proposition exactly one label: supported, supported-inference,
unsupported, contradicted or unresolved. A supported inference must identify
its actual source premises and be presented with appropriate uncertainty.
For the gate, unsupported and contradicted form one union count, without
double-counting a proposition. Report both that count and the number of
answers containing at least one such proposition.

Missing final answers count as generation failures and never as grounded
successes. Comparison must produce at least as many final answers in the
review sample as control. An unresolved proposition or disputed segmentation
leaves the grounding gate unproven and stops advancement; do not unmask arms
to resolve a tie. Lock reviewer labels, propositions, quotes and uncertainty
before unmasking or inspecting any arbiter adoption of draft errors.

After the locked source review, unmask only for aggregation and trace any
unsupported final proposition back to the preserved drafts. The sample does
not prove general grounding quality. The gold judge alone cannot establish
grounding improvement.

## Advancement and negative outcomes

All existing numerical requirements remain:

1. Development at least 58/60 and every original seven correct.
2. Locked lexical follow-up at least 93/100 and 14/16 unanswerable.
3. Exact fresh-E5 full500 at least 457/500, 27/30 unanswerable,
   25/30 preferences and every original seven correct.

In addition, adoption of the more expensive answering architecture requires
a strictly higher development correct count than its fresh paired control,
and no increase in unsupported/contradicted answers or claim count in the
preselected blinded grounding sample, with no loss of sampled final-answer
coverage. An inconclusive source review is not proof that this requirement
passed. These conditions establish an experiment-advancement decision, not
production cost acceptance.

Preserve and report these negative outcomes: no paired accuracy benefit,
regressions on previously correct cases, increased unsupported claims, missing
sampled final answers, unresolved grounding, or arbiter adoption of draft
errors. Report per-stage usage, attempts, time, unknown usage and token ratios
descriptively; no later discretionary cost cutoff is a preregistered gate.
Meeting a numerical threshold while only reproducing control performance
does not demonstrate architectural value. A failed requirement stops later
stages; do not add more variants to this trial.

Both validation cohorts remain locked. They are previously evaluated public
data, not unseen holdouts. The new answering plan is an explicit benchmark
configuration, not automatic behavior of ordinary agents connected to Recall.
Known reference errors and ambiguities remain disclosed. No source fact or
unsupported exclusivity may be manufactured to satisfy a gold answer.

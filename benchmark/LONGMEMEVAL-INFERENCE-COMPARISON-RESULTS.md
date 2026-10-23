# LongMemEval paired inference comparison

## Status

The reviewed V3 paired trial completed at **59/60 for both arms**, with all
seven original cases correct and zero errors. Both missed `gpt4_59c863d7`.
There were no paired gains or losses. The comparison treatment fails its
required improvement over the fresh control and does not advance.

The locked seventeen-question source review also fails the grounding gate:
comparison has 36 unsupported/contradicted propositions across seven answers,
versus 29 across six control answers. Both produced all seventeen final
answers. Ten unresolved propositions and one segmentation-uncertainty flag
additionally leave grounding unproven. The sample does not establish general
grounding rates.

Recall's best completed full answer score remains **457/500 (91.4%)**.
This development result does not replace that full score, promote the earlier
rejected adaptive configuration, or change Hindsight's published 473/500.
No locked follow-up100 or full500 was started.

This [single trial](LONGMEMEVAL-INFERENCE-COMPARISON-PROTOCOL.md) compares a
fresh one-pass control with a two-draft/arbitration treatment using the same
complete Recall contexts. It tests additional inference and comparison as a
combined treatment, not statistically independent drafts or an isolated
retrieval improvement. All existing numerical gates remain.

| Stage | Reasoning | Output limit |
| --- | --- | ---: |
| Fresh control | Adaptive | 16,384 |
| Comparison draft A | Low | 8,192 |
| Comparison draft B | Adaptive | 16,384 |
| Final arbiter | Adaptive | 16,384 |
| Each final-answer judge | None | 4,096 |

Every arm contains sixty cases. All 360 model calls completed with global
concurrency at most three. Arbitration instructions reached only the arbiter. Drafts,
answers, failures and usage are preserved; there is no selective output retry,
fallback to a surviving draft or rejudging.

## Completed accuracy and resources

| Measure | Fresh control | Comparison |
| --- | ---: | ---: |
| Correct answers | 59/60 | 59/60 |
| Original seven correct | 7/7 | 7/7 |
| Multi-session | 9/10 | 9/10 |
| Each other category | 10/10 | 10/10 |
| Model calls | 120 | 240 |
| Observed tokens | 2,284,332 | 6,842,109 |
| Sum of call durations | 4,828.706 s | 13,485.288 s |

All calls succeeded on their first attempt, with usage known. Total wall time
was 6,118.177 seconds and total usage was 9,126,441 tokens. Comparison used
approximately 3.00 times the tokens and 2.79 times the summed call duration
without improving accuracy. Summed durations overlap across workers and are
not per-arm wall times or a production latency measurement. Costs remain
descriptive.

Unchanged answering settings have now produced different scores and misses
across completed runs. This establishes observed run-to-run variation, not
its cause or the repeated-run reliability of either arm.

## Locked grounding review

Seventeen review questions were selected before calls: two per category by
fixed seed, union the original seven. Fresh reviewers read complete masked
packets with arm identities, drafts, references and judge verdicts hidden.
The identity/label map was separately committed before any new outputs
existed; ratings were locked before semantic unmasking and arm aggregation.

| Locked source-review measure | Control | Comparison |
| --- | ---: | ---: |
| Unsupported/contradicted propositions | 29 | 36 |
| Answers containing those propositions | 6/17 | 7/17 |
| Final answers produced | 17/17 | 17/17 |
| Unresolved propositions | 7 | 3 |

Every reviewer reported a complete read and no contamination. All thirty-four
ratings have complete segmentation; one additionally flags segmentation
uncertainty. Unresolved findings include genuine temporal scope ambiguity
and a schema limitation: standalone question-clock facts cannot receive a
context-string anchor. That limitation does not show that the supplied clock
is wrong. No exception or relabeling was introduced after seeing outcomes.

The sample records unsupported exclusions inferred from positive interests,
speaker misattribution, and ancillary counting/status claims even when the
benchmark judge accepted the final answer. Exact quote ranges validate text
identity; they do not prove semantic support or reviewer correctness.

The post-lock trace retains all 36 bad comparison propositions from seven
answers. Thirty-three appear in at least one draft's answer field; three are
absent from both answer fields. Exact draft membership is ambiguous for three
propositions, each definitely present in the other draft. The trace validates
115 draft quotation ranges. It does not establish copying or a causal explanation:
the arbiter also received draft reasoning, which the primary trace excludes.
The targeted supplement finds those same three propositions absent from
both preserved answer and reasoning fields, without explicit opposition.
This does not establish their causal origin or improve any locked label.

Advancement additionally requires a strict accuracy gain over the fresh
control, no increase in sampled unsupported/contradicted claims or affected
answers, and no loss of sampled final-answer coverage. Unresolved grounding
or segmentation leaves that gate unproven. Both the strict accuracy-gain
requirement and the sampled non-regression requirement failed. Production
cost adoption remains undecided.

## Verification

The frozen source passed twenty focused tests, strict benchmark TypeScript,
and a complete isolated Node22 current-app gate with **1,383 tests passed
and three skipped**. Independent offline checks covered actual serialized
request settings, 360 injected calls with maximum concurrency three, stage
persistence, grounding commitments and actual CLI execution through canonical,
`/var` and symlink paths.

The completed-run independent audit verified all 120 rows, all 360 stage
records, prompts, effective settings, verdicts, usage, source/dependency bytes
and launch provenance without new model calls or rejudging. The final
grounding-phase integrity audit passed: packet reconstruction, all seventeen
fresh dispatches, actual first-eight returned-response provenance, nine direct
artifact hashes, immutable ratings and recorded phase chronology verified.
Full-read and uncontaminated coverage remain reviewer attestations; child
tool histories were not inspected. Independent review of the post-lock trace
and reasoning supplement passed, covering all 36 claims, fourteen decoded
draft answer fields, 115 draft quotation ranges, fifty final-answer spans
and the four raw reasoning fields relevant to the targeted supplement.

The first source freeze was rejected for a cross-worker abort race. The
auditor reproduced two subsequent draft calls starting after a journal failure
and verified that the corrected per-invocation guards prevent them. Later
test-only additions were frozen separately; no rejected snapshot made native
benchmark calls.

## Frozen evidence

- Execution source:
  `benchmark/data/longmemeval-inference-comparison-source-2026-10-21-v3.tar.gz`,
  SHA-256 `7a87c72079e5b3cfbc0eb59d4e8ee0368b7a81dd833b3f869e76b7401679440d`.
  All 210 parent files remain unchanged, with seven explicit additions.
- Input:
  `longmemeval-context-replay-input-2026-10-21.json`,
  SHA-256 `02cf0ab2fd22d6144d3c85a08bf049a2ac950242a93414eb04bdf63cb0d69fc7`.
  Both arms use only its Recall context.
- Review selection:
  `longmemeval-inference-comparison-grounding-selection-2026-10-21.json`,
  SHA-256 `02acbc6706ad04814e85fea010f695c203d282489b4bd84f39af75315ff3bc1b`.
- Pretrial map commitment:
  `longmemeval-inference-comparison-grounding-pretrial-map-commitment-2026-10-21.json`,
  SHA-256 `bf88e0ad68bd308499942cb43ae201fb16daa693304e042b78834443893196dd`.
- Completed report:
  `benchmark/data/longmemeval-inference-comparison-development60-2026-10-21.json`.
  SHA-256 `38915d24b43312c507088257bbe84b0bc28828820c08b1019d96dccfe3279dff`.
  Its task JSONL, per-call `.calls.jsonl` and final progress snapshot remain
  preserved. The launch record binds source, reviews, inputs and selection.
- Completed independent audit:
  `longmemeval-inference-comparison-completed-audit-2026-10-21-v3.json`,
  SHA-256 `bd0fa20084af2fe856acb2f70459b20a4f215d4b3885cf623b25c2c6223bddb0`.
- Packet commitment:
  `longmemeval-inference-comparison-grounding-packet-commitment-2026-10-21.json`,
  SHA-256 `273e1d6be5d64630462ac77073716f2143bf0dd772ada6e2f427f0707fd9daf2`.
- Locked ratings:
  `longmemeval-inference-comparison-grounding-ratings-locked-2026-10-21.json`,
  SHA-256 `f1ef3a505203da642151680647f6c444c91636c91438f3ae79f51c8a3ecd5a61`.
- Ratings lock:
  `longmemeval-inference-comparison-grounding-ratings-lock-2026-10-21.json`,
  SHA-256 `67d4970d853497420511a3de9c575fad48a596539d92ed49a036b89aa6aacd40`.
- Aggregation:
  `longmemeval-inference-comparison-grounding-aggregation-2026-10-21.json`,
  SHA-256 `7c58fa3bc2b53808e9bedbe9ec4a7d98bbe899740dde73833fe172751ed6de5d`.
- Post-lock draft-answer trace:
  `longmemeval-inference-comparison-draft-error-trace-2026-10-21.json`,
  SHA-256 `d2f4cc1ea1d8e1a5ecaee5fab92c8550f15604f8c20fea4ab0864db38ed9bed2`.
- Targeted draft-reasoning supplement:
  `longmemeval-inference-comparison-draft-error-trace-reasoning-supplement-2026-10-21.json`,
  SHA-256 `eb8d0dce38435be47359022f621d7599fc6419c883a099fa0afb7d12286d5aef`.
- Final grounding-phase independent audit:
  `longmemeval-inference-comparison-grounding-final-independent-audit-2026-10-21.json`,
  SHA-256 `bf45fe3bc2ff221f4f18d98753883489f617d78ef94bf1f3a146934618ff479a`.
- Independent trace and reasoning-supplement review:
  `longmemeval-inference-comparison-draft-error-trace-independent-review-2026-10-21.json`,
  SHA-256 `50b9b4c34e0d3c5c78210663409586b584271d7143a87c515d282a13c056b3ce`.

All 2,810 files across nine physical runtime packages match the pinned
inventory. Private Node22 and shared Node24 native-binding hashes are unchanged.
The trial has no automatic follow-up or full500 producer. Grounding preparation,
dispatch, parent persistence, merge, ratings lock and aggregation retain
separate phase evidence. Hashes establish byte identity; phase artifacts and
tool records establish the recorded ordering, not a cryptographic guarantee
that no person ever accessed a file.

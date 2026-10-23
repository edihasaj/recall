# LongMemEval validity review, updated 21 October 2026

Recall's best completed full answer run remains **457/500 (91.4%)**. Hindsight's
pinned published result remains **473/500 (94.6%)**, using different answer and
judge models. This review changes no result, reference, cohort, or gate.

## Original source IDs in the published Hindsight artifact

An offline audit of the artifact and source at AMB commit
`aef3702e0586a959c845cc2c61f10d5e8ff0f94a` found original `answer_` session IDs
in stored contexts and generated answerer reasoning.

| Observed field | Cases / 500 | Exact original-ID occurrences |
| --- | ---: | ---: |
| Stored formatted context | 61 | 757 |
| Generated answerer reasoning | 7 | 8 |

Six of the seven reasoning cases have no such ID in their stored formatted
context. For example, case `118b2229` cites
`Document ID: 118b2229_answer_40a90d51` in its generated reasoning. These
identifiers therefore appear beyond scorer-only diagnostics.

The pinned dataset loader preserves original IDs in document IDs and context
hints, and the Hindsight adapter forwards them during retention. The adapter
returns formatted documents plus a raw response. The RAG callback supplies that
raw response to the dataset prompt builder, which serializes it when present
instead of using the formatted context. The runner then omits raw responses
from its persisted artifact. Source inspection used AST parsing without
importing or executing the upstream implementation.

The prefix is an imperfect relevance signal. Of the 757 context occurrences,
630 identify sources containing currently marked answer turns and 127 do not.
Abstention variants can also retain prefixed source IDs. An `answer_` ID must
not be described as a perfect gold label for the current question.

Historical wire prompts and raw responses are unavailable. This audit does not
verify exposure for all 500 questions, the SDK's exact serialized fields, an
effect on accuracy, or the exact historical execution of the pinned source.
Hindsight's reported **473/500 (94.6%) remains unchanged**. Recall hides original
source IDs; the two runs are not demonstrated to have equivalent relevance-label
visibility. A matched blinded rerun is needed to attribute a system ranking.

The detailed source trace, exact matches, source hashes and reproduction script
are preserved in `benchmark/data/longmemeval-hindsight-label-trace-2026-10-21.json`
and the adjacent `.py` file. The report SHA-256 is
`71cf8ee39a6c8f84fddf6e562814c8da41934a199ea6ecb50eddc90b82e97f12`.

## Owner-acknowledged reference error

[LongMemEval issue #21](https://github.com/xiaowu0162/LongMemEval/issues/21)
identifies original development case `dd2973ad`. The May 24 source places a
doctor's appointment on May 18, making the preceding day May 17. The May 29
source associates the reference bedtime, 2 AM, with May 24 instead.

The owner [acknowledged the issue on December 22, 2025](https://github.com/xiaowu0162/LongMemEval/issues/21#issuecomment-3682993303):
“Thank you for the feedback! We will fix this issue in a future revision.”
The issue was open when checked. The earlier closed cleanup issue #13
concerns other reports and does not resolve #21.

The current official Hugging Face file `longmemeval_s_cleaned.json` has LFS
SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`,
identical to our frozen raw corpus. We found no changed LongMemEval-S file at
that official release location. Passing this case under the existing judge
does not demonstrate correct temporal reasoning.

## Locally diagnosed ambiguity

Case `0a995998` contains an earlier statement about returning too-small boots
and exchanging them, followed by “I just exchanged a pair of boots” and a
pending pickup. A full scan of the original sessions found no explicit
confirmation that an old-pair return remained pending.

Two pending pickups follow if the exchange completed the old return. Three
pending physical items follow if the old pair still needs returning.
The reference expects three. This is a local interpretation finding, separate
from the owner-acknowledged error above. We have not changed the reference or
credited a failed conditional answer.

### Viewing-preference scope

An independent source-only review of case `32260d93` read all 46 conversations
and 259 user turns with references, annotations and generated outcomes hidden.
It found two direct viewing-related requests: Netflix storytelling stand-up
specials on May 29, explicitly for learning comedy craft, and ancient-Egypt
documentaries or online resources on May 27. The stand-up request is newer and
more specific about format and platform. Neither request explicitly excludes
other genres or establishes an exclusive choice for tonight.

The true-crime interest is explicitly about listening to podcasts. Transferring
it to television or films is an inference. Both replay answers made that
transfer and introduced unsupported general exclusions. These are grounding
weaknesses. The source also supports the documentary interest; treating every
additional visual genre as disqualifying goes beyond an explicit user
exclusion. This is a local scope interpretation finding, not an
owner-acknowledged dataset correction or a regrading of the recorded answers.

The source-only review, role-separated verbatim anchors and reproduction
script are preserved as
`benchmark/data/longmemeval-viewing-preference-source-review-2026-10-21.json`
and its adjacent `.py` file. The input excluded source IDs, references,
`has_answer` annotations and prior outputs. The original reference, verdicts,
scores and gates remain unchanged.

## Evaluator contracts differ

| Contract | Pinned AMB used in these runs | Official LongMemEval evaluator |
| --- | --- | --- |
| Output | JSON `correct` and `reason` | Yes or no |
| Unanswerable questions | Ordinary category prompt with an unanswerable reference | Dedicated unanswerable-question prompt |
| Temporal day-count tolerance | Allows off-by-one answers | Allows off-by-one answers |
| Judge in reported comparison | Qwen locally; Gemini Flash Lite in published Hindsight | README example uses GPT-4o |

The official evaluator was inspected at Git commit
`9e0b455f4ef0e2ab8f2e582289761153549043fc`; external Python was not imported
or executed. The pinned AMB contract remains appropriate for reproducing
that published setup, but its scores must not be described as measurements
under the official evaluator. No answers were rejudged.

## Remaining product and model work

The application fix addresses a demonstrated delivery bug: relevant content
late in a retrieved summary now reaches the agent with its date and scope.
The remaining packed-run losses include dismissing a later explicit mortgage
correction and broadening a specific viewing preference. The needed evidence
was delivered; further retrieval work alone does not establish a remedy.

The packed candidate failed its original gate at 57/60 with five of seven
original cases correct. It must not advance. Additional answer-policy tuning
on this repeatedly inspected public cohort risks fitting its references.
A defensible successor needs a separately frozen hypothesis and validation.
An official-evaluator sensitivity run would also be a separate experiment,
with every selected answer retained and the original scores unchanged.

Matching Hindsight's published models remains unavailable: fresh generation
probes returned 402 `RESOURCE_EXHAUSTED` for Gemini 3.1 Pro Preview and
404 `NOT_FOUND` for Gemini 2.5 Flash Lite. These probes contain no benchmark
questions or accuracy evidence.

## Preserved evidence

The machine-readable review is
`benchmark/data/longmemeval-benchmark-validity-review-2026-10-20.json`.
It records source hashes, the official dataset fingerprint, owner comments,
and the contract comparison. Original issue responses, official evaluator,
README, commit metadata, and Hugging Face tree metadata are preserved beside
it. Provider responses are summarized in
`longmemeval-hosted-availability-recheck-2026-10-20.json`.

This review made no model calls or external communications. The improvement
goal remains unmet.

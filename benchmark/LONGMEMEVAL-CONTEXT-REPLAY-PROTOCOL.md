# LongMemEval saved-context diagnostic, 21 October 2026

## Question and hypothesis

Recall's best completed full run remains 457/500. Supplemental Qwen development
scored 57/60; the Azure answer-model trial scored 54/60. Neither passed its
development gate. The original development cohort already has 112/113 marked
turns delivered, so missing marked evidence does not explain most of its losses.

This diagnostic holds the answer model, judge, question, clock, answer
guidelines and History policy fixed while comparing two saved contexts. The
hypothesis is that the delivered representation and amount of evidence help
explain the remaining answer gap. This is a joint representation-and-quantity
comparison, not a causal estimate of either factor alone.

| Side | Saved evidence | Treatment |
| --- | --- | --- |
| Recall | Completed supplemental development60 `evidence.text` | Preserve byte for byte |
| Hindsight | Pinned published artifact's formatted `context` | Replace original source and question IDs with neutral aliases |

The Hindsight source is AMB commit
`aef3702e0586a959c845cc2c61f10d5e8ff0f94a`, artifact SHA-256
`d0bcc75fb4060f0a395239a353d2066d3f7d252bbe16d674c951d9855deaf9cf`.
The Recall source is
`benchmark/data/longmemeval-supplemental-development60-2026-10-20.json`.
Its selected IDs fix all sixty cases and their order before replay.
No case is selected or excluded using its historical outcome.

## Blinding and context boundaries

Original session IDs can encode an imperfect relevance signal. Neutral aliases
must be assigned by first appearance in the saved context, preserving repeated
references without exposing original source order, source IDs, question IDs,
gold annotations, references or published answers.

Preparation must reject missing, duplicate or mismatched case identities,
question mismatches, malformed contexts, remaining original identifiers or
contexts beyond the common cap. It must verify Recall's saved answer-prompt
hash against the reconstructed prompt. Published answer, reasoning and verdict
fields cannot enter generation. Reference answers and the pinned category
rubrics remain judge-only.

Both sides retain their full saved context under a common ceiling of
210,000 UTF-16 characters. No prefix truncation or case dropping is allowed.
Fifty of the sixty Hindsight contexts exceed the old 180,000-character ceiling;
the largest has 203,248 Python characters before sanitization. The preflight
must measure actual UTF-16 lengths before accepting the new ceiling.
Recall's historical context stays unchanged and may leave more unused space.
Report per-side sizes and token usage. Equal ceilings do not establish equal
evidence amounts or cost.

## Fixed answering and judging

- Use the original sixty prepared questions, normalized clocks and pinned AMB
  answer and judge templates.
- Use `qwen3.8-flash-next`, strict JSON, robust native transport, temperature
  zero, the unchanged system History policy, adaptive answer reasoning and a
  16,384-token answer output limit.
- Keep judges at reasoning `none` and 4,096 output tokens. A judge receives only
  the final answer for that side and its original judge prompt.
- Generate every answer freshly. A side receives neither the other side's
  answer nor historical answers, reasonings, verdicts or reference facts.
- Run both sides for every case. Alternate which side is submitted first by
  fixed case index. Total concurrent model calls must never exceed three.
- Preserve the existing bounded transient HTTP retry policy. Never repair or
  selectively retry a model output, rejudge a result, or restart partial output.
  A request or schema failure counts as incorrect in that side's denominator.

There are 120 answer tasks and at most 120 judge calls. Both sides use the same
model endpoint. Counterbalancing limits order bias but does not establish
matched service latency.

## Checks before calls and reporting

Implementation requires tests and independent review of cohort identity,
source blinding, Recall prompt parity, complete-context bounds, model routing,
output reservation, failure accounting and total concurrency. The controlled
source snapshot extends the frozen 206-member Azure source archive with only
the new replay modules and this protocol. Every parent member remains unchanged.
Effective dependencies and the private Node22 native binding remain pinned.
Do not rebuild a linked dependency tree.

Freeze inputs, source bytes, protocol, selected IDs and effective dependencies
before any live calls. Preparation and tests use no benchmark model requests.
Reserve fresh report, JSONL and progress paths before credential setup. Persist
partial records and all calls, attempts, usage, effective settings, context and
prompt hashes. Summarize each side over exactly sixty cases, retaining errors,
category results and paired gains and losses. A success-only percentage is
secondary and cannot replace the failure-inclusive score.

This diagnostic has no advancement gate and cannot promote a rejected candidate
by rerunning it until it passes. Keep the existing development requirement
(at least 58/60 and all original seven correct), locked follow-up requirement
(at least 93/100 and 14/16 unanswerable), and full E5 requirement (at least
457/500, 27/30 unanswerable, 25/30 preferences and all original seven correct).
The two reserved cohorts remain excluded from this diagnostic. No references,
old verdicts, corpus facts or acceptance requirements change.

## Interpretation limits

This is saved-context replay, not a fresh Hindsight ingestion/retrieval run or
an exact replay of its historical answering prompt. The pinned AMB code can
serialize raw responses instead of stored formatted context; historical wire
prompts and raw responses are unavailable.

Sanitizing saved contexts also cannot undo any influence of original IDs on
upstream retention or retrieval. The systems used different retention paths,
and context amount remains a measured difference. All sixty questions are
repeatedly inspected public development data with no unanswerable cases.
Previously identified reference errors and ambiguities remain visible.

Consequently, a score difference can motivate a separately specified evidence
experiment. It cannot establish a blinded full-system ranking, attribute an
accuracy gain to extraction alone, alter Hindsight's published 94.6%, or satisfy
Recall's existing acceptance gates.

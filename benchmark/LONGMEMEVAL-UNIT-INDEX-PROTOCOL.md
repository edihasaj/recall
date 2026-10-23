# LongMemEval unit-only evidence index

The completed annotated-ledger development run scored 29/60. Its 31 extraction
failures all violated the event-time literal constraint, despite valid source
references and other schema fields. The frozen validator correctly rejected
them; no output was repaired. The 29 surviving answers were all judged correct,
but that selected subgroup does not establish pipeline accuracy.

## Candidate and hypothesis

The successor asks the extractor only to select neutral references:

```text
Original question + same visible source units
    → { selections: [{ source_rank, unit_index }] }
    → validate references
    → materialize exact source quotations and recorded metadata
    → answer with selected quotations AND full original evidence
    → unchanged judge
```

Use the distinct opt-in mode `--evidence-ledger units`. Preserve the failed
`quoted` variant and all its frozen artifacts. Do not transform its invalid
outputs, rejudge its answers or count them as a new result.

Removing model-generated entity, relationship, status and event-time fields
eliminates unsupported annotations rather than accepting record dates as event
dates. Code supplies exact quoted units, UTF-16 ranges, quoted attribution and
observation dates. Those dates remain record metadata. No generated factual
annotation becomes trusted evidence.

The schema permits only a `selections` array of at most 24 objects containing
source rank and unit index. References must identify complete units wholly
visible in the delivered source ranges. Duplicate selections materialize one
quotation; an empty selection is valid. Malformed output, hidden or invalid
references, extra properties and an oversized final rendered index fail the
case without answer or judge calls.

The selection prompt receives only the original question, normalized generation
clock and neutral visible units. It receives no reference, source IDs, original
source occurrence positions, category, answer flags, draft or verdict. This is
a reading index, not a complete fact store or a guarantee of semantic relevance.
The final answer retains the full original evidence. Source instructions and
role labels do not gain instruction authority.

## Fixed resources and evaluation

Keep the extractor at low/8,192, answer at question-only adaptive/16,384, judge
at none/4,096, and total concurrency at most three. Run the actual trial at
concurrency three. Qwen, robust requests and system History policy are required;
the post-answer checker remains disabled. Preserve the accepted History
contract and all original answer/judge requirements.

Keep the 180,000-character source budget and the 18,000-character added rendered
index cap, including escaping and framing. Record all usage, missing usage,
context components, effective settings and failures. Do not retry or repair
unfavorable or invalid extraction.

Freeze and independently review schema, prompts, source/dependency inventories,
inputs and this protocol before calls. Keep disabled native answer/judge
payloads and the earlier quoted-mode behavior unchanged. Build the controlled
QA snapshot from the frozen adaptive parent plus named benchmark changes;
preserve all parent application runtime members.

Run fresh stages serially, retaining every selected case in its denominator:

1. Complete development60 on the original verified rankings. Require at least
   58/60 and all seven original failure cases correct within that run.
2. Only after development passes, run the existing locked lexical follow-up100.
   Require at least 93/100 and 14/16 unanswerable.
3. Only after follow-up passes, run all 500 questions on the exact fresh E5
   rankings used by the high control. Require at least 457/500, 27/30
   unanswerable, 25/30 preferences and all seven original cases correct.

Any failed gate stops later stages. Do not relax thresholds, change cohorts,
tune from locked follow-up outcomes or selectively rerun failures.

## Verification and limits

Retain separate full current-app integration and controlled QA checks as
documented in the [ledger protocol](LONGMEMEVAL-LEDGER-PROTOCOL.md). Verify all
original source evidence and base user-prompt hashes remain unchanged; only
the added reading index changes the final answer prompt. Validate provenance,
fixed per-stage native payloads, indexed JSONL equality, verdicts and complete
usage accounting. Preserve the parent UMP dependency discrepancy and proof
that UMP lies outside the evaluated QA import graph.

The public development corpus has already been used adaptively. A development
pass requires locked follow-up validation and cannot establish generalization
without fresh external evidence. Hindsight's published 94.6% uses different
answer and judge models and remains a reference rather than a matched ranking.

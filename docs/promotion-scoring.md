---
summary: How daily deterministic cleanup promotes candidate memories using resolved evidence.
read_when:
  - Changing candidate promotion or evidence weights
  - Previewing or reverting automatic memory promotion
---

# Candidate promotion

Daily cleanup keeps the existing repetition path: a durable, well-formed
`user_correction` candidate with `repetition_count >= 2` promotes through
`via=repetition`. Destructive rules, session-scoped memories, generated-only
provenance, and fragments remain excluded by its existing checks.

The additional `via=evidence_score` path evaluates every candidate source.
It promotes at a score of **8**, subject to the suppression checks below.
Confidence is the separate injection gate and does not earn score points.
Promotion raises confidence to at least `0.7` and preserves `auto_inject`,
including deliberate opt-outs or sync quarantine.

Repeated `repo_scan` or `config_parse` captures earn no repetition points:
rescanning the same file is not a new confirmation. Those sources need
positive outcome, observed-use, or explicit feedback evidence.

## Evidence weights

| Evidence | Points | Maximum |
| --- | --- | --- |
| Repetition count at least 2 | +8 | 8 |
| Followed outcome per distinct session | +2 | 8 |
| Observed `used` value event per distinct session | +1 | 4 |
| Distinct injected session with a followed outcome | +1 | 4 |
| Distinct UTC injection day with a followed outcome | +1 | 3 |
| Explicit positive feedback per distinct session | +2 | 4 |
| Overridden outcome per distinct session | −2 | Uncapped |
| Contradicted outcome per distinct session | −4 | Uncapped |
| Any unresolved contradiction with a live memory | −6 | Once |
| Candidate older than 90 days with no injections | −3 | Once |

`memory_injections` and injected `feedback_events` can represent the same
outcome, so they are deduplicated by session. A session that reports an
override or contradiction receives no followed credit, even if it also has an
older followed report. Explicit feedback uses `injected=false`; ignored
feedback and implicit signals are visible in explanations but earn no points.

Session and day diversity count only followed injections. This narrows the
original weighting proposal because delivery without a resolved outcome is
not positive evidence: ten unresolved injections and ten observed uses earn
only the capped 4 use points and cannot promote. Two followed sessions on
two different days earn `4 + 2 + 2 = 8`.

## Suppression

The evidence path reports `suppressed` when a memory is destructive-risky,
trigger-shaped, session-scoped, backed by non-user capture context or
non-durable provenance, or a `user_correction` fragment. It also suppresses
when explicit negative feedback exceeds positive feedback, or an unresolved
contradiction names another active or candidate memory.

Literal response contracts such as `Reply only BUILD_READY` belong to the
request that supplied them. They are rejected before correction extraction or
LLM task enqueueing; an LLM result cannot override this boundary by labelling
the contract durable. Rewritten instructions such as `Use Reply only ...
instead` are covered too. This is a general contract check, not a marker
blacklist. Output-format and language preferences remain eligible.

The same provenance guard suppresses promotion and both ambient and queried
injection of legacy rows when their text is a fixed-response instruction, or
all their original correction/review evidence is generated or task-limited.
Independent durable evidence is retained. Existing provenance cleanup can
quarantine affected rows reversibly without erasing the audit trail.

Following a test prompt, or observing its literal answer in later completions,
does not make it a standing preference. Regression tests reproduce a historical
score of 8 from one followed outcome, five observed uses (capped at four
points), one injected session, and one injected day. The provenance guard
suppresses that candidate regardless of score or repetition.

Before accepting a scored candidate, cleanup checks it against active
memories and earlier accepted promotions using the existing contradiction
detector. Conflicts suppress the new promotion. Otherwise, scores below 8
report `needs_more_evidence`. Neither decision changes the memory.

## Preview and revert

Both paths use the existing `promote_repeat_correction` action:

```sh
recall maintenance cleanup --only promote_repeat_correction
recall maintenance cleanup --apply --only promote_repeat_correction
recall maintenance cleanup --revert <run-id>
```

A cleanup run previews changes by default; only `--apply` mutates memories.

A scored preview includes its reasons:

```text
promote: 12345678  via=evidence_score score=8 [followed=2:+4, injected_sessions=2:+2, injected_days=2:+2, meets_promotion_threshold]
```

Applied promotions record the score and explanation in the existing cleanup
log and audit trail. Reverting restores the candidate's prior status and
confidence. No schema change or model call is required.

The scorer borrows the evidence-and-explanation pattern from Oktapod's
consolidation design. Recall has no code dependency or runtime integration
with Oktapod.

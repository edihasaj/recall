---
summary: Memory-quality audit findings, evidence limits, and verification of the October lifecycle fixes.
read_when:
  - Evaluating memory quality over weeks or years
  - Investigating zero active memories after cloud sync
  - Reviewing the October 2026 promotion, retention, or reliability changes
---

# Memory-quality audit: 14 October 2026

Recall has useful quality machinery, but this audit does not establish that
saved memories, model rewrites, or injected context remain correct over years.
It found reproducible lifecycle defects and verified their fixes. Long-term
usefulness still requires retained outcome evidence and retrieval evaluations.

## What the snapshot proves

The consistent local snapshot contained 3,965 memories: zero active, 874
candidates, and 3,091 rejected. Of the candidates, 642 had automatic injection
disabled; 866 candidates were foreign synced records. Local injection,
quality-snapshot, and cleanup histories were empty, and the local audit began
around the recent cloud reimport. These are snapshot facts, not evidence that
the whole system had failed for months.

Most candidates were intentionally quarantined on arrival from another device.
The restoration preview selected **zero** memories: no eligible row had a
matching auto-pruner archival audit. Of the never-injected archived candidates,
578 were below the threshold, one was risky, and 55 lacked archival proof.
High confidence alone cannot distinguish quarantine from an accidental archive.

Repository attribution originally appeared to be 11.2%. Filesystem inspection
identified 140 of 156 sessions as unscoped, mainly at organization directories.
All 16 scoped sessions were attributed. Scope coverage was still only 10.3%,
and recorded retrieval observations remained zero. Correcting the denominator
did not improve actual memory delivery.

## Changes and purpose

| Boundary | Verified behavior |
| --- | --- |
| Local promotion | Positive outcomes earn a capped score; unresolved delivery earns none. Explanations and reversals use existing audit storage. |
| Candidate retention | Unmeasured candidates survive archival; restoration requires unchanged auto-pruner proof. |
| Repository quality | A store with no active memories cannot raise its confidence gate from candidate/rejection counts alone. |
| Reliability | Daily verdicts expose failure, stale observations, and limited scope coverage. Observation gaps break sustained-failure streaks. |
| Stop hooks | Known id formats work; ambiguous session fallback cannot misattribute outcomes. |
| Retrieval text | Cloud diagnostic segments cannot pollute user applicability text. |
| Cloud merge | Active winners survive; folded positive evidence requires retained, disjoint provenance and cannot inflate on replay. |
| Cloud promotion | Repetition or followed evidence can qualify; injection alone cannot. Shadow remains the default. |
| Sync ownership | Devices cannot forge server judgements. Atomic upserts preserve valid folds and unknown negative evidence. |

The promotion preview proposed two existing repetition-path promotions and
zero new evidence-score promotions. No snapshot preview was applied. The
ordinary prune preview affected only rejected retention; it proposed no
candidate archival. These previews are not recommendations to activate live
foreign memories.

## Verification and limits

Recall passed typecheck, docs, production build, and **1,027 tests**, with three
existing opt-in tests skipped. A separate real-Nomic canary then passed native
embedding persistence, semantic retrieval, hook emission, observed outcome,
and database integrity. A separate compiled MCP process captured a synthetic
correction, returned its pending label, confirmed and retrieved it, and
excluded it from another repository.

Recall Cloud passed **526 backend tests without skips** against disposable
Postgres and **91 sync tests**. Portal checking reported zero errors and
warnings; its production build and operations gate passed. The published sync
bundle also started successfully after all required helper modules were added
to the portal and device installers. No schema or dependency versions changed.

All mutation probes used disposable stores. No live memory was confirmed or
restored, no installed signed app was replaced, and these commits were not
pushed or deployed. Oktapod supplied design patterns only.

Cloud outcome counters remain authenticated-device assertions; the current
client does not push followed counts. Keep cloud promotion in shadow until
that evidence and its trust boundary have been evaluated. This pass does not
measure rewrite fidelity, real-agent compliance, or multi-year retrieval
quality. An isolated successful canary proves its exercised path, not those
broader properties.

See [promotion scoring](promotion-scoring.md),
[reliability](reliability.md), and [retrieval text](retrieval-text.md).

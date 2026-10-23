# UMP structured temporal capture results

**Decision: retain the local prototype for development; do not enable automatic
capture, ordinary UMP server routing or Cloud integration.** UMP carried the
supported fields, but the new capture prompt did not improve quality and exposed
a plan-versus-state gap in the shared validator.

## Fresh comparison

The frozen [protocol](TEMPORAL-UMP-PROTOCOL.md) used 24 authored synthetic worlds,
36 source messages, 24 supported state assertions, 12 refusal sources and
34 queries. These are development fixtures, not an independent conversation
benchmark or a production quality estimate. Capture never received questions
or expected answers.

| Measure | Matched v3 capture | UMP structured capture |
| --- | ---: | ---: |
| Correct stored assertions | 19 | 16 |
| Incorrect stored assertions | 0 | 4 |
| Missed supported assertions | 5 | 8 |
| Stored-assertion precision | 100% (19/19) | 80% (16/20) |
| Supported-assertion recall | 79.2% (19/24) | 66.7% (16/24) |
| Unsupported sources that wrote assertions | 0/12 | 4/12 |
| Exact source outcomes | 31/36 | 24/36 |
| Correct structured lookups | 29/34 (85.3%) | 27/34 (79.4%) |

The raw-source arm answered 29/34 questions correctly. It received natural
questions and complete small-source evidence; the captured stores received
explicit query fields. This comparison does not establish equivalence between
raw answering and autonomous memory use.
All five raw-arm failures violated the requested JSON output shape: three used
Markdown fences, one returned a top-level array and one mixed prose with JSON.
Three nevertheless contained the expected values; two also contained wrong
values. The strict 29/34 score includes these format failures and should not be
described as five reasoning failures.

Both capture arms used the same frozen v3 validator, declared property policies,
trusted speaker metadata and source evidence. Their extraction prompts and
record formats differed. Differences therefore cannot be attributed to the UMP
protocol alone.

| Category | Matched v3 lookups | UMP lookups | Raw answers |
| --- | ---: | ---: | ---: |
| First-person states | 2/5 | 2/5 | 5/5 |
| Dated changes | 7/8 | 7/8 | 4/8 |
| Late corrections and conflicts | 8/9 | 6/9 | 9/9 |
| Future-plan refusal and current state | 4/4 | 4/4 | 4/4 |
| Ambiguity and negation | 4/4 | 4/4 | 4/4 |
| Unsupported event refusal | 4/4 | 4/4 | 3/4 |

The four future-plan lookup successes do **not** excuse the four incorrect
writes. These questions ask about current state before the planned effective
dates, so an erroneously stored future assertion can remain invisible to that
question. The separate capture metrics expose the error.

## What failed

- All three supported first-person “my property has been VALUE since DATE”
  sources failed in both arms with `ungrounded_speaker_value`. This shared
  validator limitation was reproduced before model execution and was retained
  in the frozen fixtures.
- Both arms rejected two valid replacement assertions. The UMP arm rejected
  three additional supported correction/conflict assertions. Its overall
  eight missed states comprise three first-person sources, four replacement
  sources and one independent report.
- The UMP model emitted four future schedules as state records. All four
  passed the shared validator, violating this capture profile's state-only
  contract. Three quotes retain the explicit “future schedule” wording; one
  excludes that prefix. This is not solely a quote-clipping problem.

The native temporal store deliberately permits explicit future-effective source
assertions. The automatic language-capture contract is narrower and must
distinguish plans from asserted continuing states. Neither a UMP schema nor a
source quote proves that semantic distinction.
An independent deterministic replay of the four cached proposals directly
through v3 accepted all four as well. The semantic gap belongs to the shared
validator; the UMP bridge did not bypass its checks. These source-supported
plans are incorrect captures for this profile, not invented source claims.

## Technical validation and scope

The new explicitly invoked `src/temporal/ump.ts` bridge validates the supported
UMP draft profile, binds a trusted owner/project/source, checks grounding through
v3 in a scratch database, and atomically stores a receipt with the accepted
assertion. Replay includes the supported record and normalized trusted source,
including speaker metadata. Owner/project namespaces remain separate.

Seven focused tests and independent probes passed for replay changes,
metadata privacy, same-day and offset timestamps, retroactive predecessor
ordering, concurrent replay and ordinary-memory separation. Review found and
corrected three initial bridge defects before the model run: raw timestamp
comparison, scratch-copy dependency ordering and unfiltered speaker metadata.

The complete test suite passed with 1,161 tests and three existing skips. The
first isolated run omitted Swift source and packaging assets; copying those
existing assets into the snapshot resolved the three environment failures.
Strict source/harness/test typechecks, the application build, documentation
checks and whitespace checks passed.

The bridge is an application profile over the installed UMP 0.1.0 SDK. It is not
a full UMP record/lifecycle implementation, an upgrade to UMP 1.0, a running
server connection or a Cloud round trip. It rejects unsupported lifecycle,
consent, integrity and relationship fields. No automatic instruction injection,
Cloud synchronization, deployment, commit or push was performed.

## Accounting and reproducibility

- Model: `qwen3.8-flash-next`; reasoning disabled; temperature zero; 512 output
  tokens; at most three worlds active.
- Fresh calls: 106, comprising 72 capture calls and 34 raw-answer calls.
- No request or world failures occurred. The five raw-answer format failures
  count as wrong answers, rather than request failures. Deterministic capture
  rejections remain visible separately.
- Observed usage: 68,479 prompt tokens plus 16,115 completion tokens, totaling
  84,594 tokens. No usage counters were missing; dollar cost is unknown.
- Model-run elapsed time: 173.239 seconds. There were no retries, cached
  capture responses, cached answers or model judges.
- All 13 pre-run frozen source/dependency hashes still match the working tree.
  The original v3 implementation and its tests retain their previous hashes.
- Independent numerical, source and prompt reconstruction passed 863 checks
  with no discrepancies. It verified all 106 prompt hashes, the reported
  metrics, assertion fingerprints and temporal-query outcomes.

Ignored local artifacts:

- `benchmark/data/temporal-ump-fresh-2026-10-19.json`
- `benchmark/data/temporal-ump-frozen-2026-10-19.json`
- `benchmark/data/temporal-ump-source-2026-10-19.tar`
- `benchmark/data/temporal-ump-independent-review-2026-10-19.md`

The candidate failed the predeclared 95% precision, 80% recall, zero unsupported
writes and matched-control query gates. UMP remains useful as a shared contract;
this run does not demonstrate improved memory intelligence or superiority over
APEX-MEM, which was not run.

# Temporal v4 release and retest

**Status: both complete public attempts have finished; keep automatic capture
experimental.** UMP 1.0.2 is released on GitHub, and the code gates passed.
After the first attempt's provider outage, the complete recovery repetition
scored 168/434 for both temporal v4 and shared raw, versus 179/434 for full raw.
Its single temporal augmentation added no accuracy gain. Capture also retains
confirmed event-versus-state defects. These results do not support automatic
capture or Cloud integration.

## Release and code validation

[UMP 1.0.2](https://github.com/edihasaj/universal-memory-protocol/releases/tag/v1.0.2)
is published on GitHub from commit
`b5243635d76bc7e5bf487660ce3dd928cf6a5258`, with its npm-layout archive and
SHA-256 checksum. CI passed on that commit. The release corrects reference-store
default validity filtering and uses one instant for validity and recency.
Its 72 tests, typecheck and build passed.

The npm registry rejected publication with HTTP 404/permission denied; the
stored login returns HTTP 401. The registry still serves 1.0.0. Recall explicitly
pins the GitHub 1.0.2 archive in its package manifest and lockfile, rather than
claiming that npm 1.0.2 exists. The downloaded release archive and the installed
SDK passed current-window, bounded-window, future-query and legacy-normalization
smoke checks.

Archive SHA-256:
`723a62a20d1affb64b7e4e0bb20c94920a429eafa6cd595396dc7cacc49c3d9b`.

Recall's separate `intake-v4.ts` candidate preserves the original source text,
speaker receipts and append transaction. It adds narrow perfect-tense
first-person grounding, state-only plan refusal, adjacent explicit replacement
proof, and independent-report disclaimer handling. Review additionally fixed
governing plan labels across line boundaries, hedged replacement evidence and
predecessor substring matches.

Before provider execution, the frozen Recall candidate passed 1,180 tests with
three existing skips. Strict source, new harness and test typechecks,
documentation checks, application build and whitespace checks passed.
Independent review passed 11 safety probes and four
ownership probes. This remains an explicitly invoked development candidate;
automatic capture and Cloud synchronization were not enabled.

V4 source SHA-256:
`48aea5bdb0772bb908b5d12b40db05eaf8d1ba8d9a75d0ba7171ec4aefd65a3b`.

## Complete development rerun

The original 24 authored worlds contain 36 sources, 24 supported state
assertions, 12 unsupported sources and 34 lookups. They are development-exposed
examples. The same v4 validator, policies and trusted metadata serve both
capture arms.

| Measure | Matched v4 | UMP v2 |
| --- | ---: | ---: |
| Correct stored states | 22/24 | 21/24 |
| Out-of-contract stored states | 0 | 0 |
| State precision | 100% (22/22) | 100% (21/21) |
| State recall | 91.7% | 87.5% |
| Correct structured lookups | 32/34 | 31/34 |

All 106 fresh requests completed without transport failures or missing usage.
The run observed 84,765 tokens and took 257.477 seconds. UMP's one capture
schema error rejected mismatched `body.text` and `structured.quote`; it was not
a request failure. Both arms still refused two valid replacements, with the
schema failure accounting for UMP's additional missed state.

RAW scored 25/34 under the frozen strict output contract. Eight failures
contained correct intended values in invalid output formats; one was a
substantive exclusive-endpoint error. A secondary manual format-tolerant
reading would be 33/34, not a replacement for the primary score. The stores
also receive explicit query fields while RAW receives natural questions.
These differences prevent a general reasoning-superiority claim.

Independent reconstruction passed 560 checks and manually verified all 43
accepted states against source text, dates, ownership and replacement links.
The UMP arm still fails the requirement to match the control's lookup score.

## Newly authored challenge

A separate worker authored 12 additional targeted synthetic worlds without
reading the candidate implementation. These contain 19 sources, 13 supported
states, six unsupported sources and 19 lookups. They are a small authored
challenge, not a public holdout or representative conversation sample.

| Measure | Matched v4 | UMP v2 |
| --- | ---: | ---: |
| Correct stored states | 10/13 | 8/13 |
| Out-of-contract stored states | 0 | 0 |
| Correct structured lookups | 16/19 | 10/19 |

The challenge made 57 fresh requests. All five request timeouts affected UMP
capture of supported sources; those failures and unknown usage remain counted.
Matched v4 refused three supported replacements through conservative
validation. Every unsupported source in both arms completed with no write or
capture error.

RAW scored 15/19: two format-only failures and two substantive temporal
errors. A secondary manual format-tolerant reading would be 17/19; the strict
primary score remains 15/19.

Independent reconstruction passed 304 checks and manually verified all 18
accepted states. Provider timeouts limit conclusions about the UMP arm, and
replacement recall remains a real implementation limitation.

## Availability accounting

Before the complete development rerun, an overloaded attempt made all 106
requests and incurred 25 timeouts. It remains recorded separately:
matched 21/34 lookups, UMP 16/34, RAW 27/34. No out-of-contract states were
stored. All failed calls and 25 missing usage counters are retained. One UMP
unsupported-source request timed out, so only
11 of its 12 unsupported-source refusals were verified in that attempt.

Read-only Spark metrics showed heavy other traffic, sometimes filling all
eight sequence slots per worker, with completion times exceeding the unchanged
45-second deadline. The [capacity controller](TEMPORAL-V4-CAPACITY-RUN.md)
therefore gates whole stages on recorded headroom. The original near-idle
controller was superseded before any model stage; the replacement requires
at most three other running requests per worker and no waiting requests in
three samples 20 seconds apart.

The controller never retries individual model calls, changes model parameters
or cancels another workload. It preserves the overloaded attempt and runs the
complete development repetition, challenge and full public comparison
separately. Stage admission does not reserve resources; later timeouts still
count. No dollar price is known for these calls.

## Complete public recovery repetition

The [separate recovery protocol](TEMPORAL-V4-RECOVERY-RUN.md) retained the
outage-contaminated attempt and repeated every question with fresh model calls,
the same frozen runtime, model, prompts, deadline, concurrency and scoring.
Admission passed three capacity samples 20 seconds apart. No candidate fixes
or selective request retries were introduced between the public attempts.

All 434 planned questions completed in 10,325.218 seconds (172.1 minutes).
This remains an exposed development repetition using lexical retrieval,
not an official benchmark or a measurement of deployed Recall or Recall Cloud.

| Cases | Shared raw (20k) | Temporal v4 (20k + up to 4k) | Full raw (24k) |
| --- | ---: | ---: | ---: |
| User facts (54) | 7/54 | 7/54 | 9/54 |
| Assistant facts (46) | 28/46 | 28/46 | 34/46 |
| Preferences (20) | 3/20 | 3/20 | 4/20 |
| Multiple sessions (111) | 39/111 | 39/111 | 41/111 |
| Temporal reasoning (117) | 40/117 | 40/117 | 37/117 |
| Knowledge updates (62) | 28/62 | 28/62 | 31/62 |
| Abstentions (24) | 23/24 | 23/24 | 23/24 |
| All planned cases (434) | 168/434 (38.71%) | 168/434 (38.71%) | 179/434 (41.24%) |

The temporal arm had zero wins, zero losses and 434 ties against shared raw.
Against full raw it had 10 wins, 21 losses and 403 ties. The frozen clustered
bootstrap reports a −2.5346 percentage-point difference, with a 95% interval
of [−5.1163, 0], across 409 clusters and 10,000 resamples. The experiment
does not demonstrate the required five-point gain with a positive lower
interval. The assistant-fact difference against full raw is −13.0435 points;
preferences differ by exactly −5 points (3/20 versus 4/20), despite a tiny
floating-point overshoot in the raw diagnostic. The ordinary-category gate
fails on assistant facts regardless of that numerical boundary.

Only one question used an actual augmentation: volleyball team Net Ninjas'
5–2 record in `c7dc5443`. The exact trusted user source reports that record on
June 30. The temporal arm preserves all 20,000 shared characters and adds
615 characters; all three fresh answers correctly return 5–2 and cite that
source. The prior 3–2 source was rejected during capture, so the example
demonstrates a current assertion lookup rather than stored-history replacement
or conflict resolution. It adds no answer-accuracy gain. All other questions
use the shared raw fallback.

There were 5,989 unique model calls: 4,279 capture, 434 query, 867 answer and
409 judge calls. Of these, 280 had request failures (278 capture and two
answer), and 23 additional capture schema failures bring unique failed calls
to 303/5,989 (5.06%). Failures affected 222/434 cases (51.15%), exceeding the
protocol's case-level failure gate. There were no query or judge request
failures. Request errors were 228 timeouts and 52 other request failures;
there were no HTTP 503 errors in this repetition. Capture's 1,194
`ungrounded_new_key` rejections remain distinct from transport and schema
errors; deferral is not successful extraction.

Observed usage totals 9,708,886 tokens, with unknown usage for 280 failed
requests. Capture and query alone account for 5,030,184 observed tokens.
Total token usage and dollar cost remain unknown. These are combined
experiment costs, not independent per-arm totals or deployed query latency.
The extra capture and query work produced no demonstrated accuracy gain.

Independent semantic review inspected every accepted assertion:

| Classification of the 27 accepted records | Count |
| --- | ---: |
| Plausible source-reported states or static properties | 9 |
| Claims needing approximation, draft, estimate or currency qualifications | 7 |
| Ambiguous release-year metadata requiring a schema policy | 1 |
| Confirmed completed events outside the state-only contract | 10 |

The ten event violations include replacement actions, attendance, starting or
finishing reading, a birth, receiving replies and membership expiry. Literal
source support does not make those ongoing states. Assigning the source's
observation date also does not establish their actual event time. Qualified
claims include approximate prices, an assistant-generated draft appraisal,
typical seasons and reported population or salary estimates. Speaker/source
support does not independently authenticate those external claims. This
qualitative audit is not a population capture precision or recall estimate.

In the first 12-record checkpoint, all capture-positive query calls completed
successfully and explicitly fell back: ten stored properties did not answer the
question, and two relevant event records lacked the elapsed-time or aggregation
operation and required endpoints. This is a representation/query mismatch,
not assertion budget overflow. The complete 27-record ledger retains the
source snippets, trusted roles, proposals, stored payloads and query outcomes.

The final independent numerical audit passed 17,999 checks, including the
full selection, original 21-file freeze and dependency tree, fresh call
identities, within-case reuse, answer/judge prompt hashes and shuffled verdict
mapping, citation validity, failures, usage and independent clustered bootstrap.
All 27 source prefixes and speaker spans were independently rederived from the
original structured dataset. All primary scores reconstruct exactly.
Manual secondary review inspected all 31 full-control disagreements and seven
stated positive agreements spanning every category and abstention. No concrete
answer-ID or semantic-grade error was found, and no grades were replaced.
Wedding cousin identity remains ambiguous in the cited excerpts, and several
month/week answers depend on the reference's rounding convention. These checks
do not certify every claim's evidence entailment or the judge's general accuracy.

Recovery artifact SHA-256:
`87bec4651f5839294af3be2b4418e712bb824295e511f93cb598792b24fe9c96`.

## First complete public attempt: provider outage

The [public protocol](TEMPORAL-V4-REAL-PROTOCOL.md) uses all 434 original exposed
IDs, including six answerable categories and 24 abstentions. Capture, natural
query parsing, answers and model judging all use new calls. The answering
controls share the same fresh lexical retrieval, model and evidence budgets.
Identical evidence may share one new answer only within the same case.

The run completed all 434 planned cases in 6,595.147 seconds (109.9 minutes).
Of 5,726 unique model calls, 3,749 had request failures: 3,386 HTTP 503 errors,
291 timeouts and 72 other request failures. Four additional capture schema
failures bring the unique failed-call count to 3,753/5,726 (65.54%).
Request, schema or case failures affected 394/434 cases (90.78%). The controller
exited successfully because failed requests remain scored cases; a zero process
exit code does not mean that the provider or quality gates passed.

The following are **failure-inclusive diagnostic counts**, not estimates of
quality with reliable inference. The service failure occurred before the
temporal, knowledge-update and assistant-fact portions could receive usable
answers. Their zero scores cannot establish inability in those categories.

| Cases | Shared raw | Temporal v4 | Full raw |
| --- | ---: | ---: | ---: |
| User facts (54) | 5/54 | 5/54 | 7/54 |
| Assistant facts (46) | 0/46 | 0/46 | 0/46 |
| Preferences (20) | 0/20 | 0/20 | 0/20 |
| Multiple sessions (111) | 24/111 | 24/111 | 28/111 |
| Temporal reasoning (117) | 0/117 | 0/117 | 0/117 |
| Knowledge updates (62) | 0/62 | 0/62 | 0/62 |
| Abstentions (24) | 8/24 | 8/24 | 8/24 |
| All planned cases (434) | 37/434 | 37/434 | 43/434 |

Temporal v4 used zero actual augmentations, so it reused the same fresh
answers as shared raw in every case: zero wins, zero losses and 434 ties.
Against full raw it had one win, seven losses and 426 ties. The frozen
10,000-resample bootstrap over 409 source-connected clusters reports a
−1.3825 percentage-point difference, with a 95% interval of
[−2.7714, −0.2283]; shared raw's difference and interval are all zero.
This arithmetic describes the outage-contaminated attempt and does not remove
the availability confound. The gain and request-failure gates failed.

Independent reconstruction passed 17,212 checks covering the full selection,
frozen runtime, fresh call identities and within-case reuse, answer parsing,
citations, shuffled judge prompts, verdict mapping, category counts, failures,
usage and bootstrap. Manual review inspected all eight full-control
disagreements and a stated five-case agreement sample without changing grades.
No judge-mapping discrepancy was found. The wedding-count disagreement matches
the reference but has ambiguous cousin identity in its cited source excerpts;
semantic correctness is not certification that every claim is source-entailed.

Capture stored only four assertions. Independent semantic review found two
state-only contract violations. In `q7527f7e2`,
the source says "the landlord only recently finished his repairs", but capture
stores `landlord.finished_repairs = "recently"` as an open-ended state.
The text supports a completed event and relative event time, not that state.
In `q2311e44b`, "I recently replaced the living room table lamp with a new one"
becomes `living room table lamp.replaced_with = "new one"` with an open
interval. It records a replacement action with an unresolved new object,
rather than a directly asserted continuing property. The other two assertions
are plausible continuing source assertions. No assertion augmented an answer.
Source matching alone therefore does not establish correct capture, even after
the v4 fixes. The public corpus has no gold assertion set, so this small audit
does not establish population capture precision or recall.

Observed usage totals 3,300,522 tokens. Usage is unknown for the 3,749 failed
requests, so total tokens and dollar cost remain unknown. Historical 165/434
and 182/434 figures remain historical context, not a fresh matched v3 control.
The public evaluation still omits production embeddings, reranking, automatic
lifecycle and Cloud.

Read-only infrastructure checks established that both Spark hosts rebooted at
13:27:50–52 UTC, their router stacks restarted at 13:28:02–05, and the Bubble
model API became ready at 13:30:58, after this run ended at 13:30:13. Both
workers and routers were healthy at 13:33–34. The reboot cause is unknown.
The [recovery repetition](TEMPORAL-V4-RECOVERY-RUN.md) preserves this complete
attempt and repeats all 434 questions with the same frozen candidate, model,
deadline and scoring in a separate artifact. The synthetic runs are retained
without repetition.

## Integration decision and reproducibility

Keep automatic conversational capture and Cloud integration disabled. The
clean development repetition still misses supported replacements and does not
meet UMP's no-loss gate against matched v4. The complete public recovery
repetition adds no demonstrated answer benefit, incurs substantial extra
capture/query work, and retains event-versus-state defects. Fixing SDK
validity selection does not settle semantic extraction quality.

Change the capture and query design before another large quality run.
Independently checked state/event semantics, supported-replacement recall and
useful key/query matching need to improve first. Preserve both complete public
attempts; do not retry selected errors or substitute successful-case-only
scores. A later changed candidate also needs reliable inference, representative
deployed retrieval, privacy, retention, removal, portability and Cloud round
trips before broader integration.

The source-language gap has two parts. Event exclusion still relies on the
capture prompt for open-schema past-tense predicates, which allowed completed
actions to be stored as states. Conversely, literal ownership and predicate checks
reject some plausible states. A deterministic diagnostic of the first 12
questions inspected 25 `ungrounded_new_key` rejections: recurring train use
("I've been taking the 8:00 AM train") does not match the generated
`takes_train` predicate literally, and a company capability expressed with
"They" requires entity coreference. A car-possession example also needs its
historical date and time basis resolved correctly. Most other sampled
rejections were events outside the state-only contract.
This small diagnostic is not an accuracy estimate and does not justify
broadly weakening grounding. Semantic relation/entity resolution and a separate
event representation need their own evaluated design.

The 21-file pre-provider freeze and full runtime archive retain the exact
candidate, package lock, fixtures, protocols and supporting source. Earlier
frozen v3/UMP implementations and results remain unchanged. Local ignored
artifacts include:

- `temporal-v4-frozen-2026-10-19.json`
- `temporal-v4-runtime-2026-10-19.tar`
- `temporal-ump-v2-fresh-2026-10-19.json` (overloaded attempt)
- `temporal-ump-v2-capacity-fresh-2026-10-19.json` (complete development repetition)
- `temporal-v4-challenge-fresh-2026-10-19.json`
- `temporal-v4-real-2026-10-19.json` (complete outage-contaminated public attempt)
- `temporal-v4-real-recovery-2026-10-19.json` (separate complete public repetition)
- `temporal-v4-recovery-controller-2026-10-19.json` (repetition admission and execution)
- `temporal-v4-recovery-wrapper-2026-10-19.py` (exact executed wrapper)
- `temporal-v4-recovery-assertion-audit-2026-10-19.json` (independent semantic ledger)
- `temporal-v4-capacity-controller-2026-10-19.json` (superseded waiting record)
- `temporal-v4-headroom-controller-2026-10-19.json` (complete execution record)

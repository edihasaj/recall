# LongMemEval saved-context diagnostic

## Status

The corrected live replay completed and passed independent audit: **58/60**
for Recall's saved contexts and **56/60** for Hindsight's saved contexts.
Both sides used the same Qwen answerer and judge and had zero request errors.
Both passed five of the seven original cases. This diagnostic does not advance
a rejected candidate or satisfy the original-seven requirement.

Recall's best completed full score remains **457/500 (91.4%)**; Hindsight's
published result remains **473/500 (94.6%)**.

This [diagnostic](LONGMEMEVAL-CONTEXT-REPLAY-PROTOCOL.md) compares two complete
saved contexts for each original development question using the same Qwen
answerer and judge. It compares representation and evidence amount jointly.
It is not a fresh Hindsight run, a reproduction of its missing historical
raw-response prompt, or an acceptance-gate advancement.

## Completed comparison

| Measure | Recall context | Hindsight context |
| --- | ---: | ---: |
| Correct / 60 | 58 | 56 |
| Original seven correct | 5 | 5 |
| User facts / 10 | 10 | 10 |
| Multi-session / 10 | 9 | 10 |
| Preferences / 10 | 9 | 8 |
| Temporal reasoning / 10 | 10 | 9 |
| Knowledge updates / 10 | 10 | 9 |
| Assistant facts / 10 | 10 | 10 |
| Request or schema failures | 0 | 0 |
| Answer and judge calls | 120 | 120 |
| Observed answer-plus-judge tokens | 2,290,431 | 2,957,748 |

Hindsight's saved context gained the clothing-count case, `0a995998`, while
losing `75832dbd`, `9a707b81` and `830ce83f` against Recall's fresh answers.
Recall also failed viewing-preference case `32260d93`, which both sides missed.
Every call completed on its first attempt, with usage known. Total observed
usage was 5,248,179 tokens over 3,991.796 seconds (66 minutes 31.8 seconds).
This excludes historical ingestion and retrieval cost.

Recall's two misses concern interpretation of delivered evidence. The clothing
count retains its previously documented ambiguity about whether an exchange
completed the old return. For the viewing question, both answers correctly
included storytelling stand-up comedy but broadened recommendations to true
crime and other interests. The judge requires the narrower Netflix stand-up
preference. The original reference and verdict remain unchanged.

An independent source-only review subsequently found direct requests for both
storytelling stand-up and ancient-Egypt documentaries, with no exclusive
genre/platform preference for tonight. True crime was requested as podcasts,
so its transfer to visual media is an inference; the answers also invented
general avoidance preferences. The
[validity review](LONGMEMEVAL-VALIDITY-REVIEW.md) separates these grounding
weaknesses from the narrower reference interpretation. No answer was regraded.

The results do not support assuming that substituting these saved Hindsight
contexts would improve Qwen's answers on this cohort. They do not establish a
full-system ranking or isolate retention, retrieval, context size or formatting.
The repeatedly inspected sixty-question cohort has no unanswerable cases, and
the two-answer difference is descriptive. A rerun of the previously rejected
Recall configuration cannot promote it; all existing acceptance gates remain.

## Prepared input and checks

All sixty original questions match, contain no unanswerable cases, and exclude
both reserved validation cohorts. Recall's context text and reconstructed
answer-prompt hashes match its completed supplemental control. Hindsight's
saved contexts have original source and question identifiers replaced by
consistent aliases assigned by first appearance; other text is preserved.

| Complete prepared context | Recall | Hindsight |
| --- | ---: | ---: |
| Total UTF-16 characters | 9,559,549 | 11,175,338 |
| Largest case | 179,999 | 206,448 |
| Common per-case cap | 210,000 | 210,000 |

Aliases can be longer than original identifiers. Neither side was clipped or
filtered. Sanitizing generated context cannot undo any original-ID effects
during upstream retention or retrieval.

The pinned adapter formats retrieved facts with occurrence/mention dates and
inlines original chunk text once per chunk identifier. Its generic defaults
allow 32,768 fact tokens and 16,384 chunk tokens, with a high search budget.
Environment overrides can change those limits; the historical environment is
unavailable. These source defaults therefore do not establish the published
run's exact request budgets. The source-only review is preserved as
`benchmark/data/longmemeval-hindsight-context-budget-source-review-2026-10-21.json`.

Nine focused tests and strict benchmark TypeScript checks passed. Independent
injected-call checks covered source blinding, template validation before
credential setup, actual model configuration, side isolation, error accounting,
all 120 task identities and a maximum of three concurrent calls. All 2,810
files across nine physical runtime packages matched the pinned inventory.
The private Node22 and shared Node24 native binaries retain their original
hashes.

The current-app integration suite passed **1,363 tests with three skipped**
in a complete isolated Node22 copy, including the nine new replay tests.
Project typecheck, strict replay TypeScript, production build and docs checks
passed. An initial default-Node24 full-suite attempt hit the previously
documented SQLite native assertion. A first Node22 copy omitted fixtures and
was also rejected; the successful complete copy and both earlier attempts
remain recorded. The live diagnostic uses its separate frozen source and
dependencies throughout.

The 210-member source archive retains every byte of its 206-member parent and
adds only the two replay modules, regression test and fixed protocol. No
unrelated working-tree changes enter the experiment.

## Evidence

- Prepared input:
  `benchmark/data/longmemeval-context-replay-input-2026-10-21.json`.
  SHA-256: `02cf0ab2fd22d6144d3c85a08bf049a2ac950242a93414eb04bdf63cb0d69fc7`.
- Input byte hashes and source identities:
  the adjacent `.provenance.json`.
- Original preparation source:
  `benchmark/data/longmemeval-context-replay-source-2026-10-21.tar.gz`.
  SHA-256: `54705cd2d080a19de24af4ba822870ae96cb1a34bd1425426ab0e43a8d5954b5`.
- Corrected CLI execution source:
  `benchmark/data/longmemeval-context-replay-source-2026-10-21-v2.tar.gz`.
  SHA-256: `6cddaf2a0fb8ed76c604c392ae478be40ad04d9f5968fc545037dd4ee97b3727`.
  Its input builder, fixed protocol and all 206 parent members are unchanged.
- Source manifest, independent implementation checks, dependency audit and
  reproduction scripts: `benchmark/data/longmemeval-context-replay-*`.

The two bounded primary coding attempts produced no implementation. The
configured fallback produced the tested modules. The first real-input
preparation was stopped while CPU-bound, before producing an input or making
model calls. That incomplete attempt and both coding logs remain preserved.
The optimized preparation completed in 33.695 seconds without model calls.

The first live launch exited before invoking the runner because macOS resolved
the absolute temporary path differently in its CLI entry check. It made no
answer or judge calls and created no score report. The corrected entry check
compares canonical paths. Its regression invokes the actual CLI through an
absolute symlink and verifies a complete 120-row offline preparation report.
The initial launch log, terminal record and original source remain preserved;
the next launch uses fresh output names.

The V2 launch is recorded in
`benchmark/data/longmemeval-context-replay-development60-launch-2026-10-21-v2.json`.
Its live report, append-only records and progress snapshot use the stem
`longmemeval-context-replay-development60-2026-10-21-v2.json`.
All live calls use the authenticated DGX router with total concurrency three.

The completed report SHA-256 is
`89b98e09ee4bafc6cfd93ff20722a5833383ac5b8077fa85410165391e76edaf`.
The independent completed audit and per-category/original-seven breakdown are
`longmemeval-context-replay-completed-audit-2026-10-21-v2.json` and
`longmemeval-context-replay-completed-score-breakdown-2026-10-21-v2.json`.
The producer exited with code zero and a complete 120-row report.

The audit found one provenance metadata defect: variable shadowing stored the
correct independent-review digest under a source-test filename in the launch
record. The auditor verified the exact intended review artifact and all three
source hashes, and documented the single mismatch without rewriting any
launch or result. The used launcher bytes and initial audit stop are retained.
The future launcher uses separate variable names; completed artifacts remain
unchanged. This defect affected provenance labeling, not model routing,
requests, answers, judging or result accounting.

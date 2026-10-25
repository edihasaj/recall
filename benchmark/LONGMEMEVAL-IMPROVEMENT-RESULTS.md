# LongMemEval improvement experiments

The application delivery bug is fixed in the current worktree. The completed
low-reasoning control improved the development cohort from 53/60 to 58/60, with
no request or format failures. The selected high-reasoning candidate scored
55/60 in development and 90/100 in prospective validation, versus 88/100 on
the same baseline IDs. The full lexical candidate scored 446/500 (89.2%),
versus 440/500 (88.0%). The completed fresh E5 candidate scored 457/500
(91.4%), with six failed calls. Abstention and preference regressions remain,
and the reported failures are not all reliably resolved. The goal remains open.

The supplemental Qwen successor scored 57/60 with zero request errors and six
of seven original cases correct. The subsequent Azure-answer trial scored
54/60 with one timeout and four original cases correct. Both failed the fixed
development gates; neither advanced. A separately specified
[saved-context diagnostic](LONGMEMEVAL-CONTEXT-REPLAY-PROTOCOL.md) completed
with the answerer and judge held fixed: **58/60 for Recall's context and 56/60
for Hindsight's**, zero errors and five of seven original cases correct on
both sides. Its [audited results](LONGMEMEVAL-CONTEXT-REPLAY-RESULTS.md)
cannot promote either rejected candidate or establish a full-system ranking.

The subsequent [paired inference trial](LONGMEMEVAL-INFERENCE-COMPARISON-RESULTS.md)
scored **59/60 and all seven original cases correct in both arms**, with zero
errors and no paired gains or losses. Comparison used approximately three
times the tokens. Its locked seventeen-case source review found more
unsupported/contradicted claims and affected answers, with unresolved findings
also preventing grounding passage. The treatment does not advance; neither
the control nor any earlier rejected configuration is promoted by this trial.

The [minimal sufficient answer-policy trial](LONGMEMEVAL-MINIMAL-ANSWER-PROTOCOL.md)
scored **59/60 with all seven original cases correct**, versus 58/60 for its
fresh control. The difference is one control answer timeout on `0a995998`;
both arms missed `gpt4_59c863d7`. The policy observed 2,293,525 total tokens
across 120 calls, versus 2,241,947 across the control's 119 completed calls,
so the required token reduction fails. The
decision record
rejects the policy without a grounding review, because no grounding outcome
could satisfy the failed resource requirement.

The same configuration then ran through the ordinary benchmark gates as a
[separately declared candidate](LONGMEMEVAL-MINIMAL-SUPPLEMENTAL-GATES-PROTOCOL.md),
with its development selection disclosed. Fresh development60 scored
**58/60 with all seven original cases correct** and zero errors, passing
gate 1. The locked follow-up100 scored **94/100 but 12/16 unanswerable**,
failing gate 2's 14/16 requirement; full500 did not start. Three of the four
unanswerable misses answered a nearby question instead of rejecting a false
premise, the same pattern as the 457/500 run's abstention losses.

A development-only premise check (`--answer-policy premise` or
`minimal-premise`, policy in `benchmark/longmemeval-premise-policy.ts`) then
targeted that pattern. On 14 synthetic false-premise probes built from
development questions it scored 14/14 (first wording) and 13/14 (revised
wording), against 12/14 for the minimal control. It also hurt answerable
questions: development60 fell to 57/60 and then 53/60, missing two and then
four of the original seven. Both versions refused `dd2973ad`, whose date is
ambiguous, and the revised one narrowed count answers. Neither passes gate 1,
so no locked stage ran. The
decision record
keeps both runs. Adding instructions to the single answer call does not fix
false-premise abstention without costing answerable accuracy.

A separate low-reasoning premise check after the answer
(`--answer-check premise`, `benchmark/longmemeval-premise-check.ts`) leaves
the answer prompt unchanged and replaces an answer only on an explicit
"subject not recorded" verdict. In development its fourth wording caught
14/14 synthetic and 14/14 real validation100 unanswerable questions, with
no overrides on development60 and one wrong override among 86 answerable
validation questions. Under the
[locked gates](LONGMEMEVAL-PREMISE-CHECK-GATES-PROTOCOL.md) fresh
development60 scored **57/60** with all seven original cases and zero
overrides, failing gate 1 by one answer-side miss: a low-reasoning answer
exhausted its output budget. No locked follow-up or full run started.

Adding a fixed lower-effort retry for timed-out or unfinished answers
([protocol](LONGMEMEVAL-ANSWER-RECOVERY-GATES-PROTOCOL.md)) also scored
**57/60** on fresh development60. The retry never fired and the check made no
overrides; original-seven `3a704032` missed on an ordinary count answer.
Across six fresh development60 runs on this answer path the score ranged from
53 to 58, and different original-seven cases failed from run to run. Gate 1
now mostly measures run-to-run variation in the answer model.

Three-sample voting ([protocol](LONGMEMEVAL-ANSWER-VOTING-GATES-PROTOCOL.md))
removed that variation for the counting and date cases: the vote rescued four
original-seven questions that had missed in earlier runs. Development60 still
scored **57/60**, because the remaining misses are shared by every sample: the
disputed model-kit count and two preference questions (`32260d93`,
`caf03d32`) where the model recommends several categories and the reference
expects one.

A first diagnosis of the remaining misses
blamed judge variation. That was wrong. Re-scoring every saved development60
answer from four runs five times with the unchanged judge
(correction)
shows the judge is mostly consistent. The `32260d93` answer from the
minimal-supplemental run scores 5/5; the premise-check and voting answers
score 0/5, and the recovery answer 1/5. Two recorded verdicts were therefore
favorable draws. Given each run's saved answers, the chance of passing gate 1
is 1.0 for the minimal-supplemental run and 0 for the three later runs. The
answers themselves change from run to run, and that decides gate 1. The four
preference answers that say no negative preference is established average a
0.5 re-score rate, against 0.92 for the other 36; four answers are too few to
establish a cause. No recorded result, gate or decision was changed.

Removing that negative-preference line
([`minimal-v2` protocol](LONGMEMEVAL-MINIMAL-V2-GATES-PROTOCOL.md)) did not
help. Development60 missed two original-seven cases within its first 28
questions (`0a995998` and `32260d93`, each shared by all three samples), so
the run was stopped and no locked stage started.

The maintainer then chose to stop using development60 as a gate and to run full500 once
with the premise check and answer recovery, without voting. The
[full500 protocol](LONGMEMEVAL-FULL500-PREMISE-RECOVERY-PROTOCOL.md) was
written before the run and fixes a separate adjusted score for the disputed
model-kit question. It scored **454/500 raw** (adjusted score identical),
with **29/30 unanswerable** and **27/30 preferences**, both above target and
well above the 457 run's 24/30 and 22/30. The total missed 457 because 16
consecutive calls failed during a model-server outage and are counted wrong;
on the other 484 questions the run scored 93.8%. Two original-seven cases
(`0a995998`, `32260d93`) missed. See the
[protocol results](LONGMEMEVAL-FULL500-PREMISE-RECOVERY-PROTOCOL.md#results).

A second full500 run of the same configuration, adding a retry for calls
that fail before reaching the model
([protocol](LONGMEMEVAL-FULL500-TRANSPORT-RETRY-PROTOCOL.md)), scored
**464/500 (92.8%)** with zero errors, **27/30 unanswerable** and **26/30
preferences**, meeting those three full-corpus targets. The original-seven
target failed at 4/7 (`0a995998`, `6d550036`, `dd2973ad` missed).

A third run changed only the timeout retry: a timed-out answer is retried
once at the same reasoning effort with a 1,200-second deadline instead of
dropping effort ([protocol](LONGMEMEVAL-FULL500-LONGER-TIMEOUT-PROTOCOL.md)).
It scored **472/500 (94.4%)** with zero errors, **28/30 unanswerable**,
**28/30 preferences** and **all seven original cases**, meeting every
full-corpus target. Three near-identical runs scored 454, 464 and 472, so
run-to-run variation is large; this is a single run on repeatedly evaluated
public data, and Hindsight's 473/500 uses different models.

Two subsequent experiments did not qualify for advancement. The
[paired answer-effort pilot](LONGMEMEVAL-EFFORT-PILOT-PROTOCOL.md) ran fresh
answers on 24 hash-selected questions that had used low reasoning. Control
scored **21/24**, and high reasoning **22/24**, with two gains and one loss.
The net gain of one missed the predeclared threshold of two. Source review
found one directly supported temporal correction and ambiguity in the other;
the judged preference loss also carries source-versus-judge caveats.

The [abstention-recovery replay](LONGMEMEVAL-ABSTENTION-RECOVERY-PROTOCOL.md)
refreshed two keyword sources and reviewed all 29 historical negative-premise
cases. It scored **474/500 (94.8%) as a mixed saved-answer replay**, with
471 historical answers reused, four gains and two lost abstentions. It failed
both the 476 threshold and the no-abstention-loss gate. Some gains merely
restored earlier qualified drafts; the losses supplied related-employer/role
answers after acknowledging that the asked-about premise was unsupported.
All fixed verdicts remain unchanged. Neither experiment changes the public
fresh-run result of **472/500 (94.4%)**.



Hindsight's published 94.6% remains a reference result. The
[validity review](LONGMEMEVAL-VALIDITY-REVIEW.md) also records original source
IDs in its saved contexts and generated reasoning. Their effect on accuracy
is unmeasured; neither matched label visibility nor a system ranking is
established.

## Completed development runs

These seven questions are the original failures from the blinded E5 diagnostic.
They are development cases selected by failure, not a representative sample
or a new holdout. Every case remains in the denominator.

| Configuration | Correct / 7 | Request or format failures |
| --- | ---: | ---: |
| Original blinded E5 diagnostic, failed cases only | 0 | 2 |
| Original prefix evidence, robust requests | 3 | 0 |
| Focused evidence v1, robust requests | 3 | 0 |
| Speaker-aware evidence v2, robust requests | 5 | 0 |
| Initial fixed checker v3 | 2 | 0 |
| Corrected fixed checker v5 | 4 | 0 |
| Focused evidence, low answer reasoning | 6 | 0 |
| Original prefix evidence, low answer reasoning | 4 | 0 |
| Highlights plus original evidence, low answer reasoning | 4 | 0 |
| Highlights plus History caller contract, low answer reasoning | 5 | 0 |
| Reviewed History contract, high answer reasoning | **7** | **0** |

The two new runs answered different cases correctly. Focused v1 improved
preference grading compared with the request control but regressed a plant
count. Neither result resolves all the original failures.

The request control completed with strict JSON output and the native HTTP
transport. This is seven observations, not a guarantee of reliability on the
full benchmark. Its archive and per-case records retain the exact configuration.

The focused v1 run exposed two remaining mechanisms:

- Repeated assistant suggestions crowded out direct user statements during
  evidence selection. An explicit current relocation was shown, but the answer
  still selected the older city repeated in assistant recommendations.
- Counting answers inferred unsupported relationships, such as treating
  planning or working on a project as evidence of leading it.

Version 2 tested speaker-aware ranking, informative query terms and explicit
evidence-use guidance for status, updates and distinct counted objects. It
does not encode benchmark IDs, answers, reference values or category labels.
The 100-question prospective validation cohort remains fixed.

Version 2 recovered the preference, temporal, knowledge-update, plant-count
and bedtime cases. It still failed the clothing-object count and project
leadership count. The model merged distinct objects using assumptions about
how an exchange normally works, and treated planning a project as evidence
of leading it despite the explicit status guidance.

The next candidate adds one fixed grounding check for every successfully
drafted answer. The checker receives only the question, reference clock,
same source evidence and draft. It has no reference answer, gold session
labels or judge verdict. Both calls and the final answer are retained;
failed checks count as failures. This is an additional benchmark answering
stage, not automatic behavior of agents connected to Recall.

Review found a clock mismatch in the first frozen check-stage canary:
the draft used AMB's normalized question clock, while the check received the
raw corpus date with its weekday time. That run remains a development
diagnostic with a protocol deviation. Subsequent code extracts the exact
already-prepared generation clock for the check, and all 500 prompt clocks
were audited. The running snapshot is preserved rather than changed in place.

That completed v3 diagnostic scored 2/7 and also omitted the original answering
contract from the checker. It regressed recommendation handling, current-state
selection and a temporal answer. A v4 canary was stopped as a whole after three
records when that missing-contract issue was identified; it has no final score.
Both artifacts and stop provenance remain available.

The corrected v5 stage inherits the exact pinned answer guidelines and normalized
clock, then audits a draft against the same evidence. It is running on the seven
development failures. In parallel, the direct-answer configuration using the
improved renderer and robust requests is running on all 60 development IDs.
The 100-question validation has not been used to tune either candidate.

The full direct-answer development run completed at **52/60**, compared with
the original **53/60**, with zero request/format failures. It gained two cases
and lost three. Its scorer-only coverage audit found 99/113 marked answer turns
fully shown, compared with 112/113 in the original context. Answer flags were
not inputs to selection. This fails the acceptance gate and identifies
information loss from the 4,000-character source cap.

The next representation keeps full original conversation evidence within the
original context budget and adds bounded verbatim highlights as a reading
index. Highlights do not replace the original evidence. Separately, a declared
reasoning-mode control tests the existing Qwen model's answer reasoning at
`low` with an 8,192-token output limit. Judge reasoning stays `none` with the
original 4,096-token limit. The first control implementation was stopped
before score use because it would also have changed judge settings.

## Application and implementation verification

A failing-before application test showed that the original compiler retrieved
the correct history summary but delivered only unrelated leading lines. The
query-aware renderer now delivers relevant complete source units, their record
date and required role or scope context. It reports omitted summaries without
recording them as delivered injections.

Independent review found and corrected negation loss, dropped scope headings,
missing nested scope, misleading empty injection records, and excessive
rescanning. The v1 implementation passed 1,226 tests with three skipped,
project typecheck, build and docs checks. Subsequent v2 changes require their
own final gates.

The frozen v1 prompt audit rendered all 500 questions and found zero original
source-ID leaks, zero budget violations and no all-evidence-omitted question.
Mean rendered context was 37,384 characters. That is a representation
measurement, not an accuracy score.

## Evidence

- [Protocol and acceptance requirements](LONGMEMEVAL-IMPROVEMENT-PROTOCOL.md).
- [Application evidence-rendering semantics](../docs/history-evidence.md).
- Request control: `benchmark/data/longmemeval-request-control-development7-2026-10-19.json`.
- Focused v1: `benchmark/data/longmemeval-focused-v1-development7-2026-10-19.json`.
- Prompt audit: `benchmark/data/longmemeval-focused-v1-blinding-audit-2026-10-19.json`.
- v1 source archive: `benchmark/data/longmemeval-focused-v1-source-2026-10-19.tar.gz`.
- Validation manifest: `benchmark/data/longmemeval-improvement-validation-manifest-2026-10-19.json`.

The original 500-question keyword baseline completed with 440/500 correct
(88.0%), including 14 request or incomplete-output failures. Its unanswerable
score was 23/30 and its multi-session score was 100/133. Completed development
results do not replace that baseline or establish candidate performance on
the full corpus.

## Selected candidate

The reviewed History contract with preserved original evidence, robust requests
and Qwen answer reasoning `high` passed all seven original failures in fresh
calls. Answer output was capped at 16,384 tokens; judge reasoning remained
`none` with a 4,096-token cap. The clothing answer explicitly stated the two
supported interpretations instead of asserting uncertain return completion.
The leadership answer distinguished explicit role evidence from solo work.

This is a combined application delivery, instruction-contract, transport and
answer-model configuration change. It is not a pure retrieval gain. The seven
answer calls reported 244,871 total tokens; judge usage is recorded separately.
The candidate manifest fixed the configuration before prospective validation.
Development, validation, full lexical and fresh E5 answer runs have completed.
The E5 run used exact source occurrence rankings.

## Broader development checks, 20 October

| Configuration | Correct / 60 | Request or format failures | Status |
| --- | ---: | ---: | --- |
| Original blinded E5 diagnostic | 53 | 2 | Complete |
| Clipped focused evidence | 52 | 0 | Complete; rejected |
| Preserved evidence and History contract, low reasoning | **58** | **0** | Complete |
| Selected high reasoning, fresh restart | **55** | **3** | Complete; development gate passed |

The low-reasoning control used an 8,192-token answer limit and recovered five
of the seven original failures. Both remaining errors combine facts across
sessions. These 60 questions were used for development and contain no
unanswerable cases, so 58/60 is not a full-corpus or prospective-validation score.
Recorded answer-plus-judge usage increased from 1,764,110 to 1,940,233 tokens.
The baseline has one call with unknown usage. Wall time increased from 1,905
to 3,670 seconds, but the runs used different concurrency and shared capacity;
these timings do not isolate the reasoning mode's effect.

The first high-reasoning development run stopped during a disk shortage.
Its append-only stream preserves 36 records, including one answer timeout.
It has no completed score and is excluded from accuracy comparisons. A fresh
run restarts all 60 questions with the same frozen source and inference
configuration, using three workers. The interrupted artifacts remain intact.

That restart completed at **55/60**: six original failures recovered and four
previously correct cases lost. Three losses were request or incomplete-output
failures. The high configuration passes its predeclared minimum of 53 correct,
but it has lower development accuracy than the low-reasoning control. The
prospective comparison measured the frozen high candidate without tuning on
validation outcomes; this selection is not a claim that high reasoning is the
best overall configuration.

A fresh 500-question E5 retrieval run was also started. Its rankings retain
exact source occurrence positions and fingerprints over the question and all
ordered source IDs, dates and text. The answer harness verifies those
fingerprints before model calls. Source, package and effective retrieval
configuration hashes accompany checkpoints and the final report.

The restarted high-reasoning run has reproduced an original counting failure:
the clothing answer assumes the old pair's return already completed. Its
evidence text and answer-prompt hash match the earlier successful development
call, and the recorded code hashes match too. Concurrency changed from two to
three. This demonstrates outcome variation under the recorded setup; the prior
7/7 result does not establish that all seven failures are reliably resolved.
The completed run contains one output-budget exhaustion and two request
timeouts. All three remain incorrect in its 60-question denominator.

## Completed prospective validation

The fixed 100 questions are disjoint from the 60 development cases. They come
from the same public corpus, which has been used in earlier experiments, so
this is not an unseen external holdout. No validation answer was used to
change this frozen candidate.

| Measure | Original baseline, same 100 IDs | Frozen high candidate |
| --- | ---: | ---: |
| Correct / all selected | 88/100 | **90/100** |
| Unanswerable correct | 12/14 | **13/14** |
| Request or incomplete-output failures | 3 | 3 |
| Observed answer-plus-judge tokens | 2,841,911 | 3,130,880 |
| Calls with unknown usage | 3 | 3 |

Four cases improved and two regressed. The candidate improved knowledge-update,
multi-session and temporal categories by one correct answer each, while
preferences lost one. The result passes the predeclared advancement gates;
a two-question net gain does not establish a broad or statistically reliable
accuracy improvement. All three candidate failures were answer timeouts.

The candidate completed in 4,824 seconds. Shared capacity and inference changes
prevent a matched latency claim. The full 500-question lexical candidate run
started automatically after source, identity, configuration and score checks.
The separate E5 retrieval and subsequent answer runs have since completed,
as reported below.

The complete paired comparison is
`benchmark/data/longmemeval-history-contract-high-validation100-comparison-2026-10-20.json`.

## Completed fresh full-corpus E5 retrieval

The fresh E5-small run completed all 500 questions in 17,098 seconds.
Relevant-session hit rates were **97.4% at top 5**, **99.4% at top 10** and
**99.6% at top 20**; nDCG@10 was 90.06% and MRR was 89.54%. The run included
all 30 unanswerable IDs. On the 470 answerable questions, top-10 hit rate was
99.36%. These measure finding at least one relevant session, not complete
answer evidence or final answer accuracy.

All 500 question/source fingerprints match the prepared answer corpus, and
all exact occurrence mappings validate. An offline render audit made zero
model calls, found a maximum context size of 179,836 characters against the
180,000 limit, and reported truncation on two questions. The complete ranking,
integrity and context audit artifacts are retained in `benchmark/data/`.

The optional single-run document cache recorded 5,403 hits and 18,464 misses.
It reused identical document embeddings and left query embeddings independent.
The corresponding completed E5 answer result is reported below.

An independent offline audit compared delivered evidence for all 470 answerable
questions. Raw `has_answer` flags entered scoring only after every E5 retrieval
and render had finished; the audit made no model calls.

| Marked-turn coverage | Original lexical prefix | Fresh E5 with highlights |
| --- | ---: | ---: |
| Fully visible marked turns | 838/886 | 867/886 |
| Questions with every marked turn fully visible | 431/470 | 452/470 |
| Marked turns absent because their session was not retrieved | 48 | 19 |
| Retrieved marked turns partly visible or omitted | 0 | 0 |

The additional coverage comes from different retrieved source occurrences.
This audit does not demonstrate a highlighting benefit, prove that unmarked
context is unnecessary, or establish answer accuracy. All 22,419 original
answerable session texts matched their prepared role/content representation;
coverage used unions of exact UTF-16 source ranges. The 30 unanswerable cases
were excluded from answer-support coverage. Session-ID relevance annotations
are a separate proxy: all relevant IDs were retrieved for 424 baseline and
445 E5 questions.

The evidence, reproduction script and original audit manifest are preserved as
`longmemeval-marked-turn-coverage-2026-10-20.json`,
`longmemeval-marked-turn-coverage-audit-2026-10-20.mjs` and
`longmemeval-marked-turn-coverage-manifest-2026-10-20.json` in `benchmark/data`.
The original manifest retains its temporary filenames and reproduction command.

## Completed full lexical answer run

| Measure | Original baseline | Frozen high candidate |
| --- | ---: | ---: |
| Correct / all selected | 440/500 (88.0%) | **446/500 (89.2%)** |
| Unanswerable correct | 23/30 | **27/30** |
| Multi-session correct | 100/133 | **110/133** |
| Preference correct | **25/30** | 19/30 |
| Request or incomplete-output failures | 14 | **9** |
| Observed answer-plus-judge tokens | 14,142,944 | 16,112,460 |
| Calls with unknown usage | 14 | 3 |

Eighteen cases improved and twelve regressed. Six candidate failures exhausted
the 16,384-token output budget; three timed out. This configuration improves
the observed full score by six questions, but the preference regression is
material and a broad improvement is not established. Successfully judged
accuracy changed only from 90.53% to 90.84%. The token totals exclude unknown
usage, which differs between runs, and are not a complete cost comparison.

The candidate completed in 16,689 seconds versus approximately 12,459 seconds
for the baseline. Shared inference capacity prevents a matched latency claim.
The same 100 validation IDs scored 88/100 when repeated within this full run,
compared with 90/100 in the earlier validation run. Evidence and answer-prompt
hashes match on all 100 repeated cases; four verdicts changed as generated
answers changed. No identical final answer received a different verdict.

Five of the seven original development failures passed in the lexical full
run. The bedtime and current-location questions still failed. This retrieval
arm differs from their original E5 diagnostic, so it does not isolate reasoning
or evidence delivery. The complete paired comparison, original-case outcomes
and repeat-input audit are retained in `benchmark/data/`.

The run passed the predeclared score and unanswerable advancement gates.
The supervisor then started the fresh E5 answer run without changing the
candidate. Hindsight's published 473/500 (94.6%) remains higher than this
lexical result and uses different answer and judge models; these are not
matched system scores.

## Completed fresh E5 answer run

| Measure | Original lexical baseline | Frozen high lexical | Frozen high E5 |
| --- | ---: | ---: | ---: |
| Correct / all selected | 440/500 (88.0%) | 446/500 (89.2%) | **457/500 (91.4%)** |
| Unanswerable correct | 23/30 | **27/30** | 24/30 |
| Multi-session correct | 100/133 | 110/133 | **113/133** |
| Preference correct | **25/30** | 19/30 | 22/30 |
| Request or incomplete-output failures | 14 | 9 | **6** |

The E5 candidate gained 30 answers and lost 13 compared with the original
baseline; it gained 23 and lost 12 compared with the frozen high lexical run.
Four failures were answer timeouts and two exhausted the output budget.
Six of the seven original development failures passed; `32260d93` still failed.
The abstention and preference results remain below the required follow-up
targets, so this is not a resolution of all reported issues.

Successfully judged accuracy was 92.51%, versus 90.53% baseline and 90.84%
high lexical. Observed answer-plus-judge usage was 16,450,485 tokens, with
four calls missing usage. The run took 16,881.751 seconds. Missing usage,
different contexts and shared inference capacity prevent a complete cost
comparison or matched latency claim.

Independent offline review verified all 500 question identities, exact source
occurrences, fingerprints, rendered evidence and answer-prompt hashes.
JSONL records matched the final report by recorded index. All 494 successful
answers, judge prompts and parsed verdicts matched; all six failed answers
remained incorrect without judge calls. Frozen source, package, retrieval and
restored-asset provenance also matched. The frozen code predates per-call
request-configuration logging, so native high/16,384 answer settings and
none/4,096 judge settings were verified through pinned code and offline payload
capture, rather than historical per-call configuration logs.

The comparison is preserved in
`benchmark/data/longmemeval-history-contract-high-e5-full500-comparison-2026-10-20.json`.
The E5 and lexical high runs share their answering configuration, but generated
outcomes can vary; the comparison does not isolate an application effect.
Hindsight's published 473/500 uses different answer and judge models and
remains a reference rather than a matched system ranking.

## Frozen adaptive follow-up

The opt-in adaptive candidate is implemented and frozen, with no completed
full-cohort answer-accuracy result yet. It uses high reasoning for recognized enumeration
phrases in the original question and low reasoning otherwise. It reads no
source text, category, ID, reference answer or verdict to choose the mode.
This changes the benchmark answering configuration, not ordinary Recall
retrieval or an agent's inference settings.

All 60 development evidence texts and answer-prompt hashes match the previous
high-reasoning development run; 19 questions route high and 41 low. The
implementation passed 1,284 tests with three skipped, project and benchmark
type checks, build, documentation checks and independent review.

The separately reviewed supervisor started adaptive development after the
fixed-high E5 producer exited. It pins 17 input, ranking, source-manifest and protocol
artifacts, verifies all 500 source fingerprints, and serializes the declared
development, follow-up and full-corpus gates. Its offline fault checks cover
changed cohorts and categories, corrupted fingerprints, producer exit races,
and observation failures followed by resume. Validation made no model calls.

The review, preserved supervisor source, rerunnable offline tests and hashes
are retained in `benchmark/data/longmemeval-adaptive-supervisor-review-2026-10-20.json`
and `benchmark/data/longmemeval-adaptive-supervisor-offline-tests-2026-10-20.json`.
Its live state is separate from these validation records. Passing these
implementation checks does not establish that the candidate passes its
accuracy gates or resolves the remaining original failures.

The frozen full-corpus rule now requires at least 457/500 correct,
27/30 unanswerable, 25/30 preferences and all seven original failures correct.
These thresholds follow the predeclared maximum-control rule; they were not
relaxed after the E5 result.

The fresh adaptive development7 diagnostic completed at **7/7 with zero
errors** in 418 seconds. All seven answer prompts match the frozen development
hashes. Per-call records confirm four native high and three low answer calls
at 16,384 tokens; all seven judge calls remain none/4,096. Indexed JSONL,
question identities, invocation and frozen code/input/ranking hashes verify.
The integrity record is
`benchmark/data/longmemeval-adaptive-development7-integrity-2026-10-20.json`.
This selected diagnostic does not establish representative accuracy or
reliable resolution.

The complete adaptive development60 run scored **57/60 with zero request
errors** in 1,577.018 seconds. It passed six of the seven original cases,
with `32260d93` failing again; the other losses were `gpt4_59c863d7` and
`9a707b81`. It therefore failed both declared development gates. The supervisor
stopped with exit code 2, preserving the completed report. No adaptive
follow-up100 or full500 run started.

Independent review verified all 60 source fingerprints, original evidence and
answer-prompt parity, parsed answers, judge prompts and verdicts. Recorded
settings match the planned 19 high and 41 low answer calls, each capped at
16,384 tokens; all judges remain none/4,096. All 120 calls reported usage,
totalling 1,960,656 tokens. The audit and reproduction sources are preserved
under `longmemeval-adaptive-development60-*audit*` in `benchmark/data`.

Development-only inspection found that the three failures received the needed
evidence but introduced unsupported scope: a hypothetical technical category
doubt, broader media interests instead of a direct viewing preference, and a
current-clock alternative to a requested past-event interval. A successor
History-contract refinement is in implementation. The rejected adaptive source
and results remain unchanged; the locked follow-up has not been used to tune it.

## Scope-contract successor preparation

The successor revises three existing generic History-policy lines: ordinary
category membership, preference constraints and relative-time anchors.
Explicit repeated-mention deduplication, exact relationship/status evidence,
pending actions and genuine ambiguity remain intact. It changes no benchmark
facts, routing, source selection, templates or reference answers.

Independent review rejected the first source assembly before model calls.
It accidentally incorporated unrelated current-checkout UMP/package changes
and omitted parent migration files. Its source, full integration check,
unchanged-prompt preflight and rejection inventory remain preserved; they
cannot establish a policy-only comparison.

The rebuilt controlled bundle retains all 191 frozen adaptive-parent members,
changes only `src/history/evidence-policy.ts`, and adds two documentation files
and the successor protocol. Current-app integration separately passed 1,284
tests with three skipped, type checks, build and docs. The controlled QA
snapshot passed 89 relevant History/MCP/QA tests, strict QA type checking and
the all-60 unchanged-source/evidence/user-prompt preflight. Offline request
capture isolates the new answer system policy; judge payloads are unchanged.

The legacy parent declares UMP 1.0.2 while its UMP source requires newer APIs.
Its shared dependency directory resolves 1.0.4. An independently reproduced
18-module QA runtime graph imports no UMP code. The controlled experiment
therefore pins its effective dependency files explicitly and keeps its checks
separate from whole-app integration. Parent dependency/type-check failures
remain preserved; historical installed dependency bytes were not fully frozen.
No legacy whole-app gate is claimed to pass.

The protocol is [LongMemEval scope-contract follow-up](LONGMEMEVAL-SCOPE-CONTRACT-PROTOCOL.md).
All numerical gates remain unchanged: development 58/60 plus all seven original
cases, locked follow-up 93/100 and 14/16 unanswerable, then exact-E5 full500 at
457/500, 27/30 unanswerable, 25/30 preferences and all seven original cases.
Independent freeze review cleared the rebuilt bundle, including all 194 archive
members, all pinned QA dependency files, unchanged prompts and isolated system
policy changes. Its complete development60 run then scored **56/60 with zero
request errors**, passing four of the seven original cases. It failed both
development gates and did not advance.

Independent audit verified all 60 result identities, indexed JSONL records,
source and prompt hashes, verdicts, settings and pinned dependencies. Compared
with the rejected adaptive parent it gained one answer and lost two. Observed
usage was 1,956,270 tokens with no unknown usage; runtime was 1,672.438 seconds.
All failed results and source bundles remain preserved. The unsuccessful policy
revision was removed from the application, restoring the accepted contract
byte for byte.

## Pre-answer ledger proposal

Repeated policy refinements have not passed the complete development gate.
The next candidate adds a fixed gold-blind extraction stage before answering,
with the accepted History contract unchanged. The extractor selects neutral
references to complete visible source units. Code validates those references
and materializes verbatim quotations, ranges, attribution and record dates.
Model-generated entity, relationship and status annotations remain unverified.

The answer keeps the full original evidence alongside the bounded ledger.
Invalid extraction fails the case rather than being repaired or silently
filtered. All extractor usage and failures must remain visible. This is a
benchmark answering configuration, not automatic production memory behavior.
It is implemented and has no measured accuracy result.

Independent implementation review verified strict source-unit provenance,
fixed stage settings, failure/usage accounting and 40 disabled native-payload
comparisons against the frozen parent. The fresh current-app integration gate
passed 1,293 tests with three skipped, type checks, build and documentation
checks. The controlled QA snapshot passed 98 History/MCP/QA tests and strict
type checking.

The source bundle retains all 191 adaptive-parent members. Three parent
benchmark files change (QA, model-call support and summary accounting); the
ledger module, protocol and test are added. All application runtime source,
including the accepted History policy and migrations, remains identical to
that parent. Offline preflight verified all 60 source fingerprints, original
evidence and base user prompts, plus 6,851 complete visible units. Independent
freeze review cleared the source, dependencies, gates and fixed per-stage
settings. The complete ledger development60 run scored **29/60**, with
31 extraction-validation failures. All selected cases remain in the
denominator, so the trial is rejected and did not advance.

The 29 cases that reached answering were all judged correct. This is a selected
diagnostic subgroup, not an answer-accuracy estimate or a usable pipeline
score. The full run made 60 extractor, 29 answer and 29 judge calls, reporting
3,067,727 tokens with no unknown usage in 2,234.170 seconds.

Full independent audit confirmed that all 31 failures concern event-time
binding, not schema or source references: 26 cases copy the selected source's
observation date, four use a phrase from another unit, and one supplies a phrase
absent from visible quotes. The validator correctly rejected those outputs
without answer or judge calls. All 60 extractor prompts, 29 reconstructed
ledgers, final answers and verdicts, indexed JSONL records, frozen source and
pinned dependencies verify. No output was repaired or selectively retried,
and no follow-up or full-corpus ledger run started.

The [ledger protocol](LONGMEMEVAL-LEDGER-PROTOCOL.md) fixes schema, budgets and
the same development, locked-follow-up and full-corpus gates before calls.
Further adaptive development cannot establish broad generalization without
separate validation.

## Unit-only successor

The next distinct mode, `--evidence-ledger units`, removes model-generated
entity, relationship, status and time annotations. The extractor selects only
neutral unit references; code supplies exact quotations, ranges, attribution
and record dates. This eliminates the unsupported annotation field rather
than accepting observation dates as event times.

The [unit-index protocol](LONGMEMEVAL-UNIT-INDEX-PROTOCOL.md) preserves strict
reference/visibility/size validation, full original evidence, fixed stage
budgets and all numerical gates. The failed quoted mode and results remain
unchanged. This successor is implemented with no measured score;
selection validity alone cannot establish relevance, completeness or accuracy.

Independent implementation review cleared strict reference-only selection,
duplicate/empty handling, source visibility, raw-evidence retention and native
payload isolation. The fresh current-app gate passed 1,296 tests with three
skipped, type checks, build and documentation checks. The controlled QA
snapshot passed 101 relevant tests and strict type checking. Offline preflight
verified all 60 unchanged evidence/base user prompts and 6,851 visible units.
Independent freeze review cleared the bundle, dependencies, all-60 preflight
and fixed per-stage settings. The full units-only development60 run scored
**57/60**, with six original cases correct and one oversized index. It failed
both gates and did not advance.

Independent audit confirmed all source, prompt, verdict, dependency and indexed
JSONL identities. All 60 selections were valid references. One rendered index
was 21,706 characters against the 18,000 cap and correctly failed before
answering. The two other losses were conditional counting answers. The run made
178 calls with no retries and reported 4,035,861 tokens, all usage known, in
3,452.081 seconds. No units-only locked follow-up or full-corpus run started.

## Packed-index and standalone-answer proposal

The next [combined protocol](LONGMEMEVAL-PACKED-INDEX-PROTOCOL.md) adds a distinct
packed mode. It validates every reference before stable whole-unit budget
allocation, records valid omissions and retains all raw evidence. Separate
benchmark-only answer-system guidance requires essential results and support
in the delivered answer field while preserving genuine ambiguity.

This changes two mechanisms and cannot isolate either one's effect. It must
not force an expected count, discard a contrary update or weaken source
validation. All accuracy gates, original task requirements, reference answers
and judging remain unchanged. Implementation and offline review precede any
new model calls.

Independent implementation review cleared whole-unit packing, omission
accounting, packed-only answer guidance and prior-mode native compatibility.
The exact strict benchmark typecheck initially found a narrowing error; the
typed-reference fix passed that check before freeze. Fresh current-app
integration passed 1,299 tests with three skipped, type checks, build and docs.
Controlled QA passed 104 tests and strict type checking.

The 196-member bundle retains every parent member and changes only the named
benchmark implementation/accounting files. Offline preflight verified all 60
unchanged source/evidence/base prompts and 6,851 visible units. Synthetic
model-free packing checks verified rendered caps and omission accounting
without transforming earlier model outputs. Independent freeze review cleared
the source, dependencies, provenance and fixed settings. The complete packed
development60 run scored **57/60 with zero request errors**, passing five of
the seven original cases. It failed both development gates. No packed
locked-follow-up or full-corpus stage started.

Independent offline audit reconstructed all 60 source fingerprints, evidence
views, extractor prompts, packed indexes, answer prompts and judge verdicts.
It verified the frozen source, pinned dependencies and indexed JSONL. All
180 calls completed on their first attempt with known usage, totaling
4,111,627 tokens in 3,347.514 seconds. Audit scripts, evidence and the rejection
record are retained under `longmemeval-packed-development60-*` in
`benchmark/data`. Historical system wire payloads were not saved; system
guidance is verified through frozen source and recorded guidance hashes.

The three judged losses were a conditional clothing count, a broad preference
answer and rejection of a later explicit mortgage correction. Packing omitted
two units in one case and one in another, with original evidence retained.
The separate [validity review](LONGMEMEVAL-VALIDITY-REVIEW.md) preserves an
upstream owner-acknowledged reference error, a locally diagnosed count
ambiguity and evaluator-contract differences. It changes no recorded scores,
references or gates.

## Completed supplemental trial

The later [supplemental trial](LONGMEMEVAL-DEPTH-DIAGNOSIS.md) improved offline
marked-turn coverage from 285/300 to 293/300 without losing original evidence.
Its fresh development answer run nevertheless scored **57/60 with zero errors
and six of seven original cases correct**. It failed both unchanged gates and
did not advance. Independent audit verified all 60 evidence/prompt hashes,
verdicts, settings, indexed records and pinned source/dependencies. Usage was
2,278,473 tokens across 120 first-attempt calls, all known, over 2,065.367
seconds. This is no answer-accuracy gain over the frozen adaptive control.

## Completed Azure answer-model trial

The [Azure protocol](LONGMEMEVAL-AZURE-ANSWER-PROTOCOL.md) changed only the
answering configuration, preserving supplemental evidence, answer task,
History contract, reference answers and Qwen judge. Azure GPT-5.6 Sol used
medium reasoning, 16,384 output tokens and provider-default sampling.
Independent source freeze, native-payload/prompt checks and implementation
gates passed before serial calls.

The full development trial scored **54/60 with one answer timeout and four
of seven original cases correct**. It failed both gates and did not advance.
The model-kit count and mortgage-update answers improved compared with the
57/60 supplemental Qwen control, while five other cases regressed. This is a
changed answer-model configuration, not an application accuracy gain.

Independent audit verified all sixty evidence and answer-prompt hashes,
59 judge hashes and verdicts, actual model settings, indexed JSONL and pinned
source/dependency files. The 119 calls made 171 HTTP attempts; 52 Azure answers
retried transient HTTP failures. Observed usage was 2,061,808 tokens, with
one timeout call unknown, in 1,906.890 seconds. The missing usage and provider
throttling prevent a complete cost or matched latency claim. All failed
outputs and the rejection record are preserved under
`longmemeval-azure-answer-development60-*` in `benchmark/data`.

## Temporary snapshot restoration

After retrieval completed, integrity checks found missing source files in the
temporary snapshots. Existing files still matched their pre-run archives.
Only missing files were restored from the pinned archives, and every archived
file was then checked byte for byte. Task-file timestamps were refreshed.
The cause of disappearance was not established.

The candidate archive's filter had also excluded `src/data` along with
`benchmark/data`. Two required runtime assets were restored from the pre-run
E5 archive; independent review confirmed that their bytes also match the older
reviewed development archive. The original archives remain unchanged. A
complete reconstructed bundle and its parent hashes disclose this packaging
correction; that bundle was assembled after validation from pre-run bytes.

All 500 lexical answer prompts were recomputed after restoration and matched
the hashes saved before validation. This audit made zero model calls.
Generator code, policy, model settings, recorded requests and outcomes were
not changed. The retrieval report's source manifest covers TypeScript files;
the static synonym JSON is covered by the archive and supplemental asset
manifest, rather than that original TypeScript-only manifest.

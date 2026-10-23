# Larger public-conversation evaluation: 18 October 2026

Keep the temporal v2 adapter experimental. The completed 434-question comparison
found **no semantic accuracy gain** over its shared raw-evidence control.
The full-budget raw-history control scored higher.

The [protocol](TEMPORAL-REAL-PROTOCOL.md) was recorded before inference.
The candidate, prompts, scoring, data selection and runtime were frozen.
An independent reviewer reconstructed every primary score and the paired
analysis from the saved outputs without changing any scores.

## Comparison and scope

The study selected 434 additional LongMemEval-S question IDs after excluding
the 66 IDs in the earlier retrieval and public-answer artifacts. It contains
410 answerable questions across all six categories and 24 unanswerable cases.
The underlying public corpus has prior exposure; these are additional local
question IDs rather than newly collected conversations.

Fresh Recall lexical retrieval selected ten sessions per question, with
embeddings, reranking and HyDE disabled. Future-dated sources were excluded
before retrieval. Ten cases contained repeated source IDs with differing dates;
all occurrences of those IDs were excluded while the questions remained.
There were 1,470 future-source exclusions after duplicate removal.
Dataset timestamps lack timezone metadata; the existing date helper interprets
them as UTC.

| Arm | Maximum evidence |
| --- | --- |
| Shared raw | Retrieved session snippets within 20,000 characters. |
| Temporal v2 | The complete shared block plus up to 4,000 characters of assertions. |
| Full raw | The same retrieved sessions within 24,000 characters. |

Capture processed only the shared snippets in observation-time order, without
the question, reference answer or gold keys. Selection of those snippets was
question-conditioned. The adapter used its actual frozen prompts and catalogs,
with an open predicate schema. Identical evidence reused the exact same answer
result; that reuse was recorded and charged once.

All inference used `qwen3.8-flash-next`, reasoning disabled, temperature zero
and 512 output tokens, with at most six model calls concurrently. A separate
arm-blind call graded unique candidate answers semantically, including dates,
numbers and preference fit. Casing alone did not change correctness.

This evaluates an offline augmentation over lexical retrieval and truncated
session text. Full production Recall, vector retrieval, lifecycle delivery and
Recall Cloud remain outside its scope. APEX-MEM was not run.

## Semantic answer results

Every selected question remains in the denominator, including failed calls.
The table reports model-judged correctness rather than verified source
entailment or an official LongMemEval score.

| Category | Questions | Shared raw | Temporal v2 | Full raw |
| --- | ---: | ---: | ---: | ---: |
| User facts | 54 | 7/54 | 7/54 | 9/54 |
| Assistant facts | 46 | 28/46 | 28/46 | 34/46 |
| Preferences | 20 | 4/20 | 4/20 | 5/20 |
| Multiple sessions | 111 | 37/111 | 37/111 | 39/111 |
| Knowledge updates | 62 | 28/62 | 28/62 | 32/62 |
| Temporal reasoning | 117 | 38/117 | 38/117 | 40/117 |
| Unanswerable | 24 | 23/24 | 23/24 | 23/24 |
| **All cases** | **434** | **165/434 (38.0%)** | **165/434 (38.0%)** | **182/434 (41.9%)** |

Answerable-only scores were 142/410 (34.6%) for shared raw and temporal,
and 159/410 (38.8%) for full raw.

| Temporal minus control | Wins | Losses | Ties | Difference | Cluster-bootstrap 95% interval |
| --- | ---: | ---: | ---: | ---: | --- |
| Shared raw | 0 | 0 | 434 | 0.00 points | [0.00, 0.00] |
| Full raw | 6 | 23 | 405 | −3.92 points | [−6.44, −1.60] |

The bootstrap used 10,000 resamples with seed 20261018 and 409 clusters:
384 single-case clusters and 25 two-case clusters. Clusters connect shared
gold answer-session IDs transitively and corresponding abstention IDs.
This cannot eliminate every dependence in a reused public corpus.

The full raw control uses the assertion reserve for additional source text.
The candidate rarely filled that reserve. Its identical score to shared raw
and its single augmentation show that the main problem is insufficient useful
temporal participation.

## Actual temporal participation

Only **1/434 questions (0.23%)** received a nonempty temporal augmentation.
The other 433 explicitly fell back, with evidence identical to shared raw.

The successful lookup asked for the current record of the Net Ninjas
volleyball team. The adapter stored the source's `5-2` state, selected it at
the question clock and cited the original session. All three arms already
answered `5-2` correctly. It therefore added no paired accuracy gain.

Across 4,279 source snippets, 42 stored at least one assertion, producing
44 assertions in 42 question-local stores. There is no gold assertion set
that would turn these counts into an extraction-accuracy measurement.

| Capture route | Sources |
| --- | ---: |
| Ignore | 2,256 |
| Temporal proposal | 1,184 |
| Ordinary | 166 |
| Defer | 673 |

| Rejected proposal reason | Count |
| --- | ---: |
| Ungrounded new key | 1,169 |
| Ungrounded predicate | 144 |
| Unsupported clause | 95 |
| Value absent from quote | 46 |
| Missing temporal anchor | 42 |
| Quote absent from source | 15 |
| Invalid observation-based start | 11 |

An independent qualitative audit of six sampled records found mixed causes.
Literal grounding can lose first-person entities, contextual references,
abstract predicates and boolean encodings. Other proposals correctly failed
because they invented exact dates, contradicted the observation-time contract
or lost a claim's scope. These examples do not establish an aggregate
false-rejection rate.

Many temporal questions ask for elapsed time or ordering between events.
Those operations exceed this candidate's single-state lookup contract.

## Evidence and grading limits

A post-inference coverage diagnostic found a gold session among retrieved
sources for 381/410 answerable questions. At least one complete annotated
answer turn was visible in the shared snippets for 244/410.
Complete-turn matching is conservative: a partial turn may contain the answer.
No gold annotations were used to choose inference inputs.

The user-fact category illustrates the prefix-truncation limit particularly
clearly: 53/54 gold sessions were retrieved, but only 6/54 had a complete
annotated answer turn in the shared snippets. Forty-one answerable cases also
had at least one gold source dated after the question clock; that diagnostic
does not establish that every such question lacked usable earlier evidence.

Consequently, these absolute scores should not be presented as Recall's
general accuracy.

An independent semantic audit agreed with all 20 early candidate verdicts.
A later audit examined 22 control-disagreement cases containing 42 unique
candidates: 41 verdicts agreed and one remained ambiguous without source
history. Primary scores were left unchanged. These are supplemental audits,
not a replacement human-graded benchmark.

Valid answer/citation schemas occurred on 431/434 shared and temporal outputs,
and 432/434 full-raw outputs. Gold-session citation hits were 186/410 and
204/410, respectively. Citation validity and session hits do not verify every
generated claim.

## Reliability and cost

The run made **5,989 unique call attempts** and took **144.1 minutes**.

| Stage | Calls | Observed tokens | Calls with unknown usage |
| --- | ---: | ---: | ---: |
| Capture | 4,279 | 4,669,097 | 219 |
| Query parsing | 434 | 118,577 | 0 |
| Answering | 867 | 4,581,137 | 5 |
| Judging | 409 | 82,235 | 0 |
| **Total** | **5,989** | **9,451,046** | **224** |

Complete token totals and dollar cost remain unknown. A separate transport
smoke test used 34 tokens and is excluded from the formal-run totals.
The candidate's capture and query stages added 4,713 calls with at least
4,787,674 measured tokens.

There were 219 capture request failures, five answer request failures and
32 invalid capture schemas. Query and judge schemas had zero failures.
All failures remained in the results without selective retries.

Request/schema failures affected **256/5,989 calls (4.27%)** and
**178/434 cases (41.0%)**. The frozen harness applies its five-percent
reliability diagnostic to cases with any such failure. Provider timeouts
contributed materially, so this run does not isolate model capability from
service reliability.

Successful-response median capture/query/answer/judge times were
3,894/1,421/6,975/1,851 ms. These exclude failed-request duration metadata
and do not represent production end-to-end latency.

## Decision and next work

The candidate failed the required positive gain over the strongest control.
The assistant-fact category regressed by 13.04 points against full raw,
exceeding the five-point ordinary-category limit. The case-based reliability
diagnostic also failed.

Broad integration is not justified by this version. The useful next work is
better conversational evidence selection and entity/property grounding,
followed by event/date representations for elapsed-time and ordering questions.
Another comparison should preserve source history and use representative
production retrieval. Privacy, retention, individual removal, export and
Cloud round trips remain integration requirements.

## Validation and artifacts

The formal run used an isolated Node 22 source copy and its own SQLite binary.
This prevented concurrent workspace edits and native-addon rebuilds from
changing the running experiment. Initial shared-workspace checks encountered
an ABI mismatch and an unrelated incomplete CLI import; these were resolved
or isolated before formal inference.

Validation included six focused evaluator tests, strict benchmark/test
TypeScript, 15 additional hermetic behavior probes, independent source review,
and independent reconstruction of 253 published summary values.
The isolated full-suite run and rechecks of three initially missing validation
resources yielded 1,144 passing tests and three existing skips.
Repository typecheck, build, documentation checks and whitespace checks passed.

Independent verification matched all seven frozen experiment files, all
174 dependency hashes and the eleven earlier v2 frozen files. The final raw
report SHA-256 is
`35af27e2a3e7aacc579b5055d8082cdbc176c269fda31d7e4f19101def454bab`.

Artifacts are retained under the ignored `benchmark/data/` directory:

- `temporal-real-frozen-2026-10-18.json` and
  `temporal-real-source-frozen-2026-10-18.tar.gz`.
- `temporal-real-holdout-real-2026-10-18.json`.
- `temporal-real-input-coverage-2026-10-18.json`.
- `temporal-real-independent-numeric-review-2026-10-18.md`.
- `temporal-real-numeric-audit-2026-10-18.mjs`.
- The independent early, disagreement and capture audit reports.

No automatic capture, query integration, app installation or Cloud deployment
was performed.

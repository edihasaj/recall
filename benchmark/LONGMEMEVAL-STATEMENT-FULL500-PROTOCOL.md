# LongMemEval-S full500: statement evidence, 24–25 October 2026

Recall's best experimental LongMemEval-S result is **474/500 (94.8%)**. It
comes from the second of two fresh runs of the same frozen configuration; the
first scored **470/500 (94.0%)**. The two runs average 472/500 (94.4%).

| | Run 1 | Run 2 | Earlier best (23 Oct) |
| --- | ---: | ---: | ---: |
| **Overall** | **470/500** | **474/500** | 472/500 |
| Answerable | 443/470 | 447/470 | 444/470 |
| Unanswerable (abstention) | 27/30 | 27/30 | 28/30 |
| Single-session user | 70/70 | 70/70 | 69/70 |
| Single-session assistant | 53/56 | 53/56 | 56/56 |
| Single-session preference | 28/30 | 29/30 | 28/30 |
| Multi-session | 121/133 | 120/133 | 118/133 |
| Temporal reasoning | 124/133 | 127/133 | 127/133 |
| Knowledge update | 74/78 | 75/78 | 74/78 |
| Final row errors | 0 | 0 | 0 |

Category rows include the unanswerable questions that belong to each category.
The earlier best uses the [supplemental-evidence configuration](LONGMEMEVAL-FULL500-LONGER-TIMEOUT-PROTOCOL.md).

## What we tried

Every change followed the same method. We wrote its protocol and pass rules
before making any model call, compared it against a fresh control run on the
same questions, and kept every result, including failures. When a change
passed on numbers, a separate reviewer checked each changed answer against the
source conversations. We never rejudged answers or retried them because they
were wrong.

These changes moved the full 500-question score, each run with Qwen answering
and judging:

| Full run | Change | Score |
| --- | --- | ---: |
| Baseline | Keyword retrieval, raw conversation excerpts | 440/500 (88.0%) |
| 2 | Highlighted evidence, History instructions, high reasoning | 446/500 (89.2%) |
| 3 | Semantic (E5) retrieval instead of keyword search | 457/500 (91.4%) |
| 4 | Separate check that rejects questions about things never mentioned | 454/500 (90.8%)¹ |
| 5 | Retry requests that fail before reaching the model | 464/500 (92.8%) |
| 6 | Retry timed-out answers at the same reasoning effort | 472/500 (94.4%) |
| 7 and 8 | Statement-focused evidence (this page), run twice | 470 and 474/500 |

¹ Sixteen calls failed during a model-server outage and count as wrong.
Unanswerable accuracy rose to 29/30, from 24/30 in run 3.

These ideas did not help and were dropped:

| Idea | What happened |
| --- | --- |
| Extract key quotes before answering (three variants) | 29/60, 57/60 and 57/60 against a 58/60 gate |
| Write two drafts and pick the better one | 59/60 in both arms, about three times the tokens |
| Majority vote over three answers | 57/60; the remaining misses were shared by every sample |
| Tell the answer prompt to reject false premises | Hurt answerable questions (57/60, then 53/60) |
| Shorter, more focused answers | Passed development, then missed 4 of 16 unanswerable questions |
| High reasoning for every question | 22/24 against 21/24, below the gain needed |
| High reasoning for date questions | 73/74 against 69/74, but some gains were not supported by the sources |
| Add more keyword-retrieved evidence | 93/100 against 94/100 for control |
| Re-review rejected answers with fresh evidence | Recovered four answers but lost two correct abstentions |
| Treat a count over several categories as mentioned if any category is | Let an unanswerable question through |

We also gave Recall's saved contexts and Hindsight's saved contexts to the same
answer and judge models on the same 60 questions: Recall's scored 58/60 and
Hindsight's 56/60. That small test holds the models fixed but does not rerun
Hindsight's full system. The [evaluation guide](../docs/longmemeval-evaluation.md)
links each experiment's protocol and detailed results.

## This configuration

This configuration uses statement-focused evidence. Each question receives the
same twenty E5-ranked sessions as the earlier best, plus up to twenty more
sessions from a keyword search on the question. All selected sessions are
rendered within one 180,000-character budget, at most 4,000 characters per
session, prioritizing complete statements by the speaker the question is
about. Turn boundaries come from the original structured messages, so quoted
`user:` text inside a message cannot pass for a new user turn. The renderer
adds no facts and resolves no dates. See [history evidence](../docs/history-evidence.md).

Everything else matches the earlier best: Qwen (`qwen3.8-flash-next`) answers
with adaptive reasoning and a 16,384-token limit, under the system History
instructions and minimal-answer policy; a separate low-effort premise check can
replace an answer with "not recorded"; and Qwen judges each answer against the
reference with reasoning off.

## How it was run

Both runs used the same frozen runtime from commit
`1ecd3a1ba269cf0aba785573337c6879adab8e49` with pinned dependencies,
Node 24.22.1 and Python 3.13.16. Each run covered all 500 questions in their
original order, in 167 blocks of at most three, with fresh answer, premise and
judge calls for every question. No answers or verdicts were reused from any
other run, and there were no correctness-based retries, rejudging or exclusions.
The existing timeout and incomplete-response recovery applied in both runs; it
fired twice per run. Pinned inputs:

| Input | SHA-256 |
| --- | --- |
| Prepared benchmark input | `169e909e5e514a8376871fb3351c6597e90bfdf696f6d7206ec33d91dd9c02f4` |
| Exact E5 rankings | `3202a46e13795ee463c2dee91c7831c03f71ed6ee7668c19f7092675d6b1234d` |
| Structured turn manifest | `1a3f7baa93c76512f04f2ef0423d2cbf2f521ded59f6c18af86415b68876e1f5` |
| Earlier-best baseline report | `9cba4555cad8031eec9e404d96ae4f7065c302cbacfa8a87f1232c0b9e0105f0` |

Answer generation never sees original session IDs, reference answers,
categories or abstention labels. Each run used about 35.4 million observed
tokens and took roughly eight hours.

## How to read the result

- **Run-to-run variation is large.** Across the earlier best and both runs of
  this configuration, 454 questions were right every time, 35 changed between
  runs and 11 were wrong every time. A difference of a few questions between
  runs is within this variation.
- **The comparison with other systems is not head-to-head.** Hindsight's
  published 473/500 (94.6%) uses Gemini 3.1 Pro to answer and Gemini 2.5 Flash
  Lite to judge. Recall uses Qwen for both. 474/500 exceeds that published
  number by one question.
- **The public dataset has been used repeatedly during development.** Fresh
  calls do not make these questions unseen.
- **Some correct-judged answers still contain errors.** A source review of the
  100-question pilot for this configuration found accepted answers that
  misidentify a person or infer unstated facts, and misses that drop an ongoing
  activity or prefer an assistant's estimate over the user's own figure.

This measures the benchmark answer harness, not everyday application accuracy.
The [pilot trial](LONGMEMEVAL-STATEMENT-TRIAL-PROTOCOL.md) and the
[evaluation guide](../docs/longmemeval-evaluation.md) give the full history.

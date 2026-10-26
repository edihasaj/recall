---
summary: How to run Recall's LongMemEval answer harness, its main flags, model settings, outputs and interpretation limits.
read_when:
  - Running LongMemEval or comparing Recall with Hindsight
  - Interpreting retrieval hit rates versus final answer accuracy
---

# LongMemEval answer harness

`benchmark/longmemeval-qa.ts` measures LongMemEval-S answer accuracy: it
retrieves evidence for each question, asks a model to answer, and asks a
separate judge call to compare the answer with the reference. Results, the
comparison with Hindsight and everything we tried are in
[benchmark/LONGMEMEVAL.md](../benchmark/LONGMEMEVAL.md).

Retrieval hit rates and answer accuracy measure different things. A retrieval
hit means a relevant session appeared in the results; a correct answer also
needs the right text to fit in the context, the model to reason correctly, and
the model to decline questions about things never mentioned. Recall's 99.4%
retrieval@10 in [COMPARISON.md](../benchmark/COMPARISON.md) is a hit rate.

## Inputs

`benchmark/prepare-longmemeval-qa.py` freezes the public corpus and extracts
the literal AMB answer and judge prompts by reading the AMB source, without
running it. `benchmark/longmemeval-source-turns.ts` rebuilds trusted turn
boundaries from the original structured messages for statement evidence.
Rankings for `--retrieval cached` come from `benchmark/longmemeval.ts`; see
the [benchmark index](../benchmark/README.md).

The answer model never sees original session IDs, reference answers,
categories or abstention labels. The corpus's `answer_` session-ID prefix can
act as an imperfect relevance hint, including in unanswerable variants, so
sources are shown with neutral rank labels and dates instead. This is a
deliberate difference from AMB's presentation.

## Main flags

| Flag | Values | Purpose |
| --- | --- | --- |
| `--out` | new path | Required. Existing outputs are never overwritten. |
| `--input` | prepared input | Defaults to the frozen AMB input in `benchmark/data/`. |
| `--provider` | `qwen-local`, `gemini`, `moonshot` | Omit to prepare without model calls. |
| `--retrieval` | `lexical`, `cached` | Fresh keyword index per question, or supplied `--rankings`. |
| `--top-k`, `--context-chars` | numbers | Sources per question and the shared character budget (default 10 and 180,000). |
| `--evidence` | `prefix`, `focused`, `highlighted`, `supplemental`, `additive`, `statements` | How retrieved sessions are rendered. `statements` requires `--source-turns`. |
| `--evidence-policy` | `inline`, `system` | Where the History instructions are placed. |
| `--answer-policy` | `history`, `minimal`, … | Extra answer instructions; `minimal` asks for the shortest sufficient answer. |
| `--answer-check` | `none`, `grounded`, `premise` | Optional second call; `premise` can replace an answer with "not recorded". |
| `--reasoning-effort`, `--max-output-tokens` | `none` … `high`, `adaptive`; number | Answer model reasoning. `adaptive` uses high effort for enumeration questions. |
| `--request-mode` | `standard`, `robust` | `robust` uses strict JSON schemas and a bounded native transport. |
| `--answer-recovery` | `none`, `longer-timeout-transport`, … | One retry on timeout or incomplete response, and up to three retries for requests that never reached the model. |
| `--concurrency` | number | Parallel questions; keep at three or below for the DGX router. |

The best configuration's full command is in
[benchmark/LONGMEMEVAL.md](../benchmark/LONGMEMEVAL.md#reproducing).

## Model settings

Qwen runs `qwen3.8-flash-next` through the DGX router (`dgx run --`) at
temperature zero with a 600-second request timeout. The judge always runs with
reasoning off and a 4,096-token limit, whatever the answer settings are.
Transient HTTP errors allow at most six attempts with backoff from five to
sixty seconds, and server `Retry-After` delays are respected. Nothing retries
an answer or verdict because it was wrong. Failed requests and malformed
outputs count as incorrect in the fixed denominator.

## Outputs

Each run writes three files at the `--out` path:

- the final JSON report, with `status: "complete"`, selected question IDs,
  per-question rows, token usage, timings and hashes of the input, rankings,
  runtime source and package lock;
- `<out>.jsonl`, an append-only record per question;
- `<out>.progress.json`, a compact snapshot while the run is in progress.

A running or partial report is not a score. `benchmark/summarize-longmemeval-qa.py`
summarizes completed reports and can compare them with the pinned Hindsight
artifact on matching question IDs.

## Answering hosted evidence

`scripts/evaluate-hosted-answers.mts` answers the exact contexts retained by
Recall Cloud's authenticated retrieval diagnostic. It does not rebuild evidence
from local rankings. Supply the matching completed retrieval report and an
explicit frozen evaluator checkout:

```sh
dgx run -- node --import tsx scripts/evaluate-hosted-answers.mts \
  --contexts <hosted-contexts.jsonl> \
  --retrieval-report <hosted-retrieval-report.json> \
  --prepared benchmark/data/longmemeval-amb-input-2026-10-19.json \
  --source-root <frozen-evaluator-checkout> \
  --out <new-hosted-answer-report.json> --dry-run
```

Remove `--dry-run` to make model calls. The runner uses the selected checkout's
answer, premise, recovery and judge helpers. The answer system receives the
actual Cloud evidence policy and the minimal answer policy. Gold labels and
reference answers remain outside answer and premise prompts. Concurrency is
bounded at three; answer reasoning is adaptive with 16,384 output tokens, and
the judge uses no reasoning with 4,096 output tokens.

The report pins the inputs and imported evaluator files. A durable call journal
records starts and results. `--resume` retains completed rows and refuses an
uncertain started question rather than silently repeating it. Keep the original
artifacts when reconciling a failed run.

State the retrieval environment with every result. A local ASGI run exercises
Cloud backend code, but it is not a production deployment measurement. Pinned
q8 model assets can produce different vectors on Mac ARM and Linux x64 CPU
kernels; production parity requires evaluation on the matching runtime.

## Interpretation limits

- The default local harness indexes raw sessions for each question. It does not test
  automatic capture, memory promotion, instruction injection, the experimental
  temporal store or Recall Cloud.
- Lexical retrieval does not test vector search; `cached` rankings carry their
  own retrieval provenance.
- Small cohorts such as the 60-question development set are diagnostics, not
  estimates of full-corpus accuracy.
- Comparisons with published systems use different models unless both sides
  are rerun under the same protocol.

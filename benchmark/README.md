# benchmark/

Load shape + comparison harness for Recall.

Inspired by `agentmemory/benchmark/load-100k.ts` (https://github.com/rohitg00/agentmemory),
adapted to Recall's daemon surface.

## LongMemEval answer accuracy and Hindsight

The [saved-context diagnostic protocol](LONGMEMEVAL-CONTEXT-REPLAY-PROTOCOL.md)
defines a separate comparison using the same answerer and judge on both saved
contexts, with original identifiers hidden. It compares representation and
evidence amount jointly. It does not reproduce Hindsight's full system or
advance a rejected Recall candidate.

Its [completed replay](LONGMEMEVAL-CONTEXT-REPLAY-RESULTS.md) scored **58/60**
for Recall's saved context and **56/60** for Hindsight's, with zero errors.
Both passed five of the original seven cases. This does not establish a
full-system ranking or satisfy the improvement gates.

The subsequent [paired inference comparison](LONGMEMEVAL-INFERENCE-COMPARISON-RESULTS.md)
scored **59/60 for both fresh arms**, with all original seven cases correct
and zero errors. Two drafts plus arbitration used approximately three times
the tokens without an accuracy gain and worsened the locked source-review
counts. Unresolved grounding also prevents passage. It does not advance or
replace the full-corpus score.

A separate [minimal sufficient answer-policy protocol](LONGMEMEVAL-MINIMAL-ANSWER-PROTOCOL.md)
scored 59/60 for the policy arm and 58/60 for its fresh control. The control's
only extra miss was an answer timeout. The policy used slightly more total
tokens despite shorter answers, so it fails the strict resource requirement
and does not advance. The full-corpus score remains 457/500.
Run as a plain benchmark candidate through `--answer-policy minimal`, the
same configuration passed fresh development (58/60, all seven original
cases) but failed locked follow-up100 at 94/100 with 12/16 unanswerable.
See the [gates protocol and results](LONGMEMEVAL-MINIMAL-SUPPLEMENTAL-GATES-PROTOCOL.md).

The [answer evaluation guide](../docs/longmemeval-evaluation.md) documents
Hindsight's published 94.6% result and the separate Recall QA harness,
including fresh lexical retrieval, supplied hybrid rankings, model
configuration, failure accounting and reproducible commands. The retrieval
figures below measure relevant-session hits, not final answer accuracy.
The [completed blinded 60-question run](LONGMEMEVAL-HINDSIGHT-RESULTS.md)
scored 53/60 with fresh E5 retrieval and Qwen, compared with Hindsight's
published 54/60 on the same IDs. Different models and a diagnostic subset
prevent a matched system ranking.

The completed full-corpus candidate scored **457/500 (91.4%)** with fresh E5
rankings, versus 440/500 (88.0%) for the original lexical baseline. It used
Qwen for answering and judging, with a combined evidence, transport and
reasoning configuration change. Abstention and preference regressions remain;
the [improvement results](LONGMEMEVAL-IMPROVEMENT-RESULTS.md) retain failures,
paired comparisons, provenance and the separately frozen adaptive follow-up.
The packed development trial failed at 57/60 and did not advance.
The [validity review](LONGMEMEVAL-VALIDITY-REVIEW.md) documents an acknowledged
upstream reference error, original-ID visibility in Hindsight's artifact and
differences from the official judging contract;
all original scores and gates remain unchanged.
The separate [depth diagnosis](LONGMEMEVAL-DEPTH-DIAGNOSIS.md) examines missing
evidence outside both reserved validation cohorts and explains why simply
increasing retrieval depth under the same context budget can lose coverage.
The supplemental representation improved offline marked-turn coverage without
losing original evidence, but its fresh development answer trial failed at
57/60 and did not advance. All rejected results remain preserved.
The subsequent Azure-answer-only trial kept that evidence and Qwen judge
fixed, scored 54/60 with one timeout, and was also rejected.

### Fresh hybrid rankings with exact source occurrences

`longmemeval.ts` builds a disposable per-question Recall index and emits the
top 20 session IDs together with `retrieved_session_occurrences`. The occurrence
array preserves the exact original haystack positions for answer evaluation;
older ID-only files remain usable only through their documented ambiguous
reconstruction. Each result also carries `source_sha256`, a fingerprint of its
full ordered question/source set for subset-level replay validation.

```bash
RECALL_EMBEDDING_PROVIDER=multilingual-e5 \
RECALL_HYBRID_MIN_SIM=0 RECALL_SIMILARITY_THRESHOLD=0 RECALL_FTS_MODE=or \
node --import tsx benchmark/longmemeval.ts \
  --cache-embeddings \
  --out benchmark/data/longmemeval-fresh-e5.json
```

`--cache-embeddings` is opt-in. It keeps SHA-256 keyed document vectors only
in process for the selected provider/model and reuses only identical session
text. It does not cache query vectors, persist data, or inspect questions,
gold labels, session IDs, or credentials. Without the flag, embedding calls
remain sequential and unchanged.

`--out` requires a new final JSON path and also creates an append-only
`.jsonl` record stream plus a compact `.progress.json` snapshot. A final report
has `status: "complete"`, selected question IDs, data/harness hashes,
source/package-lock hash provenance, allowlisted retrieval/runtime/provider
metadata, and cache statistics. A running or
partial checkpoint is not an answer-evaluation input.

## UMP structured temporal capture

The [UMP pilot protocol](TEMPORAL-UMP-PROTOCOL.md) compares fresh agent-produced
UMP drafts with the same v3 validator receiving the same policies, sources and
trusted speaker metadata. A full small-source answer control runs separately.
The 24 authored synthetic worlds are development evidence, not an official
benchmark or a production accuracy estimate.

```bash
node --import tsx benchmark/temporal-ump.ts --out /tmp/recall-ump-prepared.json
dgx run -- node --import tsx benchmark/temporal-ump.ts \
  --provider qwen-local --out /tmp/recall-ump-fresh.json
```

Use Node 22 with a compatible SQLite binding. The first command only writes the
manifest; the second performs fresh calls without retries, cached answers or
a model judge. Both require a new output path. The bridge is explicitly invoked
and does not enable ordinary UMP server routing, automatic capture or Cloud sync.
The [completed results](TEMPORAL-UMP-RESULTS.md) record lower UMP capture quality
than the matched control and four incorrectly stored future plans. The
candidate remains experimental.

The [v4 retest](TEMPORAL-V4-RESULTS.md) records the UMP 1.0.2 upgrade and
separate fixed capture candidate. Its fresh development repetition and authored
challenge are complete. The first full public attempt suffered a provider
outage and remains recorded separately. A complete recovery repetition scored
168/434 for both shared raw and temporal v4, versus 179/434 for full raw.
Its one temporal augmentation added no accuracy gain. Capture still stores
some events as states, and request/schema failures affected 51.15% of cases.
These results do not support automatic capture or Cloud integration.
The [capacity controller](TEMPORAL-V4-CAPACITY-RUN.md) preserves the initial
timeout-heavy run and gates whole subsequent stages without changing the model
or scoring.

## Temporal memory pilot

`temporal.ts` compares the existing SessionStart compiler, an experimental
temporal snapshot store, and a source-history control on identical synthetic
assertions. It uses disposable databases and leaves extraction and question
parsing outside the experiment.

```bash
npx tsx benchmark/temporal.ts --out /tmp/recall-temporal-smoke.json
```

The default run measures evidence coverage and context size without model calls.
Use `--provider` for answer accuracy with the same model across all three arms.
See [temporal memory](../docs/temporal-memory.md) for local Qwen setup, scoring,
limitations, and the status of the APEX-MEM comparison. APEX-MEM's published
results are a separate protocol; the pilot does not establish a head-to-head win.
The [18 October pilot report](TEMPORAL-COMPARISON.md) records the measured answer,
citation, context-size, and failure results.

### Expanded evaluation

The [expanded protocol](TEMPORAL-EXPANDED-PROTOCOL.md) adds fresh generated
timelines, three repeated model runs, a query-scoped history control, paired
world/template uncertainty, and a separate source-language intake probe.
Generated variants and repeated calls are reported separately from distinct
questions.

```bash
node --import tsx benchmark/temporal-expanded.ts \
  --out /tmp/recall-temporal-expanded-smoke.json
dgx run -- node --import tsx benchmark/temporal-expanded.ts \
  --provider qwen-local --qwen-reasoning none --repeats 3 \
  --out benchmark/data/temporal-expanded-real-2026-10-18.json
dgx run -- node --import tsx benchmark/temporal-intake.ts \
  --provider qwen-local \
  --out benchmark/data/temporal-intake-real-2026-10-18.json
```

The first command makes no model calls. The expanded model run keeps at most
six requests active; the separate intake probe keeps at most three. Run them
sequentially to preserve the experiment's overall request limit. The intake
probe tests extraction and query parsing against a fixed schema. It does not
install automatic capture or change the running app.

The [expanded results](TEMPORAL-EXPANDED-RESULTS.md) include the completed
960-attempt comparison, uncertainty, intake errors, and adoption recommendation.

### Integration rehearsal

The [category protocol](TEMPORAL-CATEGORIES-PROTOCOL.md) adds ordinary-memory
route/type controls, broader source-language boundaries, a complete
type/source/scope/status coexistence matrix, and sampled public conversations.
These experiments use disposable databases and do not enable automatic intake.

```bash
node --import tsx benchmark/temporal-preservation.ts --out /tmp/recall-preservation.json
dgx run -- node --import tsx benchmark/temporal-categories.ts \
  --provider qwen-local --out benchmark/data/temporal-categories-real-2026-10-18.json
dgx run -- node --import tsx benchmark/temporal-public.ts \
  --provider qwen-local --out benchmark/data/temporal-public-real-2026-10-18.json
```

Run the two model experiments sequentially. Without `--provider`, each model
harness performs a smoke check and leaves model quality unmeasured. The public
experiment requires the existing `benchmark/data/recall-lme-e5-n60.json`
ranking cache and `benchmark/data/longmemeval_s_cleaned.json` dataset; it reports
cached hybrid retrieval and the lexical unanswerable supplement separately.
Its small sample and model judge do not produce an official LongMemEval score.
The [integration rehearsal results](TEMPORAL-CATEGORIES-RESULTS.md) record the
coexistence matrix, extraction failures, scale observations, and integration
decision.

### Validated language adapter

The [v2 protocol](TEMPORAL-V2-PROTOCOL.md) tests a new explicitly invoked language
adapter with stable keys, source-quote validation, canonical values, immutable
source replay and natural-question routing. Its fresh corpus separates six
development worlds from fourteen holdout worlds. The completed earlier
experiments remain unchanged.

```bash
node --import tsx benchmark/temporal-v2.ts --out /tmp/recall-v2-smoke.json
dgx run -- node --import tsx benchmark/temporal-v2.ts \
  --provider qwen-local --split development --out /tmp/recall-v2-development.json
dgx run -- node --import tsx benchmark/temporal-v2.ts \
  --provider qwen-local --split holdout --out /tmp/recall-v2-holdout.json
```

Use the installed Node runtime compatible with the local SQLite native module.
Recorded model evaluations use Node 22. Separate exact source capture, structured
lookup on each captured store, and natural-question lookup when interpreting
the reports. This harness does not enable automatic intake or Cloud sync.
The [v2 results](TEMPORAL-V2-RESULTS.md) record the held-out capture, lookup,
formatting caveat, fresh conflict probe, and next validation boundary.

### Larger public-conversation evaluation

The [larger protocol](TEMPORAL-REAL-PROTOCOL.md) specifies 434 additional
questions from the existing public corpus, a fresh lexical retrieval run,
semantic grading, actual temporal usage and a full-budget raw-history control.
Question-ID exclusions do not make the underlying corpus unseen. This remains
an offline augmentation experiment, separate from deployed hybrid retrieval
and Cloud integration.

```bash
node --import tsx benchmark/temporal-real.ts --prepare --out /tmp/recall-real-plan.json
dgx run -- node --import tsx benchmark/temporal-real.ts \
  --provider qwen-local --out NEW_RESULT_PATH
```

Use Node 22 with a matching SQLite binding. The formal run selects all remaining
cases; `--limit` is preparation-only. Existing outputs are protected, and
`--resume` requires matching frozen code, data and inference settings. The
recorded run uses an isolated source/dependency copy to avoid concurrent
workspace changes. Semantic accuracy, actual temporal augmentation, source
citations and ingestion cost remain separate measurements.
The [completed results](TEMPORAL-REAL-RESULTS.md) record all 434 cases,
the single actual augmentation, the full-budget control, failure accounting
and the decision to keep this adapter experimental.

The [v3 bug-fix protocol](TEMPORAL-V3-PROTOCOL.md) and
[diagnostic results](TEMPORAL-V3-RESULTS.md) test a separate corrected validator.
The replay preserves old model proposals and controls; it is development-exposed
diagnostic evidence. Targeted validator checks pass, while the 434-case
replay-based answer score remains unchanged.

## Recall vs agentmemory — headline

LongMemEval-S, N=500, including 30 unanswerable question IDs. Same dataset
agentmemory publishes; these are retrieval metrics.

| System | R@5 | R@10 | R@20 | NDCG@10 | MRR |
|---|---|---|---|---|---|
| agentmemory BM25 + vector | 95.2 % | **98.6 %** | 99.4 % | 87.9 | **88.2** |
| Recall — same model (all-MiniLM-L6-v2) | **96.6 %** | 97.6 % | **99.8 %** | 87.0 | 86.8 |
| **Recall shipped (multilingual-e5-small)** | **97.4 %** | **99.4 %** | **99.6 %** | **90.1** | **89.5** |

The MiniLM row isolates the system contribution (same embedding model agentmemory uses); the e5 row is what Recall actually ships. Full numbers, per-type breakdown, ablation, methodology → [`COMPARISON.md`](COMPARISON.md).

## Files

- `seed.ts` — Seeds N memories into an isolated SQLite DB. Used as a
  fixture for both the load harness and the demo recording so neither
  touches your real `~/.recall`.
- `load.ts` — Dependency-free p50/p90/p99 latency harness. Hits a
  running Recall daemon at `http://localhost:${RECALL_PORT}` (default
  `7890`) and writes a JSON report to `benchmark/results/`.
- `COMPARISON.md` — Side-by-side numbers vs agentmemory once both
  daemons have been run on the same matrix.

## Quick start

```bash
# 1) Build the daemon (needed for direct imports)
npm run build

# 2) Seed an isolated demo DB (default: ~/.recall-demo)
RECALL_DATA_DIR=~/.recall-demo \
  npx tsx benchmark/seed.ts --count 1000

# 3) Start the daemon against that same DB in another shell
RECALL_DATA_DIR=~/.recall-demo node dist/cli.js daemon

# 4) Run the load matrix
npx tsx benchmark/load.ts
```

## Tunables

Same convention as agentmemory's harness:

- `BENCH_N` — comma-separated seed sizes (default `1000,10000`).
- `BENCH_C` — comma-separated concurrency levels (default `1,10,100`).
- `BENCH_OPS` — ops per cell (default `200`).
- `BENCH_OUT_DIR` — JSON output dir (default `benchmark/results/`).
- `RECALL_PORT` — daemon port (default `7890`).

## Endpoints under test

Recall is MCP-first, so its REST surface differs from agentmemory's:

| Concern        | agentmemory                    | Recall (this harness)       |
|----------------|--------------------------------|-----------------------------|
| read (search)  | `POST /agentmemory/smart-search` | `POST /compile`           |
| graph traverse | n/a                            | `POST /graph/query`         |
| list latest    | `GET /agentmemory/memories?latest=true` | `GET /memories?latest=true` |
| write          | `POST /agentmemory/remember`   | direct `createMemory` (no REST) |

Write latency is therefore measured in-process, not over HTTP, so the
write numbers are a floor — production callers add MCP/IPC overhead on
top.

## Why p99

p50 says the median feels fast. p90 says the bulk feels fast. **p99
says the tail user feels fast.** Capacity planning and SLOs live at
p99; p50 will lie to you.

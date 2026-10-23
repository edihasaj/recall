# Temporal memory pilot: 18 October 2026

The local temporal prototype improved exact answers from 21/25 to 23/25 on a
small synthetic pilot and used 76.6% less evidence context than the existing
SessionStart compiler. Exact source-event attribution did not improve. This
experiment does not establish superiority over APEX-MEM or general production
memory quality.

## Same-model answer comparison

All arms used `qwen3.8-flash-next`, `reasoning.effort=none`, a 512-token output
limit, the same temporal rules, and an 8,000-character evidence cap. The three
arms ran concurrently for each question. Every arm received the same original
hand-structured source information through its own representation.

| Representation | Exact answers | Exact answers and source-event citations | Failed or malformed attempts | Mean evidence characters |
| --- | --- | --- | --- | --- |
| Existing Recall SessionStart compiler | 21/25 (84%) | 21/25 (84%) | 0 | 1,774 |
| Recall temporal snapshot prototype | 23/25 (92%) | 21/25 (84%) | 2 | 416 |
| Full source-history control | 22/25 (88%) | 22/25 (88%) | 1 | 1,737 |

Failed requests and malformed answers count as incorrect. The temporal arm
had one timeout and one malformed answer; history had one timeout. Correct
values with incorrect citation identifiers pass answer accuracy but fail the
grounded metric. No failed question was retried or removed from these totals.

The current compiler reused an expired feature flag, inferred a false value
before that flag's validity interval, and revived old runtimes during gaps.
History also revived expired runtimes. The temporal store returned no supported
fact for those gaps. Two otherwise correct temporal answers used internal
record UUIDs where the requested output required source `event_id` values.
Making citation identifiers clearer is a follow-up rather than a reason to
relax this run's scoring.

The context reduction is measured in characters, not billed tokens. Provider
token measurements and latency remain in the raw report. One temporal attempt
and one history attempt lacked usage measurements, and dollar cost is unknown.
The measured model response time did not improve: means were approximately
9.9 seconds for compiler, 10.2 for temporal, and 9.3 for history. Local retrieval
latency is separate from that answering time.

## Tight-budget reasoning experiment

A separate complete run used the server's default reasoning mode with the same
512-token limit. Its exact-answer counts were 4/25 for compiler, 15/25 for
temporal, and 0/25 for history. Failed or malformed attempts were 21, 10, and
25 respectively, so these numbers primarily measure whether an answer was
emitted under a tight budget.

A diagnostic request returned `status=incomplete`,
`incomplete_details.reason=max_output_tokens`, 512 reasoning tokens, and zero
answer characters. The fast-answer experiment was subsequently declared as a
separate protocol and used `reasoning.effort=none` identically for all arms.
The earlier default-reasoning results are retained rather than merged into the
fast-answer scores. An interrupted initial sequential run is also retained as
a partial artifact and is excluded from both complete-run tables.

## What was implemented

The experimental local MCP tools `temporal_remember` and `temporal_query`
preserve source evidence and support effective-time snapshots, source
observation cutoffs, explicit replacement links, history, expiry, and unresolved
conflicts. They require explicit structured inputs. They do not yet perform
automatic extraction, natural-language query parsing, Cloud synchronization, or
automatic instruction injection.

The fixtures cover 25 queries across historical/current facts, planned changes,
late corrections, exclusive interval boundaries, gaps, conflicts, out-of-order
independent assertions, replacement chains, and repository isolation. These
are hand-authored development fixtures, not a held-out public benchmark.
All source evidence fit the compiler's default context budget in this run.
The compiler arm therefore represents one existing Recall path rather than a
claim about all hybrid-search, graph, or connected-model configurations.

## APEX-MEM status

The [APEX-MEM paper](https://arxiv.org/abs/2604.14362) reports answer accuracy
on LOCOMO and LongMemEval using a richer event/property graph and retrieval
agent. Searches of the paper and GitHub did not locate an official runnable
implementation on 18 October 2026. APEX-MEM is explicitly `not_run` in our
reports. Its published percentages cannot be compared to these synthetic
scores or Recall's existing retrieval hit rates.

A next-stage comparison should use held-out, dated conversation data with the
same extraction inputs, answering model, budgets, unknown/conflict cases, and
evaluator. Multiple runs are needed before interpreting a two-question
difference. Automatic extraction fidelity, exact citation delivery, and Cloud
portability remain material gaps.

## Reproduction and evidence

Run the fixtures without model calls:

```bash
node --import tsx benchmark/temporal.ts --out /tmp/recall-temporal-smoke.json
```

Run the fast-answer protocol on a workstation with the existing Qwen router:

```bash
dgx run -- node --import tsx benchmark/temporal.ts \
  --provider qwen-local --qwen-reasoning none \
  --out benchmark/data/temporal-qwen-fast-2026-10-18.json
```

Omit `--qwen-reasoning` to reproduce the separate server-default protocol.
Use Node 22; the development machine used Homebrew Node 22.23.3.

Raw artifacts are local files under the existing ignored `benchmark/data/`
directory:

- `temporal-qwen-fast-2026-10-18.json`: complete fast-answer run.
- `temporal-qwen-2026-10-18.json`: complete default-reasoning run.
- `temporal-qwen-sequential-partial-2026-10-18.json`: interrupted initial run.
- `temporal-qwen-fast-source-2026-10-18.tar.gz`: non-secret source snapshot for
  the fast-answer experiment.
- `temporal-qwen-source-2026-10-18.tar.gz`: non-secret source snapshot for the
  complete default-reasoning experiment.

The fast-answer report records a dirty working tree based on
`ff5bcd132423a9a8b0fb5097886afea9758175b0` and source SHA-256
`49648dc0e73bf67eca2cf0019ffe07a0b321083892ae843e0009cc131ad9b438`.
The source snapshot preserves that experiment's exact files. Reports include
per-question output, failure categories, measured usage or explicit unknowns,
latency, category summaries, and invocation settings.

Validation passed: 1,065 tests, with three existing opt-in skips; source and
benchmark TypeScript checks; docs check; production build; and a compiled stdio
MCP canary exercising capture, historical/current queries, and repo isolation.
Independent review found the initial seeding, response-envelope, timing, and
date-normalization defects; they were corrected and rechecked before handoff.
The installed app and Recall Cloud were not changed.

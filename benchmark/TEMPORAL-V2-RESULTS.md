# Temporal language fixes: 18 October 2026

The new explicitly invoked adapter passes its targeted capture and lookup tests.
It remains experimental. The held-out exact-score improvement is attributable
to source-value casing, so it does not establish better general reasoning.
A separate fresh probe also exercised conflicts and retrospective correction
without relying on casing differences.

The [protocol](TEMPORAL-V2-PROTOCOL.md) defines the development/holdout split and
stage-specific scores. The original pilot, expanded, category and public
experiments remain unchanged.

## Implemented changes

`src/temporal/intake.ts`, `intake-contract.ts` and `intake-prompts.ts` provide
an explicit model-callback adapter over the existing append-only store:

- Known opaque keys preserve entity/property identity across later assertions.
- Independent conflicting and corroborating reports remain separate evidence.
  Replacement links require a visible predecessor and a supporting source
  clause; unrelated references cannot silently retire a record.
- Values preserve their source spelling or follow a declared property policy.
  Safe JSON integers can normalize to the store's canonical string form.
- Observation-based state starts use the supplied source timestamp without
  inventing earlier support. Explicit dates, interval boundaries and quoted
  evidence are validated. Invalid and zero-length intervals are rejected.
- Source replay returns existing owned assertions without another model call.
  Changed source text or observation time requires a new source ID.
- Source/catalog/query privacy checks use the existing credential redactor.
  Accepted neighbors are written in one transaction; failure rolls them back.
- Natural questions select an available key and effective/observation times.
  Present-state questions can use the reference clock, and supported reports
  for one key can return multiple conflicting assertions.

These helpers are not connected to normal memory capture, instruction promotion,
lifecycle injection, the installed app or Recall Cloud. The existing structured
MCP tools and temporal resolver were not changed.

## Development and freezing

The independently authored corpus contains 20 synthetic worlds, 60 source
statements and 56 questions. Six worlds were development; fourteen were holdout.
Source IDs and repository labels were opaque in model inputs. The parser clock
was authored independently of each question's expected dates, which were stated
in the question text. Six explicit current-state questions were included.

Preflight corrected evaluator bugs before formal development: predecessor alias
mapping, strict calendar parsing, equivalent timestamp normalization, valid
default query times, per-arm structured lookup, common-capability subsets and
failure/usage accounting. Original natural source wording was restored where a
draft had inserted literal property names to satisfy an overly strict validator.
Those validation constraints were fixed instead.

Three model-backed canaries used Cedar-style development statements. A separate
Node 24 native-addon attempt aborted before inference. All model-backed canary
outputs were retained, including the unsuccessful versions.

Two full development runs were recorded. Comparable exact source capture changed
from v1 3/10 versus v2 7/10 in the first run to v1 3/10 versus v2 10/10 in the
second. The second v2 run answered all 13 supported natural questions correctly.
Development fixes addressed nullable new-key IDs, quoted replacement proof,
integer representation, observation-start representation, unique source/fact
references, and query routing for reports belonging to one key.

The corpus, split and score definitions stayed fixed during formal development.
A pre-holdout correction restored the original v1 parser's canonical TTL
validation; it did not change the fixture or accuracy definition. The final
runtime, prompts, fixtures, baseline and scoring source were frozen before the
first holdout call. Their hashes still matched after all subsequent probes.

## Held-out results

The holdout used **14 worlds, 42 sources and 36 questions**. Both capture arms
used `qwen3.8-flash-next`, reasoning disabled, and a 512-token output cap.
The runner allowed at most three model calls concurrently, with sequential
sources inside each arm/world. There were no selective retries.

The baseline reused the frozen v1 category prompt and reconstructed its parser
and write rules. It is an experimental baseline, not the production Recall
capture classifier. Both arms received the same raw source statements. The new
adapter's catalog came only from its own already-ingested assertions.

| Measurement | v1 | v2 |
| --- | --- | --- |
| Exact comparable single-state capture | 8/14 (57.1%) | 14/14 (100%) |
| Supported structured lookups on common capabilities | 8/14 (57.1%) | 14/14 (100%) |
| All common-capability structured queries, including empty results | 27/33 (81.8%) | 33/33 (100%) |
| All structured queries, including capability expansion | 27/36 (75.0%) | 36/36 (100%) |
| Supported natural questions, including key and both times | Not run | 17/17 (100%) |
| Ordinary memory type | 15/15 | 15/15 |

The multi-property source was a separately labelled v2 capability expansion:
its two properties were captured correctly. Observation-start capture was a
development-only capability in this corpus and has no held-out source result.

The critical interpretation is that **all six v1 comparable capture misses were
value casing**: `cad`/`usd`/`https`/`amber` versus the source spellings. Their
underlying claims were equivalent. Source-string fidelity is useful, especially
for machine-consumed values, but these exact-score differences do not prove a
semantic reasoning advantage.

The exploratory 400-resample world bootstrap gave a positive exact-capture
difference interval of +12.5 to +75 percentage points. It inherits the casing
effect and the small authored-family sample; it must not be interpreted as a
general reasoning improvement.

All 12 ignore/defer controls produced no stored facts. Overall v2 route labels
matched on 37/42 sources (88.1%). Four differences swapped ignore and defer.
One source proposed an unsupported `none` state; validation rejected it.
Thus perfect supported lookup did not imply perfect source classification.

V2 actually used the temporal route on 22/36 questions: all 17 supported nonempty
queries and five valid empty-result queries. Fourteen questions fell back.
Empty/fallback controls are reported separately from fact recovery. The
aggregate fallback diagnostic does not distinguish every legitimate empty
timeline from a missing property.

The run made 120 model calls and recorded 81,611 tokens in 142 seconds. It had
zero request/schema failures and one source proposal rejection. Dollar cost was
unknown. It used one model and one inference run per case.
Including the three model-backed canaries, both development runs, this holdout
and the subsequent semantic probe, the recorded testing workload was 258 calls
and 172,755 tokens. Development tuning cost is included in those totals.

## Fresh semantic probe

After inspecting the casing effect, a further probe was authored with lowercase
values. The candidate remained frozen. This probe is a targeted regression
check, not another independent comparative benchmark.

Two new worlds supplied eight source statements and six natural questions:

1. An original gateway report, an independent conflicting report, corroboration,
   and a pretend dry-run value.
2. Conflicting gateway reports, a late correction replacing one specific source,
   and later corroboration of the unreplaced report.

The checks required exact values, source IDs and conflict status for current
questions, an earlier observation cutoff and a historical effective date.
**All 6/6 questions passed**, including a supported empty historical result.
This demonstrates the targeted timeline behavior on those new examples.
V1 was not run on this probe, and it does not establish competitor superiority.
The probe used 14 model calls; its source and raw results are preserved.

## Decision and limits

The candidate clears the source-capture and supported-lookup development
thresholds on this small holdout, with all ordinary types preserved and no
unsupported control stored. It justifies a larger real-conversation test.

It does not justify broad automatic integration yet. The measured v1/v2 score
gain primarily reflects formatting, the holdout did not include a fresh
independent-disagreement family, and the additional conflict probe has only two
worlds. The natural questions state their dates clearly; arbitrary conversational
references, broader languages, multi-hop/counting questions and production
retrieval have not been certified.

The adapter uses simple English grounding checks and bounded catalogs. Quoting
source text cannot prove every natural-language association. Retention,
individual removal, portability and Cloud round trips still need integration
work. No app installation, deployment, commit or push was performed.

## Validation and artifacts

Validation passed on Node 22:

- **1,131 tests**, with three existing opt-in skips.
- Source TypeScript and strict TypeScript for the new benchmark/tests.
- Production build and docs checks.
- Independent reviews of runtime boundaries and evaluator correctness, followed
  by regression checks for the identified defects.

Raw local artifacts are under the ignored `benchmark/data/` directory:

- `temporal-v2-development-canary-2026-10-18.json`,
  `temporal-v2-development-canary-2-2026-10-18.json`, and
  `temporal-v2-development-canary-4-2026-10-18.json`.
- `temporal-v2-development-real-2026-10-18.json` and
  `temporal-v2-development-2-real-2026-10-18.json`.
- `temporal-v2-corpus-frozen-2026-10-18.json`,
  `temporal-v2-holdout-frozen-2026-10-18.json`, and
  `temporal-v2-holdout-source-2026-10-18.tar.gz`.
- `temporal-v2-holdout-real-2026-10-18.json`.
- `temporal-v2-conflict-probe-2026-10-18.mjs` and
  `temporal-v2-conflict-probe-real-2026-10-18.json`.

Earlier Recall/APEX-MEM comparison limitations still apply. APEX-MEM was not run
and no direct competitor advantage was established.

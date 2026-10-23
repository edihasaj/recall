# Expanded temporal evaluation: 18 October 2026

Temporal selection is promising for dated assertions, but this experiment did
not clear the predeclared integration hurdles. It does not justify replacing
Recall's existing memory system or enabling automatic capture.

## Design and scope

The [protocol](TEMPORAL-EXPANDED-PROTOCOL.md) was recorded before the expanded
model runs. The temporal resolver and assembled answer-system prompt remained
unchanged from the earlier development pilot.

- The resolver passed 1,000 deterministic queries across 500 generated worlds.
- The model comparison used 80 fresh synthetic questions, grouped into
  40 worlds and ten authored scenario templates, with three repeats.
- Four representations produced 960 answer attempts: 240 per representation.
- A separate intake probe used 16 hand-annotated source statements and
  19 natural-language questions across eight worlds.

Generated variants are not independent real-world samples. Repeats assess
stability on these questions; each repeat also creates new storage UUIDs and
write timestamps. The model comparison supplies correct structured source
assertions and query fields. The intake probe separately tests the cost of
obtaining those fields from language, within a small fixed schema.

All comparison arms used `qwen3.8-flash-next`, reasoning disabled, the same
answer instructions, an 8,000-character evidence cap, and 512 output tokens.
The global request limit was six; two repeats ran concurrently. The intake
probe ran separately with at most three requests. Failed attempts were retained.

## Answer and source results

The primary score requires exact values, conflict status, and source event IDs.
Answer-only accuracy happened to equal that score in this run: no valid,
correct-value response used the wrong source IDs.

| Representation | Exact answers and source IDs | Failed or malformed attempts | Mean evidence characters |
| --- | --- | --- | --- |
| Existing SessionStart compiler | 207/240 (86.3%) | 14/240 (5.8%) | 2,448 |
| Temporal snapshot prototype | 225/240 (93.8%) | 15/240 (6.3%) | 475 |
| Full source history | 215/240 (89.6%) | 8/240 (3.3%) | 2,376 |
| Query-scoped source history | 207/240 (86.3%) | 11/240 (4.6%) | 568 |

Query-scoped history filters the same supplied repository, subject, and property
as the temporal arm, but keeps every version and leaves date resolution to the
model. It is a stronger control for ordinary relevance filtering.

Temporal context was 80.6% smaller than compiler context, and 16.5% smaller than
already-scoped history. Most of the size reduction therefore does not require
temporal resolution. These percentages measure evidence characters, not dollar
cost or total request tokens.

All 225 valid temporal replies matched the expected answer and IDs; its
15 misses were output-format failures. The compiler also produced 19 valid but
incorrect replies, full history 17, and scoped history 22. The primary scores
above include all failures, rather than conditioning on a successful reply.

Mean measured answer-attempt time, including semaphore wait, was 3.29 seconds
for compiler, 2.53 for temporal, 3.46 for full history, and 3.49 for scoped
history. These are observations under this local model workload, not production
latency guarantees. Source usage and explicit unknowns are retained in the raw
report. Dollar cost was not measured.

## Uncertainty and sensitivity

Repeats were averaged per question, then within worlds and templates.
The primary intervals use a seeded 2,000-resample template-cluster bootstrap.
With only ten authored families, these intervals are exploratory.

| Temporal minus control | Point difference | Template-cluster 95% interval |
| --- | --- | --- |
| Compiler | +7.5 percentage points | −3.8 to +20.4 points |
| Full history, the strongest control | +4.2 percentage points | −5.4 to +16.7 points |
| Scoped history | +7.5 percentage points | −4.2 to +21.2 points |

All primary intervals include zero. Removing the expired-successor family
changes temporal's difference versus full history to approximately −0.9 points.
The advantage is concentrated in certain temporal reasoning cases, rather than
established across all families.

World-cluster intervals are narrower, but those generated worlds share
templates and are not independent evidence of general production quality.
The raw report includes both interval types and every leave-one-template-out
estimate.

On the static-fact control, temporal scored 22/24 (91.7%), compared with full
history's 23/24 (95.8%). That −4.2-point difference is within the predefined
five-point margin. It is a small fact control, not a test of all coding rules,
promotion policies, or lifecycle integrations.

## Source-language intake probe

The experimental extractor saw source text, source IDs, timestamps, and earlier
raw sources from the same world. It saw no evaluation question or gold fields.
A separate parser saw natural-language questions and repository metadata.

| Stage | Exact result |
| --- | --- |
| Source-record extraction | 14/16 (87.5%) |
| Query-field parsing | 19/19 (100%) |
| Ideal structured store and ideal query fields | 19/19 (100%) |
| Extracted store with ideal query fields | 18/19 (94.7%) |
| Extracted store with parsed query fields | 18/19 (94.7%) |

The two extraction errors were concrete:

1. A source said retention ended on **1 February, exclusive**. The extractor
   wrote **31 January**, moving the boundary one day early. The source-field
   score caught this even though the chosen downstream dates did not expose it.
2. A source explicitly presented a conflicting hosting report without declaring
   a replacement. The extractor returned `ignore`, losing the conflicting
   evidence. The downstream query then incorrectly returned one host instead
   of preserving the conflict.

This is a fixed-schema development probe. It does not test arbitrary entity
resolution, open-ended assistant answers, long-term capture, or deployment
reliability. Repository metadata and source timestamps were supplied. A
scheduled assertion is also a claim about a plan; neither temporal selection
nor this experiment verifies that the planned change actually happened.

## Predeclared development hurdles

| Hurdle | Observed | Result |
| --- | --- | --- |
| Grounded gain at least five points against strongest control, with template interval above zero | +4.2 points; interval crosses zero | Not met |
| Static-fact regression no worse than five points | −4.2 points versus best control | Within margin |
| Failed/malformed attempts at most 5% | Temporal 6.25% | Not met |
| Exact source extraction at least 90% | 87.5% | Not met |
| Extracted-and-parsed downstream lookup at least 90% | 94.7% | Met in this small probe |

The recommendation is to retain the existing coding-rule memory and continue
developing an optional temporal lane for dated factual assertions. Capture
fidelity and response formatting need improvement before automatic routing.
Held-out real-session evidence and relevant configured Recall retrieval paths
remain necessary before a broader adoption decision.

## Artifacts and validation

Raw local artifacts under the existing ignored `benchmark/data/` directory:

- `temporal-expanded-real-2026-10-18.json`: all 960 comparison attempts,
  per-category/stratum results, usage, and uncertainty.
- `temporal-intake-real-2026-10-18.json`: all 35 intake model attempts and
  per-stage lookup results.
- `temporal-expanded-source-2026-10-18.tar.gz`: non-secret source snapshot.
- `temporal-frozen-baseline-2026-10-18.json`: frozen resolver and answer-prompt
  hashes.

The completed comparison's source SHA-256 is
`ec1637f4a1f527d313c7207cf6575c09497d26a51b9ef058c4a480acb676710a`.
The recorded hash still matches the experiment source files after the run.

Validation passed: 1,088 tests, with three existing opt-in skips; source and
benchmark TypeScript checks; docs check; production build; deterministic
500-world checks; and browser checks of the interactive timeline. Independent
review found and rechecked the environment, concurrency, query-error, partial
report, and token-accounting fixes before handoff.

APEX-MEM was not run; no official runnable implementation was located during
the earlier search. This is a comparison of local representations, not a
direct competitor benchmark. The installed app, Cloud sync, and automatic
capture were not changed.

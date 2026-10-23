# UMP structured temporal capture pilot

This is a local development experiment, not an official memory benchmark.
The existing frozen temporal experiments remain unchanged.

## Question

Can an agent emit a supported UMP structured state record that the temporal
validator accepts, without losing its source, effective dates or ownership?
Does changing the record format improve capture compared with the same
validator given the same predicate policies and trusted speaker metadata?

## Design fixed before model execution

- Use 24 fresh synthetic worlds in six categories, four worlds per category.
  These are authored for development and are not an independent generalization
  sample. Do not tune their expected answers after observing model results.
- Each source contains at most one supported assertion. Capture receives only
  the current source, trusted speaker spans, declared predicate policies and
  its earlier accepted state catalog. It never receives a question or answer.
- Compare `V3_MATCHED` with `UMP_PROFILE`. Both use the frozen v3 validator,
  identical sources, speaker metadata and predicate policies. Both make fresh
  model calls. UMP must not bypass source-grounding or uncertainty checks.
- A third `RAW` arm answers each question from the complete source messages
  visible at its observation cutoff. This is a small-source control without
  a retrieval bottleneck.
- The two captured stores receive explicit structured query fields from the
  fixtures. This isolates capture and temporal lookup; it does not measure
  natural-language query parsing or autonomous tool use.
- Use the existing `qwen3.8-flash-next` provider, temperature zero, reasoning
  disabled and a 512-token output cap. Run at most three worlds concurrently;
  process each world's calls sequentially. Do not retry failed calls.
- Count invalid output and failed calls as failures. Keep every raw response,
  prompt hash, rejection reason and available token-usage counter.
  A failed capture visible at a query's observation cutoff makes that arm's
  query attempt fail, even when an empty store accidentally matches abstention.
  Distinguish intentional refusals from unsupported proposals blocked by the
  validator; the latter are safe but are not exact extraction outcomes.
- Score state capture by exact normalized subject, predicate, value and validity
  interval, including unmatched extra assertions. Report precision, recall,
  refusal outcomes, question correctness and results per category.
- Query correctness requires the exact value set and matching conflict flag.
  No model judge is needed. Report the raw arm separately because its query
  task is natural language while the store receives structured query fields.

## Boundaries and decision

The prototype accepts a deliberately narrow `recall.temporal.v1` profile inside
UMP's existing optional `body.structured` field. It is an application profile,
not a new UMP standard or a protocol-version upgrade.

An explicit trusted context supplies the owner, source text, source identity and
speaker spans. A model-produced UMP record cannot authenticate these fields.
The bridge must reject unsupported policy-bearing fields rather than silently
discard them. It must isolate owners, preserve exact source replay semantics
and avoid ordinary-memory writes.

Technical acceptance requires passing regression tests for dates, evidence,
replacement, scope, replay and absence of instruction-memory writes.
Development-quality acceptance additionally requires at least 95% precision
and 80% recall on supported states, no stored assertions from unsupported
sources, and no lower structured-query correctness than the matched v3 control.

Even passing these checks only supports retaining the explicit local bridge.
Automatic capture, ordinary UMP server routing and Cloud synchronization need
broader fresh conversation tests plus durable envelope storage, lifecycle,
retention, deletion and export semantics. They are not enabled by this pilot.

The script records file hashes and writes a new output path. Historical results
must not be overwritten.

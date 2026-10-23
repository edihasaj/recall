# Temporal intake fixes and held-out validation

Recorded on 18 October 2026 before the v2 model runs.

The previous category and public experiments remain frozen. This experiment
tests a new, explicitly invoked capture/query layer over the same temporal
store. It does not enable lifecycle capture, automatic instruction injection,
Cloud sync, or deployment.

## Changes under test

| Observed failure | Proposed mechanism |
| --- | --- |
| Entity names change between assertions | Select opaque keys from the repository's previously stored facts. |
| Conflicting or corroborating reports disappear | Record source assertions independently; require explicit quoted evidence for replacement. |
| Value casing changes | Preserve the source spelling or apply a declared property policy. |
| Event facts acquire zero-length intervals | Separate state assertions from events; reject invalid intervals before writing. |
| Ordinary current-state questions always fall back | Provide available keys and a reference clock; use the clock for present-state queries. |
| Untested sensitive-input handling | Refuse sensitive source text before model calls and prevent unsafe catalog exposure. |

New keys require source grounding. Existing keys come from the actual extracted
store, never the evaluator's gold. Ambiguous aliases are not merged through
fuzzy matching. A quoted source claim remains evidence rather than verified
truth or action authorization. Observation-based starts establish support only
from the source timestamp, not an invented earlier effective date.

## Evaluation stages

An independently authored synthetic corpus contains separate development and
holdout worlds, with at least 60 raw sources and 50 questions across at least
20 worlds. The split is fixed before model inference. The development set can
support corrections; holdout sources, gold and scoring must not change after
their first live run.

The v1 arm reuses the frozen category prompt and reconstructs its parser/write
path in the new harness. It is an experimental baseline, not the production
capture classifier. Both arms receive identical raw sources, model, reasoning
mode, output cap and general property policies. The v2 catalog contains only
facts it has actually captured before the current source's observation cutoff.
The v1 source model sees prior raw sources as before.

Primary comparable metrics use single-state sources and exact downstream
queries with supplied structured fields in both stores. Multi-property capture
is a separately reported capability expansion because v1 explicitly supports
only one assertion. Ordinary type scores, supported-evidence questions, and
empty-result checks remain separate.

An additional v2 stage parses natural questions using only question text, an
independently authored reference clock, and keys available in its own extracted
store. The clock is not copied from the gold effective time or observation
cutoff. Explicit earlier cutoffs must come from the question's words.
Fallback on a supported question counts as a miss. The resolved key, effective
time, observation cutoff, source IDs, values and conflict status must match,
rather than only producing a plausible answer.

All stages use `qwen3.8-flash-next`, reasoning disabled and a 512-token output
limit, with no selective retries. At most three model requests run concurrently.
Reports retain all request, schema, validation and lookup failures, partial
planned/recorded denominators, raw outputs, usage or explicit unknowns, and
runtime/prompt/fixture hashes. All databases are disposable.

## Success criteria and limits

For further staged testing, exact single-state capture and supported downstream
lookup should each reach 90%, request/schema failures should remain at most 5%,
and no ignored/deferred control may enter the temporal store. Supported natural
questions should reach 90% exact lookup and actually route through the temporal
store; fallback successes cannot establish a temporal gain. Report ordinary
route/type results against the existing 95% diagnostic target.

Report paired v1/v2 differences and world-level uncertainty when the sample
supports it, with category and capability-expansion results visible. Generated
or authored scenario families remain limited evidence; a high aggregate score
does not certify all real conversational memory.

These checks can justify the next test stage. Broad integration still requires
representative conversations, production retrieval paths, privacy, retention,
removal, portability and Cloud round trips. Earlier results and failed hurdles
remain unchanged.

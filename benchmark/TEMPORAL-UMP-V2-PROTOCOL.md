# Post-fix UMP structured temporal capture

This reruns the complete 24-world synthetic development pilot with new model
calls after the v4 capture fixes and UMP SDK 1.0.2 upgrade. The earlier sources,
results and archived dependency manifest remain unchanged.

Use the same fixtures, 36 source messages, 24 supported assertions, 12 unsupported
sources and 34 queries as the original UMP pilot. They are development-exposed
examples, not a new holdout. Compare `V4_MATCHED`, `UMP_V2_PROFILE` and `RAW`;
both capture arms use v4 with the same trusted speaker metadata and policies.
The SDK comes from the exact checksummed UMP 1.0.2 release archive if registry
publication is unavailable.

The answering model, frozen prompts, strict output parsing, 512-token output cap,
temperature zero, disabled reasoning, three-world concurrency, structured query
fields, failure accounting and scoring follow `TEMPORAL-UMP-PROTOCOL.md`.
All 106 planned calls are fresh. There are no provider retries, cached answers
or model judges. Identical source replay tests are separate deterministic
regressions, not extra answer observations.

Freeze the new candidate and dependency versions before the provider run.
Do not modify fixtures or parsing rules to improve the score after seeing
responses. Report false positives, missed states, source refusals and lookups
separately. Raw-answer format failures remain failures under this strict
contract, even when prose or fenced JSON contains the intended value.

The original 95% state precision, 80% state recall, zero unsupported writes and
no loss against the matched capture control remain development gates. Passing
does not certify general language safety, production retrieval, autonomous tool
selection, Cloud synchronization or superiority over APEX-MEM.

The `--challenge` run additionally uses 12 newly authored targeted worlds
withheld from the implementation worker: 19 sources, 13 supported assertions
and 19 queries. It makes 57 fresh calls under the same protocol and reports
separately. These examples are a small authored challenge, not an independent
public benchmark. Freeze them before running either experiment and do not
tune the candidate after observing their model responses.

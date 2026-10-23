# LongMemEval supplemental answer trial

## Prior evidence

The separately frozen supplemental renderer passed the
[offline protocol](LONGMEMEVAL-SUPPLEMENTAL-EVIDENCE-PROTOCOL.md). It retained
every original top10 evidence byte and improved complete marked-turn coverage
from 285/300 to 293/300 outside both reserved validation cohorts. This is
source coverage, not answer accuracy. No new answer or judge calls have run.

The renderer source archive is
`longmemeval-supplemental-source-2026-10-20.tar.gz`, SHA-256
`1586b46a03b73da57ea0fd8ea77efa2d02d47968af12c894d8160bc4943dc61d`.
The answer integration must retain that implementation byte for byte.

## Fixed answering configuration

Use `--evidence supplemental`, robust Qwen requests, system History policy,
question-only adaptive reasoning with a 16,384-token answer budget,
180,000 context characters, topK20 and concurrency three. Keep the original
answer task and date clock, accepted History policy, JSON answer schema,
none/4,096 judge configuration, and reference answers unchanged.

Use no pre-answer ledger, standalone packed-answer guidance, or grounded
post-answer check. This tests additional source evidence with the previously
declared adaptive answering configuration. It remains a combined retrieval
depth and representation change, not a pure application effect.

Log all per-call effective settings, usage, errors, supplemental source ranges
and budget omissions, input/ranking hashes and source/dependency provenance.
Invalid rankings and unsupported option combinations must fail before model
calls. Each selected case receives at most the configured answer and judge
stages; existing transient HTTP retry rules remain unchanged.

## Development ranking extension

The original development ranking contains only ten source occurrences per
question. Do not replace their order or their evidence with the later full
E5 run's first ten results, which differ on half the cohort.

Construct a protected, gold-blind extension for every development question:

1. Retain its original ten ranked occurrences, IDs and source fingerprint.
2. Walk that question's already-frozen exact full-corpus E5 top20 list in
   order, appending occurrences not already present until the list has twenty.
3. Verify both parents against the same question and ordered original sources.
   Reject a conflicting fingerprint, duplicate occurrence or insufficient
   source count. Record both parent hashes and every original position.

This merges two previously frozen retrieval runs. It is not a fresh
single-retriever top20 ranking. No reference answer, marked-turn flag,
question category, generated answer, judge verdict or outcome may influence
the extension. Apply the same rule to every development case. Source IDs and
occurrences remain diagnostic metadata only.

Before calls, audit all sixty extended rankings and verify that the primary
ten evidence texts and metadata match the original development configuration.
Rendering may add excerpts but cannot remove primary evidence.

## Source and verification

Keep controlled experiment assembly separate from the current application.
Retain the entire 199-member supplemental source archive; overlay only the
explicitly reviewed answer-harness integration and add its new integration
test and this protocol. Do not import unrelated root runtime/package changes.
Pin effective dependencies and preserve the disclosed parent UMP mismatch.

Run appropriate project and direct benchmark type checks, full current-app
integration, relevant controlled-parent QA tests, docs checks, native-payload
parity checks for prior modes, and independent implementation/freeze reviews.
Preserve failed attempts. No answer experiment starts until these checks pass.

## Serial accuracy gates

1. Run fresh answers for all original development60 IDs using the protected
   extended rankings. Require at least **58/60 and all seven original cases**.
2. Only after that pass, run the existing locked lexical follow-up100 with
   deeper source retrieval and the same supplemental renderer. Require
   **93/100 and 14/16 unanswerable**. Its cases and references stay fixed.
3. Only after that pass, run all500 on the exact full-corpus E5 top20 rankings.
   Require **457/500, 27/30 unanswerable, 25/30 preferences and all seven
   original cases**.

A failed gate stops later stages. No selective retries, output repair,
rejudging, reference changes, gate relaxation or counterfactual credit.
All prior rejected trials and the documented corpus ambiguities remain
visible. Repeated public development cannot establish generalization; any
passing answer result must retain this qualification.

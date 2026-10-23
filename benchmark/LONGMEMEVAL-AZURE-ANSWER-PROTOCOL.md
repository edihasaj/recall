# LongMemEval Azure answer-model experiment

## Hypothesis

The supplemental Qwen run completed at 57/60 with zero request errors and
six of seven original cases correct. The three graded failures had their
relevant text delivered: the already-documented ambiguous clothing count, an
overly narrow category interpretation, and dismissal of a later explicit
correction. The clothing verdict is a grading disagreement, not an established
model error. More retrieved evidence did not resolve these graded failures.

This trial changes the answer model while keeping the supplemental evidence,
task, accepted History policy, reference answers and Qwen judge fixed. It
tests a model-capability hypothesis, not another answer-policy revision.
Any gain must be attributed to the changed answering configuration, not solely
to Recall or retrieval.

## Configuration

Use the already-deployed Azure model `gpt-5.6-sol-1` on the Recall account,
whose inventory identifies base model `gpt-5.6-sol`, version `2026-07-09`.
Use the Responses API, reasoning `medium`, 16,384 output tokens and the same
strict `reasoning`/`answer` JSON schema. Send the exact same answer-system
instruction and user prompt as the completed supplemental Qwen control.
Leave Azure temperature unset, using its provider default; do not assume that
reasoning deployments accept Qwen's explicit temperature zero. The comparison
therefore changes answer model, reasoning and sampling configuration. Record
the unset sampling parameter without inventing its effective value.

The judge remains `qwen3.8-flash-next`, reasoning `none`, 4,096 output tokens,
with the same pinned category rubric. Qwen inference options must not silently
configure Azure calls. Every call records its actual model, settings, usage,
attempts, elapsed time and prompt hash.

Keep supplemental evidence at 180,000 characters and topK20, with original
ten-source blocks unchanged. Use no ledger, packed standalone-answer guidance,
post-answer checker, answer voting, output repair or selective retry.

Run serially to fit the existing Azure deployment's reported 100,000
tokens/minute capacity and avoid consuming its quota in bursts. Do not change
deployment capacity, billing limits, model version policy or shared service
configuration. Record any provider throttling. Existing transient HTTP
429/5xx retry rules remain at most six attempts, including server cooldowns;
completed incomplete, malformed or unfavorable answers are not retried.

## Credentials and availability

The inherited Azure environment credential failed metadata authentication.
A targeted read of the existing Recall account credential authenticated
successfully. The value never entered agent context or a stored artifact.
An isolated non-benchmark Responses call with strict JSON completed on the
configured deployment. It proves availability for that request, not sustained
capacity or LongMemEval accuracy.

Supply the current credential only to the benchmark child process. Do not
change shell profiles, application credential storage or deployment keys.
Do not persist the credential in source, reports, native captures or logs.
The adapter receives explicit endpoint/deployment/key configuration and
performs no credential discovery.

## Isolation and checks

Retain the entire 201-member supplemental answer source archive, SHA-256
`067514780c9cf3456e4309974380a3852eb97cbe45fe7c36685b767f5558fda0`.
Overlay only reviewed benchmark answering integration, add the Azure adapter,
its tests and this protocol, and explicitly inventory the changes. Preserve
all primary evidence, renderer code, History policy, input data and judge code.
Keep current-app integration separate from the controlled-parent QA checks.

Before any benchmark calls:

1. Verify the adapter's authentication boundary, strict request settings,
   completion/usage/error handling, finite retries, timeout and no secret
   leakage using synthetic responses.
2. Verify prior native payloads remain unchanged without the opt-in answer
   provider, and that the new routing sends only answers to Azure.
3. Reconstruct all sixty evidence and user-prompt hashes against the completed
   supplemental run. Check exact answer-system parity and unchanged Qwen
   judge payloads through offline request captures.
4. Run project and strict benchmark type checks, relevant controlled QA tests,
   full current-app integration and docs checks.
5. Complete independent implementation and freeze reviews. Pin source,
   effective dependencies, both model configurations and credentials-free
   deployment metadata. A final non-benchmark adapter canary must complete
   before the fixed full development trial.

## Unchanged staged gates

Use the exact merged development60 rankings already frozen for the
supplemental run. Do not inspect or tune from the reserved follow-up outcomes.

1. Fresh complete development60: at least **58/60 and all seven original
   cases correct**.
2. Only after that pass, the existing locked lexical follow-up100:
   **93/100 and 14/16 unanswerable**.
3. Only after that pass, exact fresh-E5 full500:
   **457/500, 27/30 unanswerable, 25/30 preferences and all seven original
   cases correct**.

Any failed gate stops later stages. Preserve all failed calls and outputs in
their selected denominators. Do not modify references, thresholds, judging
rubrics or previous results, including the owner-acknowledged corpus error.

This remains adaptive development on a repeatedly evaluated public corpus.
The different answer model prevents a matched Hindsight system comparison.
Neither a model canary nor passing implementation checks establishes accuracy.

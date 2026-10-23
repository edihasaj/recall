# LongMemEval evidence delivery improvements

The completed fresh E5 diagnostic scored 53/60. Its seven failures comprise
five judged incorrect answers, one failed request and one malformed JSON answer.
All five judged incorrect answers had every marked session available without
truncation. The candidate must improve evidence use and reliability, while
preserving the original results and judge rubrics.

## Candidate

The application history renderer currently takes only the first two lines,
cuts each to 120 characters, and omits observation dates. A query matching
a later part of a retrieved summary can therefore lose that evidence during
delivery. A shared renderer will select verbatim query-relevant excerpts,
preserve adjacent context, report omissions and expose observation dates.
Observation dates must never be silently treated as event dates or proof of
supersession.

The benchmark will use that same renderer on the same retrieved sessions.
The candidate context will retain neutral source labels and exact source
ranges; gold labels, reference answers and question categories cannot influence
selection. The input question and retrieved source text are permitted inputs.
Any additional reasoning guidance will be recorded explicitly.

The separately labelled robust request mode will use strict JSON schema output
and an HTTP transport with an explicit end-to-end deadline. A live schema
canary succeeded on 19 October. This does not establish reliability on long
contexts. Request and format failures still count as incorrect; unfavorable
answers and verdicts are never selectively retried or repaired.

After v2 left two counting failures, the v3 candidate adds
`--answer-check grounded`: one fixed extra answer call on every successfully
drafted case, followed by the unchanged reference-based judge. The checker
sees the same evidence, question, reference clock and draft, with no gold
data or prior judge verdict. It audits claim support, counted-object identity
and requested status before returning the final answer. All stages and token
usage remain recorded; failures count against the same selected denominator.
This changes inference cost and the benchmark answering configuration. It
does not add an automatic reasoning model to ordinary Recall queries.

The clipped focused representation failed its full 60-question development
gate (52 correct versus 53). Its successor retains the original evidence
within the original context budget and adds a bounded verbatim reading index.
It must account for duplicate preview/full text in coverage metadata and keep
the same neutral source identity across both presentations.

An explicit answer-reasoning control uses the existing Qwen model with
`--reasoning-effort low --max-output-tokens 8192`. This changes answer inference,
not the retrieval algorithm. The judge retains reasoning `none` and a
4,096-token budget. Failures, reasoning usage and output usage are recorded;
incomplete responses remain failures without an answer retry.

The History interpretation contract can be tested as a trusted caller policy
with `--evidence-policy system`, instead of placing it inside quoted evidence.
The policy text is shared with the application's `query` tool description and
applies only to History; durable Rules and Commands retain their existing
meaning. It is excluded from judge calls. Moving it outside the evidence cap
can also alter retained source size, so results describe the combined
configuration and report actual token usage.

## Evaluation

1. Preserve the running, frozen 500-question keyword baseline.
2. Run the fixed 60 development questions with the candidate and the existing
   fresh E5 rankings. Reevaluate all seven initial failures and count all 60.
3. Compare the candidate with the frozen keyword baseline on the exact
   prospective validation IDs, using the same retrieval, answer model, judge,
   answer rubric and selected denominator.
4. Run the full 500 candidate configuration after development verification.
   Include the 30 unanswerable questions and report errors separately.
5. Report the changes in evidence coverage, truncation, answer accuracy,
   failure rate, context size and latency. Keep the E5 subset and keyword
   runs separate.

A seven-case development control retains the original prefix evidence and
changes only request handling. It runs serially while the frozen baseline
retains three workers, for at most four benchmark requests from this task.
The focused candidate runs after that control. Shared inference capacity
and different context sizes prevent a matched latency claim. All request
failures remain visible in their respective fixed denominators.

The prospective manifest is
`benchmark/data/longmemeval-improvement-validation-manifest-2026-10-19.json`.
It fixes 100 IDs outside the diagnostic 60, with 14 unanswerable questions.
The public corpus has been used in prior experiments, so this is disjoint
prospective validation rather than an unseen external holdout. Candidate
outcomes were not used to select it.

## Acceptance

The known failures remain visible even if reference ambiguity or a transport
issue makes one difficult to resolve. Passing unit tests does not establish
answer accuracy. Candidate conclusions require completed fresh answer runs.
Resolving the reported failures requires fresh correct answers on all seven
original failed questions, with each request and judge result retained. The
full development cohort must retain at least the baseline's 53 correct answers.
The fixed validation cohort must be compared with the same question IDs from
the frozen baseline, including unanswerable questions and failed calls.
Any remaining failed case or a broader accuracy regression requires further
work and must not be described as resolved.

The frozen 20 October high-reasoning candidate completed development at 55/60
and entered prospective validation. Its 100-case baseline is 88 correct,
including 12/14 unanswerable questions. The dated
`benchmark/run-longmemeval-candidate.py` supervisor advances to full lexical
testing only when both thresholds are retained. Full lexical and fresh E5
answer runs must each retain the original 440/500 and 23/30 unanswerable results.
These are advancement gates, not proof that every original failure is resolved
or that one configuration outperforms another system.

The supervisor verifies frozen source archives, inputs, code/package hashes,
answer settings, question identities and completed result rows. It serializes
the answering stages, follows exact live producer processes, preserves failed
completed reports and stops at an unmet gate. Existing partial output is never
restarted or overwritten. Frozen-run source and stage logs are retained in
`benchmark/data/`.

## Opt-in adaptive follow-up

The fixed-high run exposed an inference-budget problem: all six incomplete
responses were preference questions. The low-reasoning development control
scored 58/60 without request failures; high reasoning recovered additional
counting cases but scored 55/60 overall. These development observations and
provider-limit failures motivate a separately frozen experiment.

`--reasoning-effort adaptive --max-output-tokens 16384` uses native high
reasoning for recognized English enumeration phrases in the original question
and low otherwise. It does not read sources, category labels, IDs, reference
answers or judge results to make that decision. Answer prompts, evidence and
the History contract remain unchanged. Judges retain reasoning none and a
4,096-token limit. The mode is opt-in, with per-call effective settings logged.
There is no answer retry, failure fallback or reference-based repair.

The adaptive source archive is fixed before live calls. An offline audit
confirmed that all 60 development answer prompts match the original frozen
hashes; 19 route high and 41 route low. The legacy rankings were upgraded only
with source fingerprints and unambiguous occurrence identities, preserving
their ranked IDs and rendered evidence.

Before further evaluation, fresh development must retain at least 58/60 and
answer all seven original failures correctly within that complete cohort.
The separately locked follow-up 100 excludes the original development 60
and first validation 100. It includes the remaining 16 unanswerable cases.
Its pre-existing fixed-high control scored 93/100 and 14/16 unanswerable;
the adaptive candidate must retain both. Full-corpus measurements use the same
fresh E5 rankings as the fixed-high control and must retain its score or
446/500, whichever is higher. They must also retain its unanswerable result or
27/30, whichever is higher, plus 25/30 preferences and all seven original cases.
This threshold rule is fixed before adaptive calls. An unmet gate remains
visible and requires further work.

The manifest is
`benchmark/data/longmemeval-adaptive-followup100-manifest-2026-10-20.json`.
Selection used seeded category sampling and abstention flags, without answers
or verdicts. The same public corpus has already been evaluated in full, so
this follow-up is not an unseen external holdout or a replacement for the
original validation. The existing fixed-high E5 run remains unchanged and
finishes before adaptive calls begin.

`benchmark/run-longmemeval-adaptive.py` serializes the follow-up stages.
It waits for the fixed-high E5 producer to exit, verifies completed report and
JSONL identities, and records frozen source, input, ranking and protocol hashes.
Development7 remains a diagnostic; advancement depends on the complete
development60 result. A failed gate stops later stages while preserving the
completed failed report. A terminal partial run is retained separately and
cannot be silently restarted.

The application regression suite must prove that relevant tail content and
observation dates survive history delivery, with status, repository and
confidence gates preserved. Full tests, typecheck, build, docs checks and
independent review must pass.

No factual answer, benchmark ID, gold membership or category-specific answer
rule may be embedded in application code. Improvements learned from the
development questions must be evaluated on the fixed validation cohort.

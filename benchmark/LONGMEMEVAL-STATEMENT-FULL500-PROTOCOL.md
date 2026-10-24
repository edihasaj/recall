# User-requested exploratory statement-evidence full500, 24 October 2026

## Authorization and prior findings

Edi requested starting the full500 run after the completed diagnostics. This is
a new explicitly requested exploratory run of the original statement-evidence
candidate. It does not retroactively clear its failed source-review gate.

The paired statement trial scored 93/100 control versus 95/100 candidate, with
28/30 abstentions in both arms. Its numerical gate passed, but independent source
review found identity/status mistakes, unsupported harvest availability, and
source-priority regressions. Those findings and fixed scores remain unchanged.
The subsequent category-union premise diagnostic failed its abstention safety
gate. This run uses neither that policy nor a combination of the treatments.

This public corpus has been repeatedly inspected and used for development.
Fresh calls do not make the questions unseen. The run measures an experimental
answer harness; it does not establish everyday application accuracy.

## Frozen configuration and full cohort

Use the unchanged statement QA runtime from the reviewed pilot freeze at commit
`1ecd3a1ba269cf0aba785573337c6879adab8e49`, with its exact pinned dependencies,
Node 24.22.1 and Python 3.13.16. The new orchestration code, protocol and all
external inputs are separately pinned. Verify the complete inventory before
every stage and after the run. The original pilot runtime must not be edited.

Bind the canonical baseline report SHA-256
`9cba4555cad8031eec9e404d96ae4f7065c302cbacfa8a87f1232c0b9e0105f0`,
prepared input SHA-256
`169e909e5e514a8376871fb3351c6597e90bfdf696f6d7206ec33d91dd9c02f4`,
and exact E5 ranking SHA-256
`3202a46e13795ee463c2dee91c7831c03f71ed6ee7668c19f7092675d6b1234d`.
The structured source-turn manifest SHA-256 is
`1a3f7baa93c76512f04f2ef0423d2cbf2f521ded59f6c18af86415b68876e1f5`.
Its raw dataset and prepared-input bindings remain mandatory.

Select exactly all 500 canonical cases in original prepared-input order,
including all 470 answerable and 30 abstention questions. Selection, source
retrieval and reasoning effort do not depend on correctness, references or
marked sources. Use 167 consecutive blocks of at most three cases, with one
candidate stage at a time and at most three concurrent question pipelines.

Every question receives a fresh answer, premise check and judge call. Reuse no
pilot or historical answers, verdicts, drafts or favorable completions. Reference
answers appear only in the unchanged judge calls. Answer generation sees neutral
source labels, the question, trusted clock and source evidence, without original
IDs, positions, categories, abstention labels or marked-source lists.

Keep the exact pilot treatment: original twenty E5 occurrences plus up to twenty
distinct question-only lexical occurrences, trusted structured-message spans,
preferred-speaker complete-unit reservation, one 180,000-character context cap
and a 4,000-raw-character source cap. Keep Qwen adaptive answer reasoning with
16,384 output tokens, system History instructions, minimal answers, the original
low/4,096 premise check and none/4,096 judge, robust transport and the existing
longer-timeout recovery. No category-union policy, extra sample, temporal helper
or new answer instruction is included.

## Execution, scoring and publication

Preparation makes no model calls and reserves new output paths. Live execution
requires `--live` and runs persistently. Retain selection, efforts, block inputs,
inventory, stage reports, physical-LF-delimited journals, logs, prompt/source
hashes, native settings, usage, retries, fallbacks and unknown usage. Validate
every stage's identities, verdicts, source ranges, provenance and settings.

The denominator is always 500. Failed or missing selected cases cannot disappear
or be reused from another run. An incomplete or invalid stage stops execution
and leaves an incomplete result, with failed/missing cases counted incorrect in
any progress summary. No correctness-based retry, rejudge, output repair,
reference change, selective exclusion or replacement run is allowed. Existing
error-based transport recovery stays visible and unchanged.

Report the complete fixed raw judged score, abstention and category breakdowns,
all errors and accounting, and historical-baseline gains/losses with the limits
of that noncontemporaneous comparison. Do not rescore to force a target.

At least **474/500 (94.8%)** exceeds the pinned published Hindsight number of
473/500 (94.6%); at least 476/500 exceeds 95%. These thresholds alone do not
establish better grounding or a matched system-ranking claim. Hindsight uses
different answer and judge models. Preserve the prior source-review failures
and independently inspect new gains, losses and accepted answers before any
publication or release decision. The runner always leaves publication pending;
it cannot change GitHub, the landing page, version tags or release artifacts.

The current public best remains **472/500 (94.4%)** until a complete result and
its independent audit support an accurate replacement claim. Edi has authorized
the later GitHub/landing update and new version once a qualifying reviewed
result is available; this run alone does not assume that outcome.

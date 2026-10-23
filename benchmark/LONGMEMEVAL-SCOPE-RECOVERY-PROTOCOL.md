# Scope-aware recovery trial, 23 October 2026

## Hypothesis

The first recovery replay gained four answers but lost two correct abstentions.
Both losses acknowledged a missing asked-about employer or role, then answered
about a related one. A fixed scope instruction may prevent that substitution
and remove unsupported ancillary biography while retaining supported answers.
This hypothesis follows inspection of public-data outcomes. It is exploratory
development, not unseen validation or a fresh full500 experiment.

## Selection and arms

Reuse the identical 29 historical `premise_override === true` cases from the
canonical 472/500 report, SHA-256
`9cba4555cad8031eec9e404d96ae4f7065c302cbacfa8a87f1232c0b9e0105f0`.
Select all overrides without filtering on their correctness or category.
The parent input and exact E5 rankings remain bound to that report's hashes.

Both arms make fresh review and judge calls. Control uses the original grounded
review prompt. Treatment inserts the fixed `SCOPE_REVIEW_INSTRUCTION` before
the quoted record. The instruction requires the exact asked subject and
relation, forbids substituted employers/roles and assumed identities, separates
assistant-authored text from user biography, limits ancillary claims, and
preserves valid category-union counts. It contains no question IDs, named
benchmark subjects, references or gold-derived exceptions.

All other settings match the earlier recovery protocol: first 18 E5 source
occurrences plus two distinct keyword sources, supplemental rendering under
180,000 characters, original draft, History/minimal system instructions,
Qwen medium review reasoning with 8,192 output tokens, and the unchanged fixed
judge with no reasoning and 4,096 output tokens. Both use the same frozen Node
24 source/dependency snapshot. Original-policy prompts must reproduce the
earlier replay exactly, and evidence/drafts must match across arms.

Launch the two arms together with one question pipeline per arm (two total).
Both traverse the same fixed cohort order. This overlaps their execution to
reduce whole-run time separation but does not counterbalance individual cases.
Shared provider load, stochastic generation and inference timing remain limits.
No extra correctness-based retries, prompt edits, rescoring or case replacement
are allowed. Preserve logical-call starts/finishes, adapter attempts, unknown
usage, errors and fixed verdicts. No model calls occur before explicit `--live`.

## Decisions and reporting

Require all 29 cases in each arm, exact cohort identity, boolean verdicts,
error-free completion, matched nonempty evidence/drafts, distinct valid prompt
hashes, and unchanged source/input inventories. An incomplete or invalid pair
cannot pass. Failed selected cases count incorrect in the fixed denominator.

Report two mixed saved-answer scores with the other 471 historical answers
reused. Separately report paired gains/losses between fresh control and scope,
and abstention losses both versus fresh control and the historical baseline.
The old 474 replay is historical context, not the fresh control score.

Advance only if scope reaches at least **476/500**, loses no historically
correct abstention or fresh-control-correct abstention, has no unresolved
errors, and passes independent source review of every paired gain and any
changed abstention. Report unsupported claims and genuine ambiguity without
changing the fixed judge's score. A pass only permits planning a fresh
full-corpus validation; it cannot replace the public **472/500 (94.4%)** claim.

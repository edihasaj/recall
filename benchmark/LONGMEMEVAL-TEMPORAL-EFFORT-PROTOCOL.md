# Selective temporal answer effort, 23 October 2026

## Hypothesis and scope

The first high-effort pilot found a directly supported chronology correction,
but missed its advancement threshold and spent substantial time on a new
recommendation request. A narrow question-text router may reserve extra
reasoning for explicit ordering, recency, comparisons and elapsed time.
This is a new exploratory experiment after inspecting public-data results.
The corpus has already been evaluated repeatedly; it is not unseen validation.

The router preserves the current adaptive enumeration route, excludes requests
for new recommendations, and adds high effort for explicit temporal phrases.
It is an English heuristic, not a semantic classifier. Relative-weekday-only
questions and some implicit chronology remain outside its coverage. Generic
regressions distinguish historical advice from requests for new advice.

## Selection

Use the original questions in the canonical input bound to the 472/500 report,
whose SHA-256 is
`9cba4555cad8031eec9e404d96ae4f7065c302cbacfa8a87f1232c0b9e0105f0`.
Select **every** question for which the existing adaptive router returns low
and `resolveTemporalReasoningEffort(question)` returns high. Selection reads
only the original question text. Correctness, IDs, reference answers, source
labels and categories do not determine membership or effort.

Order selected IDs by SHA-256 of
`recall-longmemeval-temporal-2026-10-23-v1`, a NUL byte, and the ID.
The pre-call manifest records the complete cohort, seed, baseline fingerprint
and routing-helper fingerprint. Independently reproduce membership from the
frozen source before calls. Historical outcomes and category counts may be
reported after selection as diagnostics, without removing any selected case.

The offline manifest selects 74 questions, including seven unanswerable ones.
Their historical score is 72/74. These counts were inspected after applying
the fixed rule. Correcting both historical misses alone would bring the old
full-run total only to 474/500, so this tests a possible contribution rather
than a sufficient route past 95%. Neither miss is removed for source ambiguity.

## Fresh paired execution

Both arms use identical evidence, original questions, answer prompts, system
instructions, premise checks and fixed judge settings. Control uses adaptive
initial answer reasoning; treatment uses explicit high. Every selected question
is adaptive-low, so these are fresh low versus high comparisons. The router is
used for cohort selection only; application defaults remain unchanged.

Reuse the answer-effort supervisor with `--selection-policy temporal` and this
explicit protocol. Split the entire ordered cohort into blocks of at most
three, retaining a final partial block. Even blocks run control then treatment;
odd blocks run treatment then control. Only one block-arm runs at a time,
with at most three concurrent question pipelines. Wait for the scope-recovery
trial to finish before starting live inference.

Keep exact E5 top 20 rankings, supplemental evidence, the 180,000-character
budget, system History instructions, minimal answer policy, low-effort premise
check, 16,384 answer tokens, robust transport and longer-timeout recovery.
Use Qwen through `dgx run`; the judge remains none/4,096. Recovery can retry a
timeout at the same effort or lower effort after incomplete output; preserve
every recorded setting, error, attempt, fallback and unknown usage. There are
no correctness-based retries, rejudging, prompt revisions or case replacements.

Freeze Node 24, source, runtime assets, dependencies, inputs, selection and
protocol before calls, and verify the inventory before every block-arm and
after completion. Reserve a new output directory. Preparation makes no model
calls. References enter the judge only; generation receives neutral labels.

## Advancement and reporting

Require all of the following before planning full-corpus validation:

1. Every selected case completes in both arms with boolean verdicts and no
   unresolved answer, premise or judge errors.
2. Treatment gains at least two correct answers over fresh control.
3. No control-correct unanswerable question becomes treatment-wrong.
4. Evidence, answer prompts and system instructions match, with the declared
   initial reasoning setting as the only intentional treatment difference.
5. Independent source review supports every paired gain and examines every
   paired loss. Record ambiguity and unsupported claims without changing the
   fixed judge verdicts.

Report both fresh cohort scores, paired gains and losses, abstention pairs,
latency, observed usage and fallbacks. Also record the route's coverage limits.
A pass is a development screen with limited statistical power. Neither a
cohort score nor a replay combining old and new answers can replace the public
**472/500 (94.4%)** fresh-run claim. A score above 95% requires a separately
specified fresh full500 run with every planned question counted.

## Results

All 148 question-arm evaluations completed without errors or retries. Fresh
control scored **69/74** and high effort scored **73/74**: four judged gains,
no paired losses, and 7/7 correct abstentions in each arm. The numerical screen
passed, but the source-review gate did not establish support for every gain.
This configuration does not advance on the strength of these scores alone.

The NovaTech gain is a supported conditional calculation from direct statements
of nine professional years and about four years three months at NovaTech. The
airline answer adds a supported unique-airline interpretation to substantially
the same flights listed by control; an undated recent flight remains ordered
without a precise event date. This is partly answer granularity and judge
variation, not clearly a corrected chronology.

The Paris answer identifies an explicit April family trip but does not establish
that the other, less precisely dated family trips preceded it. The bedtime
answer links a 2 AM Wednesday bedtime to an appointment from a different week:
the May 24 appointment account points to May 18, while the May 29 bedtime
account points to May 24. The validity review already records this reference
date conflict. Judge acceptance cannot supply the missing relationship. Fixed
verdicts remain unchanged, and neither case is silently removed.

The run took approximately 128.5 minutes. Control recorded 5,440,871 tokens and
high effort recorded 5,506,016; all 444 calls reported usage. Summed answer-call
time was 5,001 seconds for control and 7,709 seconds for high effort. No recovery
fallback was needed. These are development results on repeatedly evaluated
public data, not a fresh full500 score; the public **472/500** remains unchanged.

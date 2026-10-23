# LongMemEval paired answer-effort pilot, 23 October 2026

## Question

Does high initial answer reasoning improve on the current adaptive policy when
the latter selects low effort? This changes one inference setting, not memory
retrieval, retention, source selection, or the everyday application.

The historical best full run remains 472/500. Of its 28 misses, 17 used a low
initial answer effort. Those errors motivated this experiment, but correctness
does not select its pilot questions. The complete public dataset has already
been evaluated repeatedly. This is exploratory development, not unseen testing.

## Frozen selection

Use the 321 rows whose historical `answer_call.request_config.reasoning_effort`
is `low` in `longmemeval-full500-longer-timeout-2026-10-23.json` (SHA-256
`9cba4555cad8031eec9e404d96ae4f7065c302cbacfa8a87f1232c0b9e0105f0`).
Sort by the hexadecimal SHA-256 of
`recall-longmemeval-effort-2026-10-23-v1`, a NUL byte, and the question ID.
Take the first 24, in that order. The frozen selection manifest records all
IDs and the baseline digest. Their historical result is 21/24, including 3/3
unanswerable questions. Neither that result nor the original 472/500 substitutes
for a fresh control.

## Arms and schedule

| Setting | Fresh control | Candidate |
| --- | --- | --- |
| Initial answer reasoning | Adaptive | High |
| Answer output budget | 16,384 tokens | 16,384 tokens |
| Other settings | Unchanged | Unchanged |

Both arms use Qwen through `dgx run`, the same frozen source and Node runtime,
exact cached E5 rankings, top 20 sources, supplemental evidence, a 180,000
character context budget, system History instructions, minimal answer policy,
the existing low-effort premise check, fixed judge, robust transport, and
`longer-timeout-transport` answer recovery. The recovery policy can fall back
from high to low after an incomplete response; record actual call settings and
recovery counts. A timed-out answer retries at the same effort. This tests high
initial effort under the existing recovery policy, not exclusively high calls.
The new freeze uses Node 24 and the current security-patched dependencies;
the historical 472/500 run used Node 22. The fresh paired control accounts for
that shared runtime refresh. This is not an exact historical replay.

Split the ordered selection into eight blocks of three questions. Even blocks
run control then candidate; odd blocks run candidate then control. Only one
block-arm runs at a time, with at most three concurrent question pipelines.
Each block-arm makes fresh answer, premise and judge calls. The schedule is
fixed before any live result. There is no correctness-based retry, rejudging,
prompt revision, or replacement of failed cases.

Source, dependency inventory, runtime, protocol, supervisor, selection and input
digests are recorded before calls. Verify the frozen inputs and code before
each block-arm. Use a fresh output directory, preserve stage reports, call
metadata, hashes and logs, and stop on incomplete or invalid output. Reference
answers and source labels remain confined to scoring; generation receives
neutral evidence labels and the original question and clock.

## Decision

Advance to a separately specified full-corpus experiment only when all apply:

1. All 48 planned question-arm rows complete with no unresolved errors,
   including premise-call errors or a missing boolean premise verdict.
2. The candidate gains at least two correct answers over the fresh control.
3. No unanswerable question changes from control-correct to candidate-wrong.
   Equal aggregate abstention totals do not satisfy this requirement if such a
   paired loss exists.
4. Evidence and answer prompts match across arms; the declared reasoning
   setting is the only intentional treatment difference.
5. Review the source support for every paired gain before advancement. Judge
   acceptance alone does not establish that an answer's claims are grounded.

Report paired gains and losses, both fresh scores, abstention pairs, errors,
latency, observed usage, and fallback settings. A pass is an inexpensive
advancement screen with little statistical power, not proof of improvement.
Pilot accuracy cannot be relabeled as a full500 score or replace the public
94.4% claim. Any later full run must count every planned question, preserve
failures, and report variation alongside the historical runs.

## Results

The pilot completed all 48 evaluations in 69.47 minutes. Fresh control scored
**21/24**, and high initial reasoning scored **22/24**: two paired gains and
one loss. Both scored 2/3 on unanswerable questions. There were no unresolved
errors, and all evidence, answer prompts and system instructions matched.
The net gain of one failed the predeclared threshold of two. This candidate
does not advance to a full-corpus run, and the public 472/500 stays unchanged.

Source review found a directly supported concert-companion correction in one
gain. The other gain preserves conflicting museum chronology, with unresolved
gallery/museum identity. The judged preference loss includes a speculative
cross-domain preference inference, but the judge also called explicit dietary
details unsupported despite their presence in the evidence. All fixed verdicts
remain as recorded; these caveats are not rejudging or score adjustments.

Control recorded 29,479 output tokens; candidate recorded 54,199, plus one
timed-out answer whose usage is unknown. Summed completed answer-call time was
2,105 seconds for control and 3,560 seconds for candidate, with a further 600
seconds on the failed candidate call. A recommendation case took roughly 19
minutes including its successful same-effort retry. Internal HTTP attempts
retain only final-response usage, so complete physical-attempt cost is unknown.

The private decision record is
`data/longmemeval-effort-pilot-decision-2026-10-23.json`. It binds result and
source-audit hashes. The frozen source, Node runtime and dependencies are
archived under SHA-256
`a5be251ff5f2afdf22853f07f786275b0b6b83753debeb959a701969fc6f26c2`.

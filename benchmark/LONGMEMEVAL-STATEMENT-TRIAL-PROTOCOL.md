# Fresh paired statement-evidence trial, 24 October 2026

## Hypothesis and development history

The additive trial completed at 94/100 for fresh control and 93/100 for
treatment. It preserved all old evidence and added context, increasing input
usage without an accuracy gain. It is rejected, and its results remain fixed.
The next candidate changes how selected sources are rendered: complete
preferred-speaker statements receive priority across all selected sources,
including the original twenty, within the existing context limit.

The public corpus and this cohort have already been inspected repeatedly.
The candidate follows those findings and is exploratory development, not
unseen validation. The final source-only screen verifies structured boundaries
for 500 cases, 23,867 sessions and 246,750 turns. It retains nonempty ranges
from all marked sessions across the 470 answerable cases, versus 463/470 for
control. Treatment uses 6.56% fewer characters overall, with a maximum of
162,216 per question and two omitted sources. User turns account for 33.86%
of its rendered raw characters. All original-twenty identities match, with no
range errors or detected source-ID leaks. Neither source presence nor
character share establishes answer quality. The earlier screen without trusted
turn boundaries is superseded.

## Fixed cohort and schedule

Reuse the preceding trial's complete one hundred identities and hash order:
all thirty unanswerable questions plus the first seventy answerable identities
by SHA-256 of `recall-longmemeval-additive-2026-10-23-v1`, a NUL byte and the ID;
sort the combined cohort by the same hash. Correctness, references and marked
source identities do not affect membership or effort. The abstention label
selects the safety stratum only; generation never receives it.

Bind original input and exact E5 rankings to the canonical 472/500 baseline,
SHA-256
`9cba4555cad8031eec9e404d96ae4f7065c302cbacfa8a87f1232c0b9e0105f0`.
Use fresh calls in both arms; do not reuse old favorable answers. Keep the
thirty-four blocks of at most three questions, final block of one, even blocks
control then treatment and odd blocks reversed. One block-arm runs at a time,
with at most three concurrent question pipelines.

## Treatment

| Setting | Fresh control | Treatment |
| --- | --- | --- |
| Mode | Supplemental | Statements |
| Sources | Exact E5 top twenty | Same twenty plus first twenty distinct keyword occurrences outside them, from lexical top eighty |
| Rendering | Existing highlighted/supplemental evidence | Complete source units with preferred-speaker reservation across every selected source |
| Total character limit | 180,000 | 180,000 |
| Per-source selection | Existing behavior | At most 4,000 raw characters |
| Initial reasoning | Existing adaptive rule | Same rule |

The statement renderer uses `renderEvidenceSources`, observation metadata and
`preferredEvidenceSpeaker(originalQuestion)`. It sets
`reserve_speaker_units: true`. Prior-advice questions retain assistant
preference. Exact ranges preserve quoted text and its governing context;
quoted role labels do not authenticate a speaker or turn role-play into
biography. Every selected source requires trusted UTF-16 turn spans rebuilt
from the original raw role/content message arrays. The mandatory
`--source-turns` manifest binds the raw dataset and prepared input hashes,
session identities, dates, text hashes and occurrences. QA verifies the selected
cases before credentials or model calls. Role-like lines inside message content
cannot create new turns or drop the enclosing scope. A source-only screen made
before this requirement is superseded and cannot authorize a live run.
Sources that cannot deliver a complete unit remain visible as
omitted metadata. The renderer neither generates facts nor resolves dates.

This is a combined source-selection and representation treatment. Source text
and ranges intentionally differ from control; an unchanged text-prefix gate
would be inappropriate. Instead, the original twenty source identities,
occurrences, dates and full source sizes must match in input order. Extra
selection remains question-only. All source metadata stays scorer-side;
generation sees neutral memory labels and dates.

Keep Qwen, system History instructions, minimal answers, low-effort premise
checking, adaptive initial reasoning with 16,384 output tokens, robust requests
and longer-timeout transport recovery. The fixed judge remains Qwen with
reasoning none and 4,096 output tokens. No temporal-helper annotations, answer
policy changes, extra samples or correctness-based retries are included.

## Validity and decision

Use the paired supervisor with `--candidate-evidence statements` and this
explicit protocol. Freeze Node 24, source/assets, dependencies, input, rankings,
selection, turn manifest, protocol and validators before calls. Verify the complete inventory
before every stage and after completion. Preparation makes no model calls and
reserves a new output directory before credential access. Run live execution
in a persistent session, retaining stage reports, physical-LF-delimited JSONL,
logs, request settings, attempts, fallbacks and unknown usage.

Require all one hundred cases per arm, boolean verdicts, successful premise
checks and no unresolved errors; strict source/range and 180,000-character
checks; matching original source identities; and identical answer instructions.
Failed, missing or malformed selected rows count incorrect and cannot be
replaced or dropped. An invalid or incomplete trial cannot advance.

Advance only with a net gain of at least two over fresh control, no
control-correct abstention becoming wrong, and independent source review of
every paired gain and loss. Preserve fixed judge verdicts when they conflict
with source evidence. Report both scores, changed outcomes, abstention pairs,
observed usage, latency and source caveats. Passing permits planning a fresh
full500 validation; it does not establish full-corpus accuracy.

The current verified full-run result stays **472/500 (94.4%)**. A new result of
at least **474/500** exceeds the pinned published **94.6%** number; it still
uses a different model setup and cannot establish a matched Hindsight win.
Scores from this safety-enriched sample or mixed old/new answers cannot replace
the full-run claim.

## Completed trial and source review

The run completed all 200 evaluations across 68 stages: **93/100 control and
95/100 statements**, with five judged gains and three losses. Both arms scored
28/30 on abstentions; answerable scores were 65/70 and 67/70. Every numerical
check passed. All 600 calls succeeded on their first attempt, with no unknown
usage or fallbacks. Observed input-plus-output tokens were 7,546,784 for control
and 7,052,616 for statements. Wall time was approximately 159 minutes.

Independent integrity review reconstructed all evidence and all 600 prompts,
verified all 18,407 inventory entries and checked every stage artifact. An
offline preparation script had omitted the system evidence flag, so its control
contexts differ from live. The live control matches the pinned full500 baseline
exactly; this is a preflight-receipt limitation, not an observed live-run defect.
Future preflights must pass `--evidence-policy system --answer-policy minimal`.

Independent source review does **not clear advancement**. The prior occupation
gain is supported. The smoker and three-day event gains retain correct drafts
that control's premise check wrongly replaced. The publication gain adds an
incorrect person identity and converts a proposed study into current research;
its relevant medical-imaging facts were already available to both arms, and
the reference conflicts with explicitly broader interests. The dinner gain
recovers harvested tomatoes but also infers harvest availability from pepper
plant ownership. Genuine losses drop Wednesday yoga without a cancellation and
replace a direct user fare quote with an assistant estimate. The furniture loss
largely reflects conditional-count framing and judge sensitivity.

These findings preserve every fixed verdict and do not calculate a revised
score. They do not establish a defensible improvement in grounded answer
quality, so the configuration did not advance under this protocol. The public
result at the time remained **472/500 (94.4%)**. The configuration was later
run on all 500 questions in a [separate experiment](LONGMEMEVAL-STATEMENT-FULL500-PROTOCOL.md).

# Fresh paired additive-evidence trial, 23 October 2026

## Hypothesis

Keeping the existing evidence and appending bounded keyword-retrieved excerpts
that retain attributed speaker statements may improve answers with missing
facts. Offline marked-source coverage and excerpt inspection motivate this
experiment; neither establishes answer accuracy. The public corpus has already
been evaluated repeatedly. This is exploratory development, not unseen testing.

This treatment changes source selection, excerpt representation and available
context together. It does not isolate the contribution of any one component.
Selective temporal reasoning is excluded: its numerical screen passed, but
source review found unsupported date relationships in accepted answers.

## Selection and execution

Bind the original input and exact E5 rankings to the canonical 472/500 report,
SHA-256
`9cba4555cad8031eec9e404d96ae4f7065c302cbacfa8a87f1232c0b9e0105f0`.
Select all thirty unanswerable questions as a safety stratum and seventy
answerable questions by increasing hexadecimal SHA-256 of
`recall-longmemeval-additive-2026-10-23-v1`, a NUL byte, and the question ID.
Sort the combined one hundred identities by the same hash. Correctness,
reference answers and marked source identities do not select cases. The
abstention label selects the safety stratum only and never enters generation.

After applying this fixed selection, its historical baseline is 95/100.
This descriptive count does not replace the fresh control or alter membership.

Freeze membership, protocol, source, Node 24, runtime assets, dependencies,
original input and rankings before calls. Split the ordered cohort into blocks
of at most three; the final block has one question. Even blocks run control
then treatment; odd blocks reverse the order. Only one block-arm runs at a time,
with at most three concurrent question pipelines. Both arms generate fresh
answers, premise checks and fixed judge calls. Verify the complete frozen
inventory before every stage and after completion.

| Setting | Control | Treatment |
| --- | --- | --- |
| Evidence | Existing supplemental top twenty E5 sources | Exact control prefix plus at most twenty distinct keyword sources |
| Base character limit | 180,000 | 180,000 |
| Additional character limit | 0 | 80,000, including headers and separators |
| Initial reasoning | Existing adaptive enumeration rule | Same rule |
| Answer output budget | 16,384 tokens | 16,384 tokens |

Treatment uses the first twenty distinct lexical occurrences outside the E5
top twenty, drawn from the question's top eighty lexical results. Each added
source has a 4,000-character framed limit and a 3,800-character raw-unit limit.
Its excerpts enable `reserve_speaker_units`; the original evidence remains
byte-for-byte unchanged. Complete source units and neutral labels retain exact
UTF-16 ranges. Character limits are not token limits. A source may still omit
needed facts, and added text can distract the answerer.

Both arms use Qwen through `dgx run`, system History instructions, minimal
answer policy, low-effort premise checking, robust requests and the existing
longer-timeout transport recovery. The judge remains Qwen with reasoning none
and 4,096 output tokens. Temperature and all other inference settings remain
fixed. Preserve actual request settings, fallbacks, attempts, errors and unknown
usage. References enter only the fixed judge; identifiers, abstention labels
and marked source metadata do not enter generation. Never retry or rejudge
because an answer or verdict is unfavorable.

## Validity and advancement

Reserve a new output directory before credentials are accessed. Preparation
creates the selection, block inputs, inventory and planned commands without
model calls. Failed, missing or malformed selected rows count as incorrect;
they cannot be dropped or replaced. An invalid or incomplete trial cannot pass.

Require all one hundred cases in each arm, boolean verdicts, complete premise
checks and no unresolved errors. Require identical answer instructions and
settings except the declared evidence treatment. Treatment must preserve the
entire control evidence prefix and its first twenty source-metadata entries.
Answer prompt hashes intentionally differ when evidence differs; record both.

Advance only when treatment gains at least two correct answers over fresh
control, loses no control-correct abstention, and passes independent source
review of every paired gain and loss. Judge acceptance alone cannot establish
a date, identity, relationship or action status. Preserve fixed scores and
record reference conflicts without forcing an answer to match them.

Report both fresh scores out of one hundred, paired changes, abstention pairs,
latency, observed usage, fallbacks and source-review caveats. This deliberately
overrepresents unanswerable questions and does not estimate full-corpus
accuracy. Passing permits planning a separately specified fresh full500 run;
it cannot replace the public **472/500 (94.4%)** claim. Do not combine favorable
old and new answers into a new headline score.

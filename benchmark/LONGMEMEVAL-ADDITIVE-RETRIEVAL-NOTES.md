# Offline additive retrieval diagnostic, 23 October 2026

The earlier lexical-fusion screen replaced some of the existing E5 sources
and lost relevant sessions elsewhere. This diagnostic instead retains all
20 E5 source occurrences and appends the first distinct lexical occurrences
outside that set, drawn from the question's top 80 lexical results.

The fixed ranking rule uses the original question and source text. Marked
source IDs are used only afterward to measure coverage. Thirty unanswerable
questions are excluded from this diagnostic because their marked sessions do
not establish an answer. All 500 public questions have already been evaluated
repeatedly; this is exploratory development.

| Extra lexical sources | Any marked session, of 470 | All marked sessions, of 470 |
| --- | ---: | ---: |
| 0 | 468 | 463 |
| 2 | 470 | 464 |
| 4 | 470 | 464 |
| 8 | 470 | 467 |
| 20 | 470 | 470 |
| 40 | 470 | 470 |

No original source occurrence is removed. The 20-source candidate follows
inspection of this grid; it is not a prospective validation result. The raw
first artifact included all 500 questions with marked IDs. A separate corrected
artifact explicitly excludes the thirty abstention cases; neither artifact
contains answer-model calls or answer-accuracy results.

## Evidence still has to reach the model

Inspecting the seven answerable cases with missing E5 sessions exposed a
second problem. A 4,000-character query-focused excerpt can include matching
assistant advice while excluding the user's direct statement of a race,
triathlon or family event. The user statement may share no literal topic words
with the question. The current renderer removes zero-overlap units before it
applies its speaker preference, so speaker preference alone cannot recover it.
Finding the correct session therefore does not establish that the answer fact
appears in the rendered context.

The prototype retains the established 180,000-character evidence as an exact
prefix and appends at most 80,000 characters from up to twenty additional
sources. Each extra source has a 4,000-character framed limit and a 3,800-character
raw-unit ceiling. Headers and separators count toward the shared budget;
character limits are not token limits. Neutral labels and exact source ranges
make the delivered text inspectable without revealing storage identities.

An optional speaker-reservation policy preserves a complete fitting statement
by the preferred speaker even without query overlap and admits other statements
by that speaker into ranking. It remains bounded and may still omit relevant
facts. Attributed role labels do not authenticate a source, and retaining a
statement does not prove its claim. The ordinary renderer default and the
running temporal-effort trial remain unchanged.

The offline renderer completed all 500 questions. Every established evidence
prefix and its twenty source-metadata entries remained exactly equal. The
largest result contained 257,527 characters, including at most 77,714 added
characters and forty source entries. One extra source was omitted. All marked
sessions had nonempty delivered ranges in 470/470 answerable cases, compared
with 463/470 before; no previously covered case lost marked-source coverage.
Nonempty ranges still do not prove that every needed fact is present.

Independent source inspection confirmed that direct race, triathlon and
cousin-wedding statements now appear where the earlier excerpts contained
assistant advice. It also found unresolved event dates, planned versus
completed participation, family relationships and ownership versus leadership.
The occupation facts already appeared in both excerpt versions. Retaining
these statements therefore does not prove the corresponding benchmark answers.

No answer-quality gain is established. A later live trial needs its own frozen
protocol, fresh control, abstention checks and source review before promotion.
Neither this coverage diagnostic nor a mixed saved-answer replay can replace
the public **472/500 (94.4%)** fresh-run score.

The private coverage and excerpt artifacts are retained under
`benchmark/data/longmemeval-additive-*2026-10-23.json`.

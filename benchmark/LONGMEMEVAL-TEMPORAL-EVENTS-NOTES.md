# Temporal event evidence: development direction

The current temporal adapter stores continuing states and resolves one
subject/property key at a time. It deliberately excludes events and plans from
automatic state capture, and routes event counts and joins to fallback. This
is useful for questions such as which provider a service used in February,
but it does not implement a timeline of attended weddings or completed races.
Broadening state intake to accept every dated sentence would weaken those
boundaries without supplying event identity or aggregation.

## Separate event evidence from state snapshots

```text
Source statement + recorded time + speaker attribution
                         ↓
Event evidence: actor, action, object, status, date interpretations, exact quote
                         ↓
Explicit identity and temporal links; unresolved alternatives retained
                         ↓
Retrieve, order or count supported events; cite the original statements
```

An event needs its own identity. Mentioning the same race twice should not
create two races, and a newer wedding mention should not erase an earlier
wedding. Planned attendance does not establish completed attendance. Owning a
poster or presenting research does not establish leading a project.

The time a statement was recorded is distinct from its event time. Relative
expressions must be interpreted against that statement's recorded calendar,
not the question's clock or another source's date. Expressions such as
"recently" do not establish a unique date. Conflicting calendar anchors must
remain visible rather than be reconciled to a benchmark reference.

The first small prototype separates unresolved mention discovery from strict
full-expression interpretation. Discovery preserves verbatim spans without
dates. Only a complete, reviewed expression in the narrow supported grammar
can yield calendar candidates; larger unsupported expressions remain unresolved.
Interpretations of "last weekday" retain both a preceding weekday and a weekday
in the previous ISO calendar week when those differ. None of these annotations
identifies an event, establishes that it occurred, links it to another event,
or authenticates the speaker. This is not a production event extractor.

An initial prose-scanning version failed source-safety review: it interpreted
"today two years ago" as today and ignored qualifiers such as "before Christmas".
Adding more keyword exclusions would remain brittle. The strict-expression
boundary replaces that version; its diagnostic packet and source fingerprint
remain preserved as superseded development evidence.

`benchmark/longmemeval-date-anchors.ts` exposes two deliberately separate APIs:

- `discoverSourceDateMentions(text)` returns UTF-16 spans marked `unresolved`,
  with no dates or source clock.
- `resolveSourceDateExpression(expression, observedAt)` accepts only a complete
  `today`, `yesterday`, `tomorrow`, or `last <full weekday name>` expression.
  Other phrases return `unsupported` without candidates. A caller must first
  establish that the supplied phrase is complete in its source context.

Calendar interpretation uses the date as recorded in the supplied observation
timestamp, preserving its offset's calendar day. That is an explicit assumption,
not proof of the author's local date. A single reading does not prove that the
corresponding event happened. Unsupported language remains unsupported rather
than being reduced to a recognized word inside it.

## Approaches to avoid

- Treating record time as event time or treating the latest mention as the
  latest event.
- Overwriting event history using state-style replacement semantics.
- Inferring completion from plans or merging similar people, objects or roles.
- Generating facts without an exact source quote and attribution.
- Assuming more reasoning or more context establishes source support. The
  earlier high-effort screen gained four fixed judge verdicts but did not pass
  the source-support gate.
- Forcing an answer to a known inconsistent reference. Source-grounded quality
  and fixed benchmark accuracy must remain separately reported.

## Validation sequence

Keep the state store and current benchmark modes unchanged. First test the
calendar helper with synthetic weekdays, leap dates, offsets and ambiguous
phrases. Then inspect source-only diagnostic packets without references in
generation. Any event extraction or answer treatment needs a separately frozen
protocol, exact quote validation, fresh control answers, abstention protection
and source review of gains and losses. Calendar parsing tests alone do not
establish a LongMemEval improvement or a Hindsight win.

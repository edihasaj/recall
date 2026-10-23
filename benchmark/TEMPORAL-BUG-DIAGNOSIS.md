# Temporal capture diagnosis: 18 October 2026

The failed larger comparison warrants a capture-bug investigation before a
judgment about the broader temporal approach. The recorded scores remain
unchanged. No runtime or frozen benchmark file was modified for this diagnosis.

Eleven deterministic probes exercised the frozen capture and query APIs with
fixed model responses in disposable in-memory databases. No live model calls
were made.

| Probe | Observed result | Interpretation |
| --- | --- | --- |
| `Acme pool size is 12.` versus `Acme pool_size is 12.` | The first stores; the second rejects the identical canonical property `pool_size`. | Identifier grounding bug. Splitting the label on underscores conflicts with treating underscores as word characters during matching. |
| `api gateway color is blue.` versus `api_gateway color is blue.` | The first stores; the exact underscore subject rejects. | The same grounding bug affects entities. |
| `Acme color is blue.` versus `Acme color is blue, and we might repaint it later.` | The first stores; the second rejects the same quoted current fact. | Uncertainty is checked over the entire punctuation-delimited sentence, including an independent later clause. |
| `Acme color is blue, and the lobby is not green.` | The blue fact rejects even when only its affirmative span is quoted. | Negation on a different entity can suppress an asserted fact. |
| `user: My favorite color is blue.` | A quote omitting `user:` rejects `subject: user`; including the role prefix stores the same claim. | Speaker-to-entity grounding is missing from the contract. A safe fix needs explicit speaker/span identity, not blanket acceptance of `user`. |
| `Acme uses Azure.` with property `hosting_provider` | Open schema rejects; the same proposal stores under a declared property policy. | Previous policy-based validation did not establish general open-schema conversational capture. |

In the full saved run, **392 of 433 fallback questions had no stored
assertions**. The resolver therefore usually had no facts to query.
Among 1,169 `ungrounded_new_key` rejections, 1,007 proposed the subject `user`.
In 942 of those records, a first-person quote omitted `user` while the source
snippet included a `user:` label. These are mechanism counts, not proof that
every proposal's value, date, scope and relationship were correct.

The underscore bug had no direct occurrences among the recorded first-failure
labels checked here. It is a reproduced defect, not an established explanation
for the aggregate score. Of 95 `unsupported_clause` rejections, 76 quotes
contained none of the guard's trigger words; surrounding text triggered the
check. Some surrounding conditions legitimately invalidate a quoted claim, so
this count is not a false-rejection rate.

The query contract deliberately falls back for elapsed-time calculations,
event ordering, joins and counts. Those are missing capabilities rather than
demonstrated implementation bugs. Provider failures and prefix truncation are
additional limits of the completed comparison.

Fixes should preserve source attribution, distinguish genuine conditions from
unrelated clauses, and validate speaker/entity and property relationships
without requiring canonical labels to appear literally. Blindly removing
grounding or uncertainty checks would admit unsupported claims.

The local diagnostic artifacts are:

- `benchmark/data/temporal-bug-probes-2026-10-18.json`.
- `benchmark/data/temporal-bug-mechanisms-2026-10-18.json`.
- `benchmark/data/temporal-bug-clause-candidates-2026-10-18.json`.

Any corrected runtime needs a new candidate version, regression checks and a
fresh evaluation. The existing 434-question result remains a measurement of
the frozen implementation.

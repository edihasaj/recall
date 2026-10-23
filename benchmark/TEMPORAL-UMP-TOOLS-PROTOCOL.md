# UMP temporal tool usability smoke

Recorded before model calls. This is a small authored integration check, not a
new answer-accuracy benchmark or a replacement for the v4 capture results.

## Boundaries

Use synthetic records in an isolated local data directory. Supply dates
explicitly through UMP; do not use automatic conversational extraction.
Exercise the real MCP initialization, tool discovery and tool calls. Retain
the model's actual calls and final answers. A scripted MCP test proves the
transport and backend; an agent smoke separately checks whether a model can
choose the exposed date fields.

Use the configured local Qwen agent profile without changing global agent or
MCP configuration. Give the agent the project and natural questions, but no
answer values or exact tool-call arguments. The server's initialization
instructions may supply the configured owner. Use one fixed fixture set and
retain failures without selective retries.

## Fixtures and questions

The fixture records describe:

- Azure hosting from January 1 until a March 1 change.
- Cloudflare hosting from March 1 through the end of 2026.
- An explicitly labelled AWS hosting plan for 2027, not confirmation that it
  happened.
- A bounded April discount.
- Another project's hosting and another owner's private hosting records.

Ask about February and April hosting, current hosting, the stated 2027 plan,
the April discount during and after its window, and a missing property.
Include a request about what was *known* at a past observation cutoff, which
`valid_at` alone cannot establish. Do not score a valid-time lookup as an
observation-cutoff query.

Evaluate both the answer and the calls: correct owner/project, explicit date
when required, preserved source qualifications, no private cross-owner or
cross-project leakage, and abstention where the records or operation cannot
answer. Any duration calculation belongs to the agent, not a newly claimed
UMP arithmetic operation.

Record the actual model, commands, fixture and source hashes, call count,
errors and outcomes. This targeted check does not certify general agent
compliance, natural-language extraction, production Recall or Recall Cloud.

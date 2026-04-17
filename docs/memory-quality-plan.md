---
summary: "Plan for the three behavioral changes that materially raise Recall's memory quality: rich context capture on corrections, outcome-after-injection feedback loop, and promotion-on-repetition (candidate gating). Depends on hooks defined in docs/agent-hooks-plan.md."
read_when:
  - Implementing or tuning Recall's correction-capture, scope inference, confidence updates, or candidate promotion logic.
  - Touching `recall_report_correction`, `recall_signal`, `recall_feedback`, or memory status transitions.
  - Designing changes that affect how memories move from `transient` → `candidate` → `active`.
---

# Memory Quality Plan

## Decision

Three behavioral changes, in this order:

1. **Rich-context capture on corrections** — capture the previous assistant turn and recent tool calls alongside the correction text, so scope inference has real material to work with.
2. **Outcome-after-injection feedback loop** — wire `tool_invoked` and the next `prompt_submitted` to autonomously record `followed` / `overridden` / `ignored` outcomes against memories that were injected this turn. This is the missing signal that makes confidence mean something.
3. **Promotion-on-repetition** — candidates stay `candidate` until either repeated ≥2 times across sessions (with semantic dedupe) or explicitly confirmed. Stop flooding `active` with one-off frustrations.

Skip everything else (passive injection, assistant message capture, fire-hose tool logging) until these three land.

## Why this direction

### Capture quality is the ceiling
The most expensive failure isn't missing an event — it's capturing a correction without enough context to scope it. "Use uv not pip" floating with no context becomes a noisy global rule; "use uv not pip when editing Python in repos with `pyproject.toml`" becomes a useful one. Rich context turns Recall's existing `recall_scope` into something with material to reason about.

### Confidence without outcomes is theatre
Recall has `recall_signal` and `recall_feedback` but nothing fires them autonomously. Every memory has flat confidence forever, and the ranker has no learning signal. Local embeddings (Phase 8 of the embeddings plan) won't show measurable gains because the underlying ranking signal is dead. Closing this loop is what makes everything else compound.

### Candidate flood is the noise problem
Today every correction becomes a `candidate` immediately. Most are one-offs, frustration spikes, or context-bound to a single mistake. Promotion-on-repetition is a one-line policy change with outsized noise reduction.

## Non-Goals

- Capturing every event (handled by `docs/agent-hooks-plan.md`).
- Replacing manual `recall_confirm` — explicit confirms still promote immediately.
- Adding LLM reasoning to capture or promotion decisions in v1 (deterministic scope inference + cosine dedup are enough for now).
- Touching the embedding pipeline. Quality changes are orthogonal to provider.
- Auto-deleting candidates. They time out via existing TTL, not new logic.

## Current State

- `recall_report_correction` takes `text`, `repo`, `path`, `session_id` only.
- No mechanism to attach previous assistant turn or recent tool calls.
- `recall_signal` / `recall_feedback` exist but are caller-driven; no autonomous wiring.
- `compileContext` doesn't track which memories it injected, so outcomes can't be tied back.
- New corrections become `candidate` immediately on first capture.
- Candidate-to-active promotion is manual via `recall_confirm`.

## Phases

### Phase 1 — Schema for rich context

Add a `context` JSON column to the corrections capture path so we have somewhere to put the previous-turn payload without bloating `memories.text`.

Schema additions:

- `memories.capture_context` (JSON, nullable) — contains:
  - `prev_assistant_text` (string, truncated to ~2 KB)
  - `recent_tool_calls` (array of `{name, path?, exit_code?}`, max 5)
  - `repo`, `path` (also stored top-level for filtering, mirrored here for evidence trail)
  - `agent` (claude-code | codex | …)
- `memory_injections(id, memory_id, session_id, repo, injected_at, outcome, outcome_at)` — new table tracking every injection so outcomes can be attached later.

Migration: included in the existing destructive-reset cutover (see `docs/local-embeddings-plan.md` Phase 7) so no separate migration story.

### Phase 2 — Rich-context capture on corrections

Update `recall_report_correction` (and the new MCP-fallback `recall_capture_correction`) to accept and persist:

- `prev_assistant_turn` — the assistant message that triggered the correction
- `recent_tool_calls` — last 1–3 tool invocations in this session
- `agent` — source agent name

Hook source (`recall hook prompt` from `docs/agent-hooks-plan.md` Phase 2):

- Cue regex matches → adapter pulls `prev_assistant_turn` from the agent's transcript file (Claude Code keeps these; Codex too).
- Recent tool calls come from `tool_invoked` events Recall logged earlier in the same session.
- Hook bundles all three into the `recall hook prompt` call → which writes via the same code path as `recall_capture_correction`.

`recall_scope` consumes the new fields:

- File path → repo + scope inference (already does this).
- Recent tool calls → infer file types, command patterns, framework cues (e.g. seeing `pytest` in recent tools narrows scope to Python tests).
- Prev assistant turn → infer what the rule is correcting (a wrong command, a wrong file edit, a wrong framework choice).

Result: the candidate memory now has materially better `scope` and `path_scope` values, plus an evidence trail in `capture_context`.

### Phase 3 — Outcome-after-injection feedback loop

Track every memory injection, then close the loop on the *next* turn or tool invocation.

#### Tracking
- `compileContext` writes a row into `memory_injections` for each memory it includes, keyed by `(memory_id, session_id)`.
- One row per injection per session — re-injections in later turns of the same session are no-ops on this table.

#### Closing the loop

The hook layer (or MCP-fallback `recall_signal_outcome`) resolves outcomes:

| Trigger | Inferred outcome |
|---|---|
| Next `prompt_submitted` is **not** correction-shaped, and a `tool_invoked` happened in between that touched a relevant path | `followed` |
| Next `prompt_submitted` is correction-shaped against the same area | `overridden` |
| `tool_invoked` happened but didn't touch the memory's scope | `ignored` |
| No tool calls before next prompt | `ignored` |
| Same correction text re-emerges from the user verbatim or near-verbatim | `contradicted` |

"Relevant path" = match between memory's `path_scope` and the tool call's path/cwd.

#### Confidence updates

Each outcome shifts confidence by a small delta (start conservative; tune via eval):

- `followed`: +0.05
- `overridden`: −0.15
- `ignored`: −0.02
- `contradicted`: −0.25

Floor at 0.0, ceiling at 1.0. `rejected` status is automatic when confidence drops below `CONFIDENCE.TRANSIENT_MAX` for 3 consecutive sessions.

Audit: every confidence shift writes a row into the existing audit table with `reason: "outcome:<kind>"`.

### Phase 4 — Promotion-on-repetition

New gating between `candidate` and `active`.

#### Policy

A `candidate` is promoted to `active` when **any** of:

1. User explicitly calls `recall_confirm` (existing path, unchanged).
2. The same correction is captured ≥2 times across **distinct sessions**, where "same" means cosine similarity ≥ 0.92 against the candidate's embedding.
3. A different memory of the same `(repo, type, scope)` group accumulates ≥3 `followed` outcomes — promotes the strongest candidate in that group.

#### Implementation

- Capture path: when a new correction comes in, run `findSemanticDuplicates` against `candidate` rows in the same repo. If a near-duplicate exists, increment `repetition_count` on the existing candidate and append source session/path to its `evidence` array. Don't create a new row.
- Background maintenance (existing `lifecycle.ts` timer): scan candidates whose `repetition_count >= 2` and promote.
- Promotion writes an audit row with `reason: "repetition:<count>"`.

#### Safety

- Repetition across sessions only — same-session repetition doesn't count (often a single user re-emphasizing).
- `findSemanticDuplicates` already exists; use it; don't reinvent the matcher.
- Candidates that age past 30d without repetition decay automatically (existing TTL).

## Cross-Cutting Concerns

### Hooks vs MCP parity
Every behavior in this plan must work via both the hook path (`recall hook prompt|tool|session-end`) and the MCP fallback (`recall_capture_correction`, `recall_signal_outcome`, `recall_session_end`). MCP tool handlers call the same internals as hooks — no divergence.

### Eval coverage
Extend `src/eval` retrieval harness with three new metrics:

- **Promotion accuracy**: of candidates promoted to active, how many would a human reviewer also promote? (Manual-rated fixture.)
- **Override rate**: of injected memories, what fraction get `overridden` or `contradicted` within the same session? Lower is better.
- **Scope quality**: of captured corrections, what fraction have non-trivial `scope` and `path_scope` (not just `repo:*`)? Higher is better.

These run alongside the existing recall@k / MRR fixtures in Phase 8 of the embeddings plan.

### Privacy
- `prev_assistant_turn` truncated to 2 KB, stripped of any path under `~/.ssh`, `~/.aws`, or matching `*.env`.
- `recent_tool_calls` capture only `name`, `path` (after gitignore filter), and `exit_code` — never input bodies, never output.
- `capture_context` JSON never leaves the local DB.

## Storage Impact

Per-correction:
- `capture_context` JSON: ~2–3 KB typical, hard cap 10 KB.
- `memory_injections` row: ~120 B per injection.

Per-session of typical agent use (~10 corrections, ~30 injections): <50 KB. Negligible.

## Risks

### False-positive correction detection
The hook-side cue lexicon will fire on prompts that aren't really corrections ("don't worry about X" → captured as a rule against X). Mitigation:
- Capture as `transient`, not `candidate`, when cue confidence is low.
- Only promote to `candidate` after `recall_scope` returns a meaningful scope inference.
- Eval metric tracks scope-quality % to surface regressions.

### Outcome misattribution
A `followed` outcome might be coincidence (the model would have done the right thing without the memory). Mitigation:
- Confidence deltas are small, not binary.
- Override has 3× the magnitude of follow — easier to demote bad memories than promote shaky ones.
- Audit trail makes this debuggable.

### Repetition gating delays useful memories
Some genuinely-important corrections are stated once and never repeated. Mitigation:
- Explicit `recall_confirm` still promotes immediately — power users have an escape hatch.
- Group-promotion path (3 `followed` outcomes elsewhere in the same `(repo, type, scope)` group) catches single-mention candidates that are clearly aligned with active rules.

### Schema cost on the destructive reset
Adding `capture_context` and `memory_injections` to the initial migration means reset rebuild from scans loses outcome history. Mitigation:
- This is acceptable: the existing reset already wipes signals.
- Outcomes accumulate fresh post-reset; they're high-volume so the system catches up within days of normal use.

## Phase Dependencies

- Phase 1 (schema) — no external deps.
- Phase 2 (rich capture) — depends on `docs/agent-hooks-plan.md` Phase 2 (`recall hook prompt`).
- Phase 3 (feedback loop) — depends on Phase 1 and `docs/agent-hooks-plan.md` Phase 2 + Phase 3.
- Phase 4 (promotion-on-repetition) — depends on Phase 1 only; can ship before Phase 3 if hook plan slips.

## Recommendation

These three changes compound. Rich context makes captures useful. The feedback loop turns confidence from a flat number into a trained signal. Promotion-on-repetition keeps `active` clean. Together they raise the floor on every other Recall feature — embeddings ranking, MCP injection, history rollups — without changing any of them.

Ship Phase 1 alongside the embeddings reset (same migration). Land Phase 2 once hook Phase 2 is in. Phases 3 and 4 can be independent merges.

## Cross-References

- `docs/agent-hooks-plan.md` — wiring layer; this plan is the behavior on top.
- `docs/local-embeddings-plan.md` — destructive reset / migration window for the schema additions in Phase 1.

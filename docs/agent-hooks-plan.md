---
summary: "Plan for wiring Recall into agent CLIs (Claude Code, Codex, future Gemini-CLI / Qwen) via lifecycle hooks, with an MCP-tool fallback for environments where hooks aren't available, and an install/update script that handles per-agent config locations idempotently."
read_when:
  - Implementing or extending agent hook integration in Recall.
  - Adding a new agent adapter (Gemini-CLI, Qwen, future).
  - Touching `recall setup` or hook install/uninstall flows.
  - Debugging why an agent isn't auto-capturing corrections or signals.
---

# Agent Hooks Plan

## Decision

Wire Recall into agent CLIs through **lifecycle hooks**, not through prompting the model. Ship adapters for **Claude Code** and **Codex** in v1, behind a **canonical event vocabulary** so Gemini-CLI, Qwen, and others slot in later without changing core logic. Provide an **MCP-tool fallback** so capture still works when hooks can't be installed.

Quality is the goal, not coverage. Only three events are wired in v1:

- `prompt_submitted` (with rich context — see `docs/memory-quality-plan.md` Phase 1+2)
- `tool_invoked` for Edit/Write only (outcome feedback loop — Phase 3 there)
- `session_ended` (cross-turn repetition pass — Phase 4 there)

Everything else (`SessionStart` warmup, `PreCompact`, passive injection, assistant message capture, fire-hose tool logging) is explicitly out of scope for v1.

## Why this direction

### Hooks beat prompting
Asking the model "remember to call `recall_report_correction`" is fragile, drifts after a few turns, and burns context. Hooks are deterministic, run pre-/post-turn, and cost zero LLM tokens.

### One vocabulary, many agents
Each agent CLI has its own hook config format, env vars, and stdout contract. If we let those leak into Recall's logic, every new agent forks the captures path. Adapters translate native events → Recall canonical events; everything downstream stays agent-agnostic.

### MCP fallback so we never have a dead branch
Some users won't or can't install hooks (locked-down machines, agents without hook support yet, CI sandboxes). The same captures must be invokable as MCP tools so the model can fall back to manual calls — but with the right scoping context attached so quality doesn't collapse.

### Install, don't document
"Edit your settings.json to add this block" is not a product. `recall setup` already wires MCP; it should also wire hooks, with idempotent merge into existing configs and a clean `--uninstall-hooks` path.

## Non-Goals

- Capturing every event (fire-hose). Skip per quality-first ordering.
- Capturing assistant messages by default.
- Passive memory injection on every prompt (defer until quality is fixed — see `docs/memory-quality-plan.md`).
- Running an external hook daemon. All hooks are short-lived `recall hook …` CLI invocations.
- Sending hook payloads anywhere off-machine.
- Forking behavior per agent in core logic.

## Canonical Event Vocabulary

All adapters translate native events into these. Anything not listed here is out of scope for v1.

| Recall event | When | Payload (minimum) |
|---|---|---|
| `session_started` | new agent session opens | `{repo, session_id, agent, started_at}` |
| `prompt_submitted` | user sends a turn | `{text, repo, session_id, prev_assistant_turn?, recent_tool_calls?}` |
| `tool_invoked` | post-execution of a tool | `{name, input_summary, exit_code, repo, session_id}` |
| `session_ended` | session stop / exit | `{session_id, repo, ended_at, turn_count}` |

Future-only (not in v1, listed so adapters know the shape):

- `assistant_message`
- `context_about_to_compact`

`prev_assistant_turn` and `recent_tool_calls` are optional in the schema but **required for quality** on `prompt_submitted` — see `docs/memory-quality-plan.md` Phase 2.

## Architecture

### Layout

```
src/agents/
  index.ts              // resolveAdapter(name) + canonical event types
  types.ts              // CanonicalEvent, AdapterCapabilities, InstallResult
  claude-code.ts        // adapter for Claude Code (~/.claude/settings.json)
  codex.ts              // adapter for Codex (~/.codex/)
  gemini-cli.ts         // stub for v2
  qwen.ts               // stub for v2
src/cli/
  hook.ts               // `recall hook <event>` subcommands — the hook entry point
src/setup/
  hooks.ts              // install / update / uninstall across detected adapters
```

### Adapter interface

```ts
export interface AgentAdapter {
  name: AgentName;                    // "claude-code" | "codex" | …
  configPath(): string;               // absolute path to the agent's config file
  detect(): "installed" | "not-installed";
  capabilities(): AdapterCapabilities; // { supports: ["prompt_submitted", "tool_invoked", …] }
  installHooks(profile: HookProfile): InstallResult;
  uninstallHooks(): InstallResult;
  envMapping: Record<CanonicalEventName, EnvShape>; // native env vars → canonical fields
  writeMcpFallback(): InstallResult;  // for environments where the agent supports MCP but not hooks
}
```

`HookProfile` for v1 is fixed: `["prompt_submitted", "tool_invoked", "session_ended"]`. Future profiles can be `"minimal"` / `"full"` once we know what `full` even means.

### Hook entry point — `recall hook`

All hooks call into the same CLI surface so per-agent behavior stays in adapters only.

```
recall hook prompt        --text=… [--prev-assistant=…] [--recent-tools=…] [--repo=…] [--session=…]
recall hook tool          --name=… --exit=… [--input-summary=…] [--repo=…] [--session=…]
recall hook session-start --repo=… --session=… --agent=…
recall hook session-end   --session=… [--repo=…]
```

Latency contract: each subcommand returns in **<80ms** for `prompt`, **<30ms** for `tool`, **<50ms** for session events. Anything heavier (rollups, Tier-2 maintenance enqueues) is fired and forgotten via the daemon.

If the daemon isn't running, hooks degrade to direct SQLite writes via the same code path Recall uses for MCP calls. No silent failures; non-zero exit + stderr on real errors, but never block the agent's turn.

## MCP Fallback

For agents that support MCP but not hooks (or where the user opts out of hook install), the same captures are reachable through dedicated MCP tools, designed so the model has enough scoping cues to attach context.

New / refined MCP tools:

| Tool | Purpose |
|---|---|
| `recall_capture_correction` | richer than today's `recall_report_correction`: takes `prev_assistant_turn`, `recent_tool_calls`, `repo`, `path` so scope inference still works |
| `recall_signal_outcome` | wraps `recall_signal` — model reports whether an injected memory was followed or overridden |
| `recall_session_end` | trigger end-of-session work manually |

These tools' descriptions explicitly tell the model *when* to call them (after a user correction, after acting on an injected memory). Strong tool descriptions raise call rate without requiring system-prompt nudging.

When hooks **are** installed, these MCP tools still exist and are idempotent — they don't double-write because all writes go through the same dedupe gate.

## Install / Update Script

`recall setup` already wires the MCP server. Extend it to also wire hooks.

### Behavior

1. **Detect** which agents are installed:
   - Claude Code: presence of `claude` on PATH and/or `~/.claude/settings.json`.
   - Codex: presence of `codex` on PATH and/or `~/.codex/config.toml` (or whatever current Codex config is).
2. For each detected adapter:
   - Read existing config.
   - Merge the Recall hook block into the right section idempotently (see "Idempotent merge" below).
   - Write back atomically.
3. Print a per-adapter result table.
4. Always also write the MCP fallback tools regardless of hook status.

### CLI surface

```
recall setup                      # full setup (MCP + hooks for all detected agents)
recall setup --hooks-only         # skip MCP, install hooks
recall setup --mcp-only           # current behavior
recall setup --agent claude-code  # restrict to one adapter
recall setup --uninstall-hooks    # remove hooks but leave MCP
recall setup --dry-run            # print planned diffs, write nothing
```

### Idempotent merge

- Recall-owned hook entries are tagged with a stable comment / key, e.g. `"recall:managed"`.
- On install, replace any block with that tag; never touch unrelated entries.
- On uninstall, remove only tagged blocks.
- Backup the config to `<config>.recall.bak.<timestamp>` before any write.

### Global vs project scope

- Default install scope: **global** (`~/.claude/`, `~/.codex/`).
- `--scope project` writes to project-local config (`./.claude/settings.json`) for repo-specific overrides.
- Global is the right default because Recall is a per-user agent helper; project scope is for teams who want hook behavior pinned to a repo.

### User consent

`recall setup` always prompts before writing to a config it didn't create, unless `--yes` is passed. The macOS app surfaces this as a one-time consent dialog on first run.

## Adapter Specifics

### Claude Code

- Config: `~/.claude/settings.json` (user) or `./.claude/settings.json` (project).
- Native events used:
  - `UserPromptSubmit` → `prompt_submitted`
  - `PostToolUse` (filtered to Edit, Write, Bash) → `tool_invoked`
  - `Stop` → `session_ended`
  - `SessionStart` → `session_started` (cheap, runs `recall hook session-start`)
- Env vars exposed by Claude Code (mapped in `envMapping`):
  - prompt text, tool name, tool input/output, session id.
- stdout from `recall hook prompt` is treated by Claude Code as injected context — leverage this for rich-context capture (the hook can echo nothing in v1; injection comes later).

### Codex

- Config: `~/.codex/` — exact file depends on current Codex version. Adapter detects.
- Native events:
  - prompt-submission hook → `prompt_submitted`
  - post-tool hook → `tool_invoked`
  - session-end hook → `session_ended`
- Where Codex lacks a native lifecycle hook for an event, fall back to the MCP path for that event only (mixed mode is fine).

### Gemini-CLI / Qwen (v2 stubs)

Files exist with `detect()` returning `"not-installed"` and `installHooks()` throwing `"not implemented"`. They reserve the namespace and document the canonical mapping so v2 only fills in adapter logic, never reshapes core.

## Latency + Failure Modes

Hooks are on the critical path of the agent's turn. Three rules:

1. **Never block on network.** No HTTP, no embedding model load on the hot path. Embedding model lazy-loaded by the daemon, not by hooks.
2. **Always non-zero exit on misuse, but never on routine no-op.** A hook with nothing to do exits 0 silently.
3. **Daemon-down fallback.** If the daemon isn't running, hooks open SQLite directly with `WAL` and write the canonical row. Heavier work (rollups, Tier-2 enqueues) is skipped, not failed.

Telemetry: every hook call writes a row into `hook_calls(event, agent, duration_ms, ok)` so we can spot regressions. Local-only.

## Privacy Posture

Reaffirmed:

- Nothing leaves the machine.
- File contents are never sent into hook payloads — only paths and length deltas.
- Bash output bodies are never captured — only exit codes + first 200B for error fingerprinting.
- `.gitignore`d paths and known secret paths (`~/.ssh`, `~/.aws`, `*.env`) are hard-skipped in `recall hook tool`.
- Assistant messages are not captured in v1.

## Phases

### Phase 1 — Canonical event types + adapter scaffold
- `src/agents/types.ts` with the four canonical events and adapter interface.
- Empty `claude-code.ts` and `codex.ts` adapters with `detect()` only.
- Tests for the resolver.

### Phase 2 — `recall hook` CLI surface
- Implement `recall hook prompt | tool | session-start | session-end`.
- Latency budget tests (assert <80ms for `prompt`, <30ms for `tool`, <50ms for session events on a warm DB).
- Daemon-down fallback path.

### Phase 3 — Claude Code adapter
- Native event mapping.
- `installHooks()` writes a tagged block into `~/.claude/settings.json`.
- `uninstallHooks()` removes only tagged blocks.
- Backup + atomic write.
- Integration test with a fixture `settings.json`.

### Phase 4 — Codex adapter
- Same shape as Phase 3 against current Codex config layout.
- Mixed-mode fallback to MCP for events Codex doesn't support natively.

### Phase 5 — MCP fallback tools
- `recall_capture_correction` (richer than today's `recall_report_correction`).
- `recall_signal_outcome`.
- `recall_session_end`.
- Strong tool descriptions to maximize spontaneous model use.

### Phase 6 — `recall setup` wiring
- Detect installed agents.
- Install / uninstall / dry-run flags.
- Idempotent merge with tagged blocks.
- Per-agent result table.
- macOS app consent dialog.

### Phase 7 — Forward-compat stubs
- `gemini-cli.ts`, `qwen.ts` with documented mappings + `not implemented` install.
- Adapter resolver returns useful errors for unknown agents.

### Phase 8 — Telemetry + uninstall path
- `hook_calls` table + a `recall hook stats` CLI for users to inspect.
- `recall setup --uninstall-hooks` end-to-end test.
- Docs + README update.

## Risks

### Adapter config drift
Claude Code / Codex change their hook formats. Mitigation: pin tested versions, test fixtures per adapter version, fail loudly with a "your agent is newer than this Recall version" hint.

### Hook latency creeping
Phase 2 tests guard the budget, but rich context capture in `docs/memory-quality-plan.md` adds work. Mitigation: keep heavy work in the daemon background queue, not in the hook process.

### Idempotent merge bugs
A bad merge could nuke unrelated user config. Mitigation: backup, dry-run flag, tagged-block-only writes, integration tests against real `settings.json` fixtures.

### MCP fallback divergence
Two capture paths (hook + MCP) risk diverging behavior. Mitigation: both call the same `recall hook` internals; MCP tool handlers literally invoke the hook code paths.

## Recommendation

Ship adapters for Claude Code and Codex behind one canonical event vocabulary. Wire only the three events that move quality. Keep MCP as a first-class fallback with the same scoping richness. Make `recall setup` install/update/uninstall hooks idempotently across detected agents. Reserve Gemini-CLI / Qwen stubs so v2 is mechanical.

## Cross-References

- `docs/memory-quality-plan.md` — defines what the hooks actually capture (rich context, outcome loop, promotion-on-repetition). This plan is the wiring; that one is the behavior.
- `docs/local-embeddings-plan.md` — embeddings already default-on; hooks rely on the daemon being able to embed/query without external deps.

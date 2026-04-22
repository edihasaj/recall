# Configuration

Everything Recall reads at runtime from the environment, plus how to wire up LLM-assisted memory maintenance.

## Hook injection

Once `recall setup local` has installed hooks into `~/.claude/settings.json` and `~/.codex/hooks.json`, the daemon injects repo memory on `SessionStart` (once per session). `UserPromptSubmit` fires every turn for telemetry and correction capture but emits **no** additional context by default — this keeps subsequent prompts quiet.

You can tune that with these env vars (read fresh on each hook invocation — no daemon restart needed):

| Variable | Default | Effect |
|---|---|---|
| `RECALL_HOOK_INJECT_CONTEXT` | `true` | Set to `false` to disable all hook-driven memory injection (SessionStart + UserPromptSubmit). Hooks still fire for telemetry and correction capture. |
| `RECALL_HOOK_INJECT_PROMPT` | `false` | Set to `true` to re-enable per-prompt memory injection on `UserPromptSubmit`. Useful for long sessions where you want context re-ranked against every prompt. |
| `RECALL_HOOK_INJECT_STYLE` | `minimal` | Set to `verbose` to restore the historical format (`Recall memory for this repo:\n# Recall: <slug>\n\n...`). `minimal` strips the prefix and repo header — the section bullets are all that lands in context. |

Where to set them:

- **Per-machine**: edit `~/.zshrc` / `~/.bashrc`.
- **Per-CLI session** (takes effect immediately; no daemon round-trip):
  ```bash
  RECALL_HOOK_INJECT_PROMPT=true claude
  ```
- **Daemon-wide** (affects hooks invoked through the daemon transport only): edit `~/Library/LaunchAgents/com.recall.daemon.plist` under `EnvironmentVariables`, then `recall daemon restart`.

## LLM-assisted memory maintenance

Recall enqueues maintenance tasks (refine candidates, merge near-duplicates, summarize histories, etc.) as you use it. There are two ways those tasks get executed:

### Path 1 — Daemon-owned dispatcher (recommended)

Give Recall an API key and it will run maintenance itself on a schedule, with no live agent session required.

1. Store a key in the macOS Keychain under service `com.recall.llm`:
   ```bash
   recall maintenance credentials set openai sk-...
   # or:
   recall maintenance credentials set anthropic sk-ant-...
   ```
   Non-macOS platforms fall back to `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` env vars.
2. Verify:
   ```bash
   recall maintenance credentials
   # openai     keychain sk-p…abcd
   ```
3. Trigger once manually to sanity-check (uses the configured key, calls the LLM):
   ```bash
   recall maintenance dispatch --dry-run          # lists what would run
   recall maintenance dispatch --max 3            # actually runs up to 3 tasks
   ```
4. Let the daemon take over. It runs the dispatcher on the cadence below (default: daily).

### Path 2 — Delegated fallback (no API key)

If no key is configured, the daemon still enqueues tasks and dispatches them to zero. Instead, the pending backlog surfaces in the SessionStart context of the next agent session. The calling agent (your live Claude Code / Codex) picks a task up and runs it against its own LLM — no extra cost because that agent was already running.

### Dispatcher env vars

| Variable | Default | Effect |
|---|---|---|
| `RECALL_DISPATCHER_ENABLED` | `true` | Set to `false` to disable the daemon-owned dispatcher (delegated path still works). |
| `RECALL_DISPATCHER_INTERVAL_SECONDS` | `86400` | Seconds between dispatcher ticks. Daily by default. |
| `RECALL_DISPATCHER_MAX_TASKS_PER_RUN` | `5` | Max tasks per tick. Floor on memory_maintenance_tasks churn. |
| `OPENAI_API_KEY` | — | Fallback when Keychain is unavailable or `recall maintenance credentials set openai` hasn't been run. |
| `ANTHROPIC_API_KEY` | — | Same, for Anthropic. When both providers have keys, the dispatcher prefers Anthropic. |

### Observability

```bash
recall maintenance usage                       # tokens + $ estimate, last 30 days
recall maintenance usage --since 2026-04-01    # custom window
recall maintenance usage --json                # machine-readable
recall maintenance stats                       # task backlog counts
recall maintenance list                        # pending tasks
```

Every LLM call the dispatcher makes lands in the `llm_usage` table with provider, model, task kind, tokens, cost estimate, duration, and ok/error. No row is written when the dispatcher has nothing to run or no API key is configured.

### Clearing a key

```bash
recall maintenance credentials clear openai
```

## General daemon env vars

Set under `EnvironmentVariables` in `~/Library/LaunchAgents/com.recall.daemon.plist`, then `recall daemon restart`.

| Variable | Default | Effect |
|---|---|---|
| `RECALL_PORT` | `7890` | HTTP port the daemon listens on. |
| `RECALL_DATA_DIR` | `~/.recall` | Where the SQLite DB, models cache, and logs live. |
| `RECALL_MAINTENANCE_ENABLED` | `true` | Set to `false` to stop the non-LLM maintenance loop (prune, compact, promote-candidates, SQLite housekeeping). |
| `RECALL_MAINTENANCE_INTERVAL_SECONDS` | `300` | Interval for the non-LLM maintenance loop. |
| `RECALL_MAINTENANCE_LLM_DISABLED` | `false` | Set to `true` to stop enqueuing LLM-needing tasks. |
| `RECALL_EMBEDDINGS_DISABLED` | `false` | Set to `true` to skip embedding generation entirely (hybrid retrieval still works with FTS-only ranking). |

## Verification

```bash
recall doctor              # full state snapshot (DB, embeddings, launchd, installed hooks per agent)
recall doctor --fix        # install missing MCP/hooks for any detected CLI
recall doctor --json       # machine-readable; contains `upgrade.available` for app launch probes
```

A healthy setup shows all detected agents as `mcp:ok hooks:ok` and — if you've set an API key — at least one successful entry under `recall maintenance usage`.

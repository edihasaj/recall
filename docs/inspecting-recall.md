---
summary: "How to inspect the installed Recall app, daemon, MCP wiring, logs, and the current production setup."
read_when:
  - Checking whether Recall.app or the bundled daemon is healthy.
  - Verifying Codex/Claude MCP integration.
  - Debugging crashes, launchd issues, or missing memory writes.
---

# Inspecting Recall

## Current Setup

- Production app: `/Applications/Recall.app`
- LaunchAgent label: `com.recall.daemon`
- Default daemon URL: `http://localhost:7890`
- Data dir: `~/.recall`
- Logs:
  - `~/.recall/logs/daemon.stdout.log`
  - `~/.recall/logs/daemon.stderr.log`
- Codex MCP config: `~/.codex/config.toml`
- Claude MCP config: `~/.claude/settings.json`

## What Was Shipped

- Recall is now a macOS app bundle, not just repo-local dev scripts.
- The app embeds its own Node runtime plus Recall runtime files.
- The app manages the bundled daemon through launchd.
- Recall MCP is configured globally for Codex and Claude.
- `.recall/context.md` remains optional export/fallback only; MCP is the primary path.
- Global `agent-scripts` guidance now tells agents to:
  - query Recall MCP before repo-specific assumptions
  - report corrections/review feedback back to Recall MCP

## Quick Health Checks

Check daemon health:

```bash
curl -s http://localhost:7890/health
```

Check launchd status via the bundled runtime:

```bash
/Applications/Recall.app/Contents/Resources/Runtime/bin/node \
  /Applications/Recall.app/Contents/Resources/Runtime/dist/cli.js daemon status
```

Check the listener:

```bash
lsof -nP -iTCP:7890 -sTCP:LISTEN
```

## Open Logs

Tail daemon logs:

```bash
tail -f ~/.recall/logs/daemon.stdout.log ~/.recall/logs/daemon.stderr.log
```

Open the data folder:

```bash
open ~/.recall
open ~/.recall/logs
```

## Crash Reports

Find Recall.app crash reports:

```bash
ls -t ~/Library/Logs/DiagnosticReports/Recall* | head
```

Open the newest crash report:

```bash
open "$(ls -t ~/Library/Logs/DiagnosticReports/Recall* | head -n 1)"
```

## Inspect MCP Wiring

Codex:

```bash
codex mcp get recall
```

Claude:

```bash
claude mcp get recall
```

Direct config grep:

```bash
rg -n "mcp_servers.recall|Runtime/bin/node|dist/mcp.js" ~/.codex/config.toml
rg -n '"mcpServers"|dist/mcp.js|Runtime/bin/node' ~/.claude/settings.json
```

Inspect setup planning / uninstall:

```bash
recall setup --dry-run
recall setup --scope project --dry-run
recall setup --uninstall-hooks --dry-run
```

Inspect hook telemetry:

```bash
recall hook stats
recall hook stats --agent claude-code
recall hook stats --json
```

## Inspect Stored Memory

List known repos:

```bash
recall repos
```

List memories for one repo:

```bash
recall list -r owner/repo
```

Recent activity:

```bash
recall activity -n 20
recall sessions -n 20
```

HTTP activity:

```bash
curl -s 'http://localhost:7890/activity?limit=20'
curl -s 'http://localhost:7890/sessions?limit=20'
```

## Embeddings

Recall now runs local embeddings by default. Useful overrides:

```bash
RECALL_EMBEDDING_PROVIDER=multilingual-e5
RECALL_EMBEDDING_DIMS=384
RECALL_EMBEDDINGS_DISABLED=true
```

Quick checks:

```bash
recall doctor
recall embeddings setup
recall embeddings info
recall embeddings verify
recall search -r owner/repo "pnpm"
```

## How Memory Writes Happen

Read path:

- `recall_query`

Write path:

- `recall_report_correction`
- `recall_capture_correction`
- `recall_report_review`
- `recall_signal_outcome`
- `recall_session_end`

So Recall memory improves only when the agent actually calls those MCP tools.

## If Something Breaks

1. Confirm `/Applications/Recall.app` exists.
2. Confirm launchd points at the app-bundled runtime, not repo-local dev paths.
3. Check `curl -s http://localhost:7890/health`.
4. Check daemon logs in `~/.recall/logs/`.
5. Check MCP config with `codex mcp get recall` / `claude mcp get recall`.
6. Check crash reports in `~/Library/Logs/DiagnosticReports/Recall*`.

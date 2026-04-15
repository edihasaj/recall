# Recall

Cross-tool coding memory + instruction compiler.

## Install

```bash
cd ~/Projects/recall
npm install
npm run build
npm link
```

## Production App

Build the macOS app bundle:

```bash
npm run build:app
```

Install it into `/Applications`:

```bash
npm run install:app
```

The app embeds its own Node runtime plus Recall `dist/`, `drizzle/`, and `node_modules/`, then manages the bundled daemon via launchd.

Configure local MCP clients against the installed app:

```bash
recall setup local
```

## First Run

Initialize DB:

```bash
recall init
```

Scan a real repo:

```bash
recall scan ~/Projects/some-repo
recall list
recall publish ~/Projects/some-repo
```

If an unseen repo is later queried through the daemon or MCP, Recall now tries a lazy one-time bootstrap by resolving the local clone and scanning just that repo.
Recall can also publish repo-local context into `.recall/context.md`, but the primary agent integration should be Recall MCP.

Inspect quality / health / injection pack:

```bash
recall quality -r owner/repo
recall health -r owner/repo
recall compile -r owner/repo
recall compile -r owner/repo --query "pytest -q" --include-candidates
```

Bootstrap local embeddings and the derived sqlite-vec index:

```bash
RECALL_EMBEDDINGS_ENABLED=true OPENAI_API_KEY=... recall embeddings bootstrap
recall embeddings verify
recall embeddings rebuild-index
recall search -r owner/repo "pnpm"
```

Daemon maintenance runs in-process on a timer.

Useful env vars:

```bash
RECALL_MAINTENANCE_INTERVAL_SECONDS=300
RECALL_ACTIVITY_RETENTION_DAYS=90
RECALL_FEEDBACK_RETENTION_DAYS=180
RECALL_SIGNAL_RETENTION_DAYS=180
RECALL_SQLITE_VACUUM_ENABLED=true
RECALL_SQLITE_VACUUM_MIN_FREE_PAGES=100
RECALL_SQLITE_VACUUM_MIN_FREE_RATIO=0.1
```

Inspect rolled-up session history:

```bash
recall history list -r owner/repo
recall history search -r owner/repo "pnpm"
```

Run retrieval eval fixtures:

```bash
recall eval retrieval --file docs/retrieval-eval.example.json
recall eval retrieval --file docs/retrieval-eval.example.json --json
recall eval retrieval --file docs/retrieval-eval.recall.json
recall eval retrieval --file docs/retrieval-eval.recall-hybrid.json
```

## Teach It

Add a correction:

```bash
recall correct -r owner/repo "don't use npm, use pnpm"
recall list -r owner/repo
```

Confirm a memory manually:

```bash
recall confirm <memory-id>
```

Report review feedback:

```bash
recall review -r owner/repo "review said use error boundaries"
```

## Quality Model

`recall quality` shows:

- stage: `cold | growing | mature`
- quality score
- repeat sessions needed before promotion
- compile confidence threshold
- dedup similarity threshold

Behavior:

- cold repos learn faster
- mature repos need more repeat evidence
- noisy repos inject less aggressively

## Daemon

Start HTTP daemon:

```bash
node dist/daemon.js
```

Install as a macOS user service with `launchd`:

```bash
recall daemon install
recall daemon status
```

Useful service commands:

```bash
recall daemon start
recall daemon stop
recall daemon uninstall
```

Default URL:

```text
http://localhost:7890
```

Useful endpoints:

```bash
curl -s 'http://localhost:7890/quality?repo=owner/repo'
curl -s -X POST http://localhost:7890/compile \
  -H 'Content-Type: application/json' \
  -d '{"repo":"owner/repo"}'

curl -s -X POST http://localhost:7890/correct \
  -H 'Content-Type: application/json' \
  -d '{"repo":"owner/repo","session_id":"s1","text":"don'\''t use npm, use pnpm"}'
```

Session collector endpoints:

```bash
curl -s -X POST http://localhost:7890/session/start \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"codex-1","client":"codex","repo_path":"'"$PWD"'"}'

curl -s -X POST http://localhost:7890/session/end \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"codex-1","client":"codex","repo_path":"'"$PWD"'","payload":{"exit_code":0}}'
```

Optional repo-local context artifact:

```bash
recall publish .
cat .recall/context.md
```

## Claude Code MCP

Add to Claude Code MCP config:

```json
{
  "mcpServers": {
    "recall": {
      "command": "node",
      "args": ["/Users/edi/Projects/recall/dist/mcp.js"]
    }
  }
}
```

Useful MCP tools:

- `recall_query`
- `recall_report_correction`
- `recall_report_review`
- `recall_quality`
- `recall_list`
- `recall_confirm`

## Session Wrappers

Use the thin wrappers in `scripts/` if you want Recall to auto-learn from session starts before retrieval is useful:

```bash
scripts/recall-codex
scripts/recall-claude
```

They:

- send `/session/start` with the current git root or `pwd`
- let the real client run normally
- send `/session/end` with the final exit code

Override targets if needed:

```bash
RECALL_CODEX_BIN=/path/to/codex scripts/recall-codex
RECALL_CLAUDE_BIN=/path/to/claude scripts/recall-claude
RECALL_DAEMON_URL=http://localhost:7890 scripts/recall-codex
```

## MCP First

Recommended production pattern:

- run Recall locally via `/Applications/Recall.app`
- let agents query/live-report through Recall MCP
- treat `.recall/context.md` as optional export/fallback, not the primary path

## Fast Test Loop

```bash
recall init
recall scan ~/Projects/some-real-repo
recall quality -r owner/repo
recall compile -r owner/repo
recall correct -r owner/repo "don't use npm, use pnpm"
recall list -r owner/repo
```

If you want repeated-session promotion testing, use the daemon `/correct` endpoint with different `session_id` values.

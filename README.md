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

Configure local agent runtimes against the installed app. `recall setup --yes` wires MCP and lifecycle hooks for supported detected runtimes so memory injection does not depend on the model choosing to call `query`:

```bash
recall setup --yes                       # shared MCP + hooks for detected runtimes
recall setup --scope project --yes       # add project-scoped hooks to the current repo
recall setup --uninstall-hooks --yes     # remove Recall-managed hooks
```

By default the hooks inject repo memory once at `SessionStart` (minimal format) and stay silent on every subsequent `UserPromptSubmit`. To re-enable per-prompt injection or wire provider credentials so the daemon can run memory maintenance on a schedule, see [docs/configuration.md](docs/configuration.md).

Install + setup behavior:

- Routine app launch, daemon start, and daemon restart are non-mutating for agent integrations. They do not re-add hooks or repo instruction files after you remove them.
- Memory "rethinking": when provider credentials are stored, the daemon runs the dispatcher daily (tunable via `RECALL_DISPATCHER_INTERVAL_SECONDS`) to refine/merge/summarize memories. Use `recall maintenance credentials --help` for provider-specific fields. Observability: `recall maintenance usage`, `recall maintenance stats`. Without a key, pending tasks surface via SessionStart for the live agent to claim.
- `recall doctor` checks install state; `recall doctor --fix` or `recall setup --yes` wires MCP + hooks for supported agent runtimes.
- Repo-local `.recall/context.md` is an optional export/fallback, not the primary integration.

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
Recall can also publish repo-local context into `.recall/context.md`; treat it as an optional export/fallback, not the primary agent integration.
Bootstrap now keeps operational commands hot and leaves softer scan facts as candidates or drops them during maintenance cleanup.

Inspect quality / health / injection pack:

```bash
recall quality -r owner/repo
recall health -r owner/repo
recall compile -r owner/repo
recall compile -r owner/repo --query "pytest -q" --include-candidates
```

Bootstrap local embeddings and the derived sqlite-vec index:

```bash
recall doctor
recall embeddings setup
recall embeddings info
recall embeddings bootstrap
recall embeddings verify
recall embeddings rebuild-index
recall search -r owner/repo "pnpm"
```

Optional embedding env vars:

```bash
RECALL_EMBEDDING_PROVIDER=multilingual-e5
RECALL_EMBEDDING_DIMS=384
RECALL_EMBEDDINGS_DISABLED=true
```

Upgrade note:

- First launch after the local-embeddings upgrade resets Recall's local DB.
- Recall rescans discovered repos and rebuilds embeddings/indexes in the background.
- Recall.app now surfaces that setup progress while the daemon comes up.

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

Session history rolls up corrections, review feedback, compile observations,
and durable user decisions/directions from prompt activity.
Compiled context includes a small relevant history section so decisions can be
reused without promoting every prompt into a durable memory.
History injections are tracked separately from memory injections in
`recall maintenance quality`.

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

Inspect hook telemetry:

```bash
recall hook stats
recall hook stats --agent codex
recall hook stats --json
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

- `query`
- `report_correction`
- `capture_correction`
- `report_review`
- `signal_outcome`
- `session_end`
- `quality`
- `list`
- `confirm`

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

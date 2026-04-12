# Recall

Cross-tool coding memory + instruction compiler.

## Install

```bash
cd ~/Projects/recall
npm install
npm run build
npm link
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
```

If an unseen repo is later queried through the daemon or MCP, Recall now tries a lazy one-time bootstrap by resolving the local clone and scanning just that repo.

Inspect quality / health / injection pack:

```bash
recall quality -r owner/repo
recall health -r owner/repo
recall compile -r owner/repo
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

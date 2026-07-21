# Recall Testing Guide

All commands below assume:

```bash
cd ~/Projects/recall
nvm use
```

Use Node 22 for source tests. The macOS app embeds Node 22; running tests under
a different shell Node can trip `better-sqlite3` native ABI errors until
dependencies are reinstalled for that Node version.

When rebuilding the macOS app from a shell using a different Node, pass the app
runtime explicitly:

```bash
RECALL_NODE_PATH=/Applications/Recall.app/Contents/Resources/Runtime/bin/node npm run build:app
```

Use `recall` directly if it is on your PATH.

If not, use:

```bash
node dist/cli.js <command>
```

Example:

```bash
node dist/cli.js list -r edihasaj/recall
```

Do not do this in `zsh`:

```bash
CLI="node dist/cli.js"
$CLI list
```

That gets treated like one filename.

## 1. Check daemon

```bash
recall daemon status
curl -s http://localhost:7890/health
```

Expected health response:

```json
{"status":"ok","version":"0.3.0"}
```

## 2. List everything in Recall

Show every memory in the DB:

```bash
recall list
```

Show only one repo:

```bash
recall list -r edihasaj/recall
```

Show only active or candidate memories:

```bash
recall list -r edihasaj/recall -s active
recall list -r edihasaj/recall -s candidate
```

## 2a. Check session collector

Start and end a synthetic session from the current repo:

```bash
curl -s -X POST http://localhost:7890/session/start \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"manual-session-1\",\"client\":\"codex\",\"repo_path\":\"$PWD\"}"

curl -s -X POST http://localhost:7890/session/end \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"manual-session-1\",\"client\":\"codex\",\"repo_path\":\"$PWD\",\"payload\":{\"exit_code\":0}}"

recall activity --session manual-session-1
```

Optional repo-local context artifact check:

```bash
recall publish .
test -f .recall/context.md && sed -n '1,40p' .recall/context.md
```

## 3. List all repos in the DB

Preferred:

```bash
recall repos
```

Raw SQLite fallback:

Default DB path:

```bash
sqlite3 ~/.recall/recall.db "select distinct repo from memories where repo is not null order by repo;"
```

If you use a custom data dir:

```bash
sqlite3 "$RECALL_DATA_DIR/recall.db" "select distinct repo from memories where repo is not null order by repo;"
```

## 4. Inspect one repo

Replace `owner/repo`:

```bash
recall quality -r owner/repo
recall health -r owner/repo
recall list -r owner/repo
recall compile -r owner/repo
```

HTTP equivalents:

```bash
curl -s "http://localhost:7890/quality?repo=owner/repo"
curl -s "http://localhost:7890/memories?repo=owner/repo"
curl -s -X POST http://localhost:7890/compile \
  -H 'Content-Type: application/json' \
  -d '{"repo":"owner/repo"}'
```

## 5. Test everything for every repo

This is the broadest quick check:

```bash
while IFS= read -r repo; do
  echo
  echo "=== $repo ==="
  recall quality -r "$repo"
  recall health -r "$repo"
  recall list -r "$repo"
  recall compile -r "$repo"
done < <(sqlite3 ~/.recall/recall.db "select distinct repo from memories where repo is not null order by repo;")
```

If that is too noisy, use this smaller loop:

```bash
while IFS= read -r repo; do
  echo
  echo "=== $repo ==="
  recall quality -r "$repo"
  recall compile -r "$repo"
done < <(sqlite3 ~/.recall/recall.db "select distinct repo from memories where repo is not null order by repo;")
```

## 6. Add a correction and verify it

CLI:

```bash
recall correct -r owner/repo "don't use npm, use pnpm"
recall list -r owner/repo
```

That uses the CLI session id, so it is fine for basic testing but not for distinct-session promotion testing.

## 7. Test repeatability properly

Use daemon calls with different `session_id` values:

```bash
curl -s -X POST http://localhost:7890/correct \
  -H 'Content-Type: application/json' \
  -d '{"repo":"owner/repo","session_id":"s1","text":"don'\''t use npm, use pnpm"}'

curl -s -X POST http://localhost:7890/correct \
  -H 'Content-Type: application/json' \
  -d '{"repo":"owner/repo","session_id":"s2","text":"don'\''t use npm, use pnpm"}'
```

Then verify:

```bash
recall list -r owner/repo
recall compile -r owner/repo
```

## 8. Confirm or reject a memory

Find the short id from `list`, then:

```bash
recall show <memory-id>
recall confirm <memory-id>
recall reject <memory-id>
```

## 9. Useful direct HTTP checks

List repo memories:

```bash
curl -s "http://localhost:7890/memories?repo=owner/repo"
```

Get one memory:

```bash
curl -s "http://localhost:7890/memory/<memory-id>"
```

See daemon quality directly:

```bash
curl -s "http://localhost:7890/quality?repo=owner/repo"
```

## 10. If SQLite binding breaks after pnpm install

Approve and rebuild native dependency:

```bash
pnpm approve-builds
pnpm rebuild better-sqlite3
```

Then retry:

```bash
recall list
```

## 11. If `recall` is not on PATH

Either run:

```bash
node dist/cli.js list
```

Or link it:

```bash
cd ~/Projects/recall
npm link
hash -r
recall daemon status
```

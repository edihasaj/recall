#!/usr/bin/env bash
#
# Record a short walkthrough of the Recall web UI for the README.
# Output: assets/demo.mp4 + assets/demo.gif (matching agentmemory's layout).
#
# Strategy:
#   1. Seed an isolated DB at ~/.recall-demo so the live ~/.recall is untouched.
#   2. Boot the daemon + webui against that DB.
#   3. Drive Chromium with Playwright, recording video as it walks the routes.
#   4. ffmpeg -> mp4 (h264) and -> gif (palette-tuned).
#
# Requires: node (>=22), ffmpeg, playwright (auto-installed via npx).
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${RECALL_DEMO_DATA_DIR:-$HOME/.recall-demo}"
SEED_COUNT="${RECALL_DEMO_SEED:-150}"
DAEMON_PORT="${RECALL_PORT:-7890}"
WEBUI_PORT="${RECALL_WEBUI_PORT:-7891}"
OUT_DIR="$ROOT/assets"
TMP_DIR="$(mktemp -d -t recall-demo-XXXX)"
trap 'rm -rf "$TMP_DIR"; cleanup' EXIT

DAEMON_PID=""
WEBUI_PID=""
cleanup() {
  [[ -n "$DAEMON_PID" ]] && kill "$DAEMON_PID" 2>/dev/null || true
  [[ -n "$WEBUI_PID"  ]] && kill "$WEBUI_PID"  2>/dev/null || true
}

command -v ffmpeg >/dev/null || { echo "ffmpeg required (brew install ffmpeg)"; exit 1; }

echo "→ build"
( cd "$ROOT" && npm run build >/dev/null )

echo "→ seed $SEED_COUNT memories into $DATA_DIR (reset)"
mkdir -p "$DATA_DIR"
RECALL_DATA_DIR="$DATA_DIR" \
  npx -y tsx "$ROOT/benchmark/seed.ts" \
    --count "$SEED_COUNT" --reset --data-dir "$DATA_DIR" \
  | tee "$TMP_DIR/seed.json"

echo "→ daemon :$DAEMON_PORT (foreground)"
RECALL_DATA_DIR="$DATA_DIR" RECALL_PORT="$DAEMON_PORT" \
  node "$ROOT/dist/daemon.js" >"$TMP_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!

echo "→ waiting for daemon"
for i in {1..30}; do
  curl -sf "http://localhost:$DAEMON_PORT/health" >/dev/null && break
  sleep 0.5
done

echo "→ webui :$WEBUI_PORT (via daemon)"
curl -sf -X POST "http://localhost:$DAEMON_PORT/webui/start" \
  -H 'content-type: application/json' \
  -d "{\"port\": $WEBUI_PORT, \"open\": false}" >/dev/null

for i in {1..30}; do
  curl -sf "http://localhost:$WEBUI_PORT/" >/dev/null && break
  sleep 0.5
done

echo "→ playwright record"
mkdir -p "$OUT_DIR"
WEBUI_URL="http://localhost:$WEBUI_PORT" \
RECORD_OUT="$TMP_DIR" \
  npx -y playwright@1 install --with-deps chromium >/dev/null 2>&1 || true
WEBUI_URL="http://localhost:$WEBUI_PORT" \
RECORD_OUT="$TMP_DIR" \
  npx -y -p playwright@1 node "$ROOT/scripts/record-demo.mjs"

# Playwright drops a .webm in $TMP_DIR/video.
WEBM="$(find "$TMP_DIR/video" -name '*.webm' | head -n1)"
[[ -z "$WEBM" ]] && { echo "no video produced"; exit 1; }

echo "→ ffmpeg → mp4"
ffmpeg -y -i "$WEBM" -movflags +faststart -pix_fmt yuv420p \
  -vf "scale=1280:-2:flags=lanczos" \
  -c:v libx264 -crf 23 -preset slow "$OUT_DIR/demo.mp4" >/dev/null 2>&1

echo "→ ffmpeg → gif (palette tuned)"
PAL="$TMP_DIR/palette.png"
ffmpeg -y -i "$WEBM" -vf "fps=12,scale=900:-2:flags=lanczos,palettegen=max_colors=128" "$PAL" >/dev/null 2>&1
ffmpeg -y -i "$WEBM" -i "$PAL" \
  -lavfi "fps=12,scale=900:-2:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5" \
  "$OUT_DIR/demo.gif" >/dev/null 2>&1

echo
echo "✓ $OUT_DIR/demo.mp4  ($(du -h "$OUT_DIR/demo.mp4" | cut -f1))"
echo "✓ $OUT_DIR/demo.gif  ($(du -h "$OUT_DIR/demo.gif" | cut -f1))"

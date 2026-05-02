#!/usr/bin/env bash
# Atomic install: stage the new bundle next to the live one, bounce the
# daemon, mv-swap, trash the old. Daemon downtime is one launchctl bounce
# (sub-second). Hooks during the bounce hit the self-healing fallback in
# `safeHookAction`, so host agents (Claude Code / Codex) never see a hard
# failure.
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target_path="/Applications/Recall.app"
staging_path="/Applications/Recall.app.next.$$"
backup_path="/Applications/Recall.app.old.$$"

app_path="$("$root_dir/scripts/build-app.sh" | tail -n 1)"

# Stage on the same volume as target so the rename below is atomic.
if [[ -e "$staging_path" ]]; then
  rm -rf "$staging_path"
fi
ditto "$app_path" "$staging_path"

# Stop the daemon *before* swapping so launchctl isn't holding a vnode on the
# bundle we're about to move out from under it. The CLI we invoke here is
# still the currently-installed one; that's fine, it exits before the swap.
if [[ -x "$target_path/Contents/Resources/Runtime/bin/node" ]]; then
  "$target_path/Contents/Resources/Runtime/bin/node" \
    "$target_path/Contents/Resources/Runtime/dist/cli.js" \
    daemon stop || true
fi

# Atomic swap: live -> backup, staging -> live.
if [[ -e "$target_path" ]]; then
  mv -f "$target_path" "$backup_path"
fi
mv "$staging_path" "$target_path"

# Restart from the freshly installed bundle.
"$target_path/Contents/Resources/Runtime/bin/node" \
  "$target_path/Contents/Resources/Runtime/dist/cli.js" \
  daemon start || true

# Best-effort GUI relaunch + async cleanup of the old bundle.
open "$target_path" || true
if [[ -e "$backup_path" ]]; then
  trash "$backup_path" || rm -rf "$backup_path"
fi

echo "Installed $target_path"

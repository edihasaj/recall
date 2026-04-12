#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_path="$("$root_dir/scripts/build-app.sh" | tail -n 1)"
target_path="/Applications/Recall.app"

if [[ -e "$target_path" ]]; then
  trash "$target_path"
fi

ditto "$app_path" "$target_path"
open "$target_path"
echo "Installed $target_path"

#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! -d "$1" ]]; then
  echo "usage: $0 <signed-app-directory>" >&2
  exit 64
fi

app_path="$1"

# A notarization ticket may already be present when a release job is resumed.
# Avoid a needless staple request in that case.
if xcrun stapler validate "$app_path"; then
  exit 0
fi

for attempt in 1 2 3 4 5; do
  if xcrun stapler staple "$app_path" && xcrun stapler validate "$app_path"; then
    exit 0
  fi

  if [[ "$attempt" -lt 5 ]]; then
    sleep 15
  fi
done

# The final validation is the release decision. Never report success merely
# because stapler accepted a request.
xcrun stapler validate "$app_path"

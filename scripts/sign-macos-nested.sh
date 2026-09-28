#!/usr/bin/env bash
# Sign the native runtime before signing Recall.app itself.
set -euo pipefail

app_path="${1:?usage: sign-macos-nested.sh Recall.app identity}"
identity="${2:?usage: sign-macos-nested.sh Recall.app identity}"
runtime="$app_path/Contents/Resources/Runtime"
node="$runtime/bin/node"
entitlements="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/macos/RecallApp/node-entitlements.plist"

test -x "$node"
test -f "$entitlements"

count=0
while IFS= read -r -d '' binary; do
  [[ "$(file -b "$binary")" == *Mach-O* ]] || continue
  args=(--force --timestamp --options runtime --sign "$identity")
  if [[ "$binary" == "$node" ]]; then
    args+=(--entitlements "$entitlements")
  fi
  codesign "${args[@]}" "$binary"
  codesign --verify --strict "$binary"
  ((count += 1))
done < <(find "$runtime" -type f \( -name '*.node' -o -name '*.dylib' -o -name '*.so' -o -perm -111 \) -print0)

if ((count == 0)); then
  echo "No native runtime binaries were signed" >&2
  exit 1
fi
echo "Signed $count native runtime binaries"

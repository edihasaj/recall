#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
required_node_version="$(tr -d '[:space:]' < "$root/.nvmrc")"
export PATH="$HOME/.local/share/node/node-v$required_node_version-darwin-arm64/bin:$PATH"
output="${RECALL_MAS_OUTPUT:-$root/build/mac-app-store}"
stage="$root/macos/RecallApp/Generated/StoreRuntime"
configuration="${RECALL_MAS_CONFIGURATION:-Release}"
runtime_node="${RECALL_NODE_PATH:-/Applications/Recall.app/Contents/Resources/Runtime/bin/node}"
keychain="${RECALL_MAS_KEYCHAIN:-$HOME/Library/Keychains/chirpgo-mas.keychain-db}"
if [[ "$configuration" == Debug ]]; then
  identity="D0B9C24A620EF2C66807AE6EC542769A80AE5376"
else
  identity="553F6C5E674407B3CE715A609A6488D4CEC43278"
fi

cd "$root"
if [[ "${RECALL_MAS_SKIP_STAGE:-0}" != 1 ]]; then
  VITE_RECALL_DAEMON_URL=http://127.0.0.1:7892 npm run build
  mkdir -p "$stage/bin"
  if [[ ! -x "$runtime_node" ]] || [[ "$("$runtime_node" -p 'process.versions.node.split(".")[0]')" != "${required_node_version%%.*}" ]]; then
    echo "Set RECALL_NODE_PATH to the standalone Node $required_node_version executable from .nvmrc." >&2
    exit 1
  fi
  if [[ "$("$runtime_node" -p 'process.versions.node')" != "$required_node_version" ]]; then
    echo "Set RECALL_NODE_PATH to the standalone patched Node $required_node_version from .nvmrc." >&2
    exit 1
  fi
  if otool -L "$runtime_node" | rg -q '@rpath/libnode|/opt/homebrew'; then
    echo "The selected Node executable depends on Homebrew libraries; use a standalone build." >&2
    exit 1
  fi
  if [[ -f "$stage/bin/node" ]]; then chmod u+w "$stage/bin/node"; fi
  cp "$runtime_node" "$stage/bin/node"
  rsync -a --delete --exclude=cli.js --exclude=cli.js.map \
    --exclude=mcp.js --exclude=mcp.js.map --exclude=sync-server.js \
    --exclude=sync-server.js.map dist/ "$stage/dist/"
  rsync -a --delete drizzle/ "$stage/drizzle/"
  cp package.json package-lock.json "$stage/"
  npm ci --omit=dev --prefix "$stage" --no-audit --no-fund
fi

# Sign every bundled native library before signing the inheriting Node executable.
uv run python - "$stage" "$identity" "$keychain" <<'PY'
from pathlib import Path
import subprocess
import sys

stage, identity, keychain = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
magic = {b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe",
         b"\xfe\xed\xfa\xcf", b"\xbe\xba\xfe\xca"}
for path in stage.rglob("*"):
    if not path.is_file() or path.is_symlink() or path == stage / "bin/node":
        continue
    with path.open("rb") as stream:
        is_native = stream.read(4) in magic
    if is_native:
        subprocess.run(["codesign", "--force", "--sign", identity, "--keychain", keychain,
                        "--options", "runtime", str(path)], check=True)
PY
codesign --force --sign "$identity" --keychain "$keychain" --options runtime \
  --entitlements macos/RecallApp/AppStore/Node.entitlements "$stage/bin/node"
for entry in cli.js cli.js.map mcp.js mcp.js.map sync-server.js sync-server.js.map; do
  if [[ -f "$stage/dist/$entry" ]]; then trash "$stage/dist/$entry"; fi
done
xcodegen generate --spec macos/RecallApp/project-app-store.yml
xcodebuild -project macos/RecallApp/RecallAppStore.xcodeproj -scheme Recall \
  -configuration "$configuration" -destination generic/platform=macOS \
  -derivedDataPath "$output/derived" -archivePath "$output/Recall.xcarchive" \
  OTHER_CODE_SIGN_FLAGS="--keychain $keychain" archive
app="$output/Recall.xcarchive/Products/Applications/Recall.app"
codesign --verify --deep --strict "$app"
if [[ "$configuration" == Release ]]; then
  productbuild --component "$app" /Applications \
    --sign "3rd Party Mac Developer Installer: Applifyer, LLC (T8J48M4QVY)" \
    --keychain "$keychain" "$output/Recall.pkg"
  pkgutil --check-signature "$output/Recall.pkg"
fi
printf 'Store archive: %s\n' "$app"

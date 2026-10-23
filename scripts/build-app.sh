#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_dir="$root_dir/macos/RecallApp"
runtime_dir="$app_dir/Generated/Runtime"
derived_data="$root_dir/build/DerivedData.noindex"
project_path="$app_dir/RecallApp.xcodeproj"
node_bin="${RECALL_NODE_PATH:-}"
required_node_version="$(tr -d '[:space:]' < "$root_dir/.nvmrc")"
required_node_major="${required_node_version%%.*}"

if [[ -z "$node_bin" ]]; then
  candidate="$(command -v node || true)"
  if [[ -n "$candidate" && "$("$candidate" -p "process.versions.node.split('.')[0]")" == "$required_node_major" ]]; then
    node_bin="$candidate"
  fi
fi
if [[ -z "$node_bin" ]]; then
  for candidate in "$HOME"/.nvm/versions/node/v"$required_node_major".*/bin/node "$HOME"/.local/share/node/node-v"$required_node_version"-darwin-*/bin/node; do
    [[ -x "$candidate" ]] && node_bin="$candidate"
  done
fi
if [[ -z "$node_bin" ]]; then
  echo "Recall.app build needs the standalone Node $required_node_version from .nvmrc; set RECALL_NODE_PATH." >&2
  exit 1
fi

node_major="$("$node_bin" -p "process.versions.node.split('.')[0]")"
if [[ "$node_major" != "$required_node_major" ]]; then
  echo "Recall.app must embed Node $required_node_major; got $("$node_bin" -v) at $node_bin" >&2
  echo "Set RECALL_NODE_PATH to a Node $required_node_major binary or run nvm use." >&2
  exit 1
fi

actual_node_version="$("$node_bin" -p 'process.versions.node')"
if [[ "$actual_node_version" != "$required_node_version" ]]; then
  echo "Recall.app must embed the pinned patched Node $required_node_version; got $actual_node_version." >&2
  echo "Set RECALL_NODE_PATH to the standalone runtime specified by .nvmrc." >&2
  exit 1
fi

cd "$root_dir"

# Xcode writes a full Recall.app into build/DerivedData.noindex. Spotlight indexes it,
# LaunchServices then registers it as a *second* Recall install, and macOS
# starts offering the repo build in Open With / Spotlight alongside the real
# one in /Applications. A .metadata_never_index marker excludes the whole
# build tree from indexing, so local builds stay invisible to LaunchServices.
mkdir -p "$root_dir/build"
touch "$root_dir/build/.metadata_never_index"

rm -rf "$root_dir/dist"
npm run build

rm -rf "$runtime_dir"
mkdir -p "$runtime_dir/bin"

cp "$node_bin" "$runtime_dir/bin/node"
chmod +x "$runtime_dir/bin/node"
cp "$root_dir/scripts/recall-app" "$runtime_dir/bin/recall"
chmod +x "$runtime_dir/bin/recall"
cp "$root_dir/scripts/recall-update-macos" "$runtime_dir/bin/recall-update-macos"
chmod +x "$runtime_dir/bin/recall-update-macos"
cp "$root_dir/scripts/recall-update-direct-macos" "$runtime_dir/bin/recall-update-direct-macos"
chmod +x "$runtime_dir/bin/recall-update-direct-macos"

rsync -a "$root_dir/dist/" "$runtime_dir/dist/"
rsync -a "$root_dir/drizzle/" "$runtime_dir/drizzle/"
rsync -a "$root_dir/node_modules/" "$runtime_dir/node_modules/"
cp "$root_dir/package.json" "$runtime_dir/package.json"
cp "$root_dir/package-lock.json" "$runtime_dir/package-lock.json"

# The developer shell may run a different Node than the embedded runtime. Always
# rebuild ABI-bound modules inside the staged runtime with the binary that will
# load them; never trust the workspace binding copied above.
env PATH="$(dirname "$node_bin"):$PATH" \
  "$node_bin" "$(command -v npm)" rebuild better-sqlite3 \
  --prefix "$runtime_dir" \
  --no-audit \
  --no-fund
"$runtime_dir/bin/node" -e \
  "const Database = require('$runtime_dir/node_modules/better-sqlite3'); const db = new Database(':memory:'); db.close();"

xcodegen generate --spec "$app_dir/project.yml"

pkg_version="$("$node_bin" -p "require('$root_dir/package.json').version")"
build_number="${RECALL_BUILD_NUMBER:-${GITHUB_RUN_NUMBER:-1}}"

xcodebuild \
  -project "$project_path" \
  -scheme Recall \
  -configuration Release \
  -derivedDataPath "$derived_data" \
  CODE_SIGNING_ALLOWED=NO \
  MARKETING_VERSION="$pkg_version" \
  CURRENT_PROJECT_VERSION="$build_number" \
  build

app_path="$derived_data/Build/Products/Release/Recall.app"
# --delete drops stale chunks/files left behind from prior incremental
# xcodebuild runs (tsup chunk hashes change every build).
rm -rf "$app_path/Contents/Resources/Runtime"
mkdir -p "$app_path/Contents/Resources/Runtime"
rsync -a --delete "$runtime_dir/" "$app_path/Contents/Resources/Runtime/"

# Belt and braces with .metadata_never_index above: that marker stops future
# Spotlight indexing but does not remove an entry LaunchServices already has,
# and Xcode can register a freshly built bundle without Spotlight's help.
# Unregister the build product explicitly so only /Applications/Recall.app is
# ever offered in Spotlight and Open With. Never touches the files.
lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -x "$lsregister" ]]; then
  "$lsregister" -u "$app_path" >/dev/null 2>&1 || true
fi

echo "$app_path"

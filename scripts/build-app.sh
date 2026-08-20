#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_dir="$root_dir/macos/RecallApp"
runtime_dir="$app_dir/Generated/Runtime"
derived_data="$root_dir/build/DerivedData"
project_path="$app_dir/RecallApp.xcodeproj"
node_bin="${RECALL_NODE_PATH:-}"

if [[ -z "$node_bin" && -x "/Applications/Recall.app/Contents/Resources/Runtime/bin/node" ]]; then
  node_bin="/Applications/Recall.app/Contents/Resources/Runtime/bin/node"
fi
if [[ -z "$node_bin" ]]; then
  node_bin="$(command -v node)"
fi

node_major="$("$node_bin" -p "process.versions.node.split('.')[0]")"
if [[ "$node_major" != "22" ]]; then
  echo "Recall.app must embed Node 22; got $("$node_bin" -v) at $node_bin" >&2
  echo "Set RECALL_NODE_PATH to a Node 22 binary or run nvm use." >&2
  exit 1
fi

cd "$root_dir"

# Xcode writes a full Recall.app into build/DerivedData. Spotlight indexes it,
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

rsync -a "$root_dir/dist/" "$runtime_dir/dist/"
rsync -a "$root_dir/drizzle/" "$runtime_dir/drizzle/"
rsync -a "$root_dir/node_modules/" "$runtime_dir/node_modules/"
cp "$root_dir/package.json" "$runtime_dir/package.json"
cp "$root_dir/package-lock.json" "$runtime_dir/package-lock.json"

# The developer shell may run a newer Node than the embedded Node 22. Always
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
echo "$app_path"

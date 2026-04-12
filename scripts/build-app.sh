#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_dir="$root_dir/macos/RecallApp"
runtime_dir="$app_dir/Generated/Runtime"
derived_data="$root_dir/build/DerivedData"
project_path="$app_dir/RecallApp.xcodeproj"

cd "$root_dir"
npm run build

rm -rf "$runtime_dir"
mkdir -p "$runtime_dir/bin"

cp "$(command -v node)" "$runtime_dir/bin/node"
chmod +x "$runtime_dir/bin/node"

rsync -a "$root_dir/dist/" "$runtime_dir/dist/"
rsync -a "$root_dir/drizzle/" "$runtime_dir/drizzle/"
rsync -a "$root_dir/node_modules/" "$runtime_dir/node_modules/"
cp "$root_dir/package.json" "$runtime_dir/package.json"

xcodegen generate --spec "$app_dir/project.yml"
xcodebuild \
  -project "$project_path" \
  -scheme Recall \
  -configuration Release \
  -derivedDataPath "$derived_data" \
  CODE_SIGNING_ALLOWED=NO \
  build

app_path="$derived_data/Build/Products/Release/Recall.app"
mkdir -p "$app_path/Contents/Resources/Runtime"
rsync -a "$runtime_dir/" "$app_path/Contents/Resources/Runtime/"
echo "$app_path"

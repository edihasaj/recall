#!/usr/bin/env bash
# Cross-compile the windows tray app from any host with Go. No CGO, so a
# Mac builds the .exe with no toolchain dance. Outputs land in dist-windows/.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist-windows
cd windows/tray
GOOS=windows GOARCH=amd64 go build -ldflags "-H windowsgui -s -w" -o ../../dist-windows/recall-tray.exe ./cmd/recall-tray
GOOS=windows GOARCH=arm64 go build -ldflags "-H windowsgui -s -w" -o ../../dist-windows/recall-tray-arm64.exe ./cmd/recall-tray
echo "wrote: dist-windows/recall-tray.exe (amd64), dist-windows/recall-tray-arm64.exe"

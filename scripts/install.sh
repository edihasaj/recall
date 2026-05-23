#!/usr/bin/env bash
# Recall — macOS / Linux installer
#
# Usage:
#   curl -fsSL https://recallmemory.dev/install.sh | bash
#
# What it does:
#   1. Verifies Node.js >= 20 is on PATH (offers a hint if not).
#   2. Installs the @edihasaj/recall CLI globally via npm.
#   3. Runs `recall setup --yes` to wire MCP + lifecycle hooks for
#      detected agent runtimes.
#   4. Offers to install the background daemon as a user service
#      (launchd on macOS, systemd --user on Linux).
#
# On macOS, you can also use the menu-bar app:
#   brew install --cask edihasaj/tap/recall

set -euo pipefail

color_step()  { printf '\033[36m==> %s\033[0m\n' "$*"; }
color_ok()    { printf '\033[32m    %s\033[0m\n' "$*"; }
color_warn()  { printf '\033[33m    %s\033[0m\n' "$*"; }
color_fail()  { printf '\033[31m!!! %s\033[0m\n' "$*"; exit 1; }

uname_os=$(uname -s)
case "$uname_os" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *)      color_fail "Unsupported OS: $uname_os (this script handles macOS + Linux; use install.ps1 on Windows)";;
esac

uname_arch=$(uname -m)
case "$uname_arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=amd64 ;;
  *)             color_fail "Unsupported architecture: $uname_arch";;
esac

echo
printf '\033[35mRecall installer\033[0m\n'
printf '\033[35m----------------\033[0m\n'
color_ok "Detected: $os-$arch"

if ! command -v node >/dev/null 2>&1; then
  color_warn "Node.js not found on PATH."
  if [ "$os" = "darwin" ]; then
    echo "    Install it with:  brew install node"
  else
    echo "    Install Node.js >= 20 from https://nodejs.org or your distro's package manager."
  fi
  color_fail "Re-run this installer once Node is installed."
fi

node_ver=$(node --version | sed 's/^v//')
node_major=${node_ver%%.*}
if [ "$node_major" -lt 20 ]; then
  color_fail "Node.js $node_ver is too old; need >= 20."
fi
color_ok "Node $node_ver detected"

if ! command -v npm >/dev/null 2>&1; then
  color_fail "npm not found (should ship with Node)."
fi

color_step "Installing @edihasaj/recall globally"
if ! npm install -g @edihasaj/recall; then
  color_fail "npm install failed. Check the output above."
fi
color_ok "CLI installed"

color_step "Wiring MCP + lifecycle hooks for detected agent runtimes"
if ! recall setup --yes; then
  color_warn "recall setup returned non-zero. Inspect with: recall doctor"
fi
color_ok "Setup done"

color_step "Verifying install"
recall doctor || color_warn "recall doctor reported issues — see output above."

echo
color_ok "Recall is installed."
if [ "$os" = "darwin" ]; then
  echo "    Prefer the menu-bar app? Install Recall.app via:"
  echo "      brew install --cask edihasaj/tap/recall"
  echo "    For the headless service: recall daemon install"
else
  echo "    Start the background service with:"
  echo "      recall daemon install"
  echo "    Logs: journalctl --user -u recall-daemon"
fi

# Recall — Windows installer (PowerShell)
#
# Usage:
#   irm https://recallmemory.dev/install.ps1 | iex
#
# What it does:
#   1. Verifies Node.js >=20 is on PATH (offers a winget hint if not).
#   2. Installs the @edihasaj/recall CLI globally via npm (provides the
#      daemon.js the tray supervises).
#   3. Downloads recall-tray-<arch>.exe into %LOCALAPPDATA%\Programs\Recall.
#   4. Registers the per-user Run-key entry so the tray launches at login.
#   5. Launches the tray right away.
#
# The tray supervises the daemon child (node dist/daemon.js) and exposes
# health + the local web dashboard.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RecallRepo    = 'edihasaj/recall'
$InstallDir    = Join-Path $env:LOCALAPPDATA 'Programs\Recall'
$TrayExeName   = 'recall-tray.exe'
$RunKeyPath    = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunKeyValue   = 'Recall'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    $msg" -ForegroundColor Yellow }
function Fail($msg)       { Write-Host "!!! $msg" -ForegroundColor Red; exit 1 }

function Get-Arch {
  switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { return 'amd64' }
    'ARM64' { return 'arm64' }
    default { Fail "Unsupported architecture: $($env:PROCESSOR_ARCHITECTURE). Recall ships arm64 and amd64." }
  }
}

function Test-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Warn2 'Node.js not found on PATH.'
    Write-Host  '    Install it with:  winget install OpenJS.NodeJS.LTS'
    Fail        'Re-run this installer after Node is installed.'
  }
  $ver = (& node --version) -replace '^v',''
  $major = [int]($ver.Split('.')[0])
  if ($major -lt 20) { Fail "Node.js $ver is too old; need >= 20." }
  Write-Ok "Node $ver detected"
}

function Install-Cli {
  Write-Step 'Installing @edihasaj/recall CLI (provides the daemon)'
  & npm install -g '@edihasaj/recall' | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail 'npm install failed' }
  Write-Ok 'CLI installed'
}

function Download-Tray($arch) {
  Write-Step "Downloading recall-tray-$arch.exe"
  $url = "https://github.com/$RecallRepo/releases/latest/download/recall-tray-$arch.exe"
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $dest = Join-Path $InstallDir $TrayExeName
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $dest
  } catch {
    Fail "Could not download $url`: $($_.Exception.Message)"
  }
  if (-not (Test-Path $dest) -or (Get-Item $dest).Length -lt 1MB) {
    Fail "Tray download looks corrupt: $dest"
  }
  Write-Ok "Installed $dest"
  return $dest
}

function Register-Autostart($exePath) {
  Write-Step 'Registering autostart (per-user Run key)'
  New-Item -Path $RunKeyPath -Force | Out-Null
  Set-ItemProperty -Path $RunKeyPath -Name $RunKeyValue -Value ('"' + $exePath + '"')
  Write-Ok "$RunKeyPath\$RunKeyValue set"
}

function Launch-Tray($exePath) {
  Write-Step 'Launching Recall tray'
  Start-Process -FilePath $exePath -WindowStyle Hidden
  Write-Ok 'Tray running — look for the Recall icon in the system tray'
}

Write-Host ''
Write-Host 'Recall installer' -ForegroundColor Magenta
Write-Host '----------------' -ForegroundColor Magenta

$arch = Get-Arch
Write-Ok "Architecture: win32-$arch"
Test-Node
Install-Cli
$tray = Download-Tray $arch
Register-Autostart $tray
Launch-Tray $tray

Write-Host ''
Write-Host 'Done. Right-click the Recall tray icon to open the dashboard or manage the daemon.' -ForegroundColor Green
Write-Host "Logs: $env:LOCALAPPDATA\Recall\tray.log (tray), $env:LOCALAPPDATA\Recall\daemon.log (daemon)"

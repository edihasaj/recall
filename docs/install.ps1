# Recall — Windows installer (PowerShell)
#
# Usage:
#   irm https://recallmemory.dev/install.ps1 | iex
#
# What it does:
#   1. Verifies Node.js >=22 is on PATH (offers a winget hint if not).
#   2. Installs the checksummed GitHub release package globally via npm
#      (provides the daemon.js the tray supervises).
#   3. Downloads recall-tray-<arch>.exe into %LOCALAPPDATA%\Programs\Recall.
#   4. Registers the per-user Run-key entry so the tray launches at login.
#   5. Launches the tray right away.
#
# An existing installation is backed up and stopped before files are replaced.
# The tray can pass -Version X.Y.Z -WaitForPid <pid> to hand off an update.
#
# The tray supervises the daemon child (node dist/daemon.js) and exposes
# health + the local web dashboard.

param(
  [ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [int]$WaitForPid = 0
)

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
function Fail($msg)       { Write-Host "!!! $msg" -ForegroundColor Red; throw $msg }

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
  if ($major -lt 22) { Fail "Node.js $ver is too old; need >= 22 (matches package.json engines)." }
  Write-Ok "Node $ver detected"
}

function Backup-Install($version, $work) {
  $dataDir = if ($env:RECALL_DATA_DIR) { $env:RECALL_DATA_DIR } else { Join-Path $env:USERPROFILE '.recall' }
  $dbPath = Join-Path $dataDir 'recall.db'
  $backup = Join-Path $dataDir ('backups\published-' + $version + '-' + (Get-Date -Format yyyyMMddTHHmmss))
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  if (-not (Test-Path $dbPath)) { return $backup }

  $globalRoot = (& npm root -g).Trim()
  if ($LASTEXITCODE -ne 0) { Fail 'Could not find the existing npm package for backup.' }
  $native = Join-Path $globalRoot '@edihasaj\recall\node_modules\better-sqlite3'
  if (-not (Test-Path $native)) { Fail 'Could not find SQLite support for a safe database backup.' }
  $helper = Join-Path $work 'backup.cjs'
  @'
const Database = require(process.argv[2]);
const db = new Database(process.argv[3]);
db.backup(process.argv[4]).then(() => db.close()).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
'@ | Set-Content -Path $helper
  & node $helper $native $dbPath (Join-Path $backup 'recall.db')
  if ($LASTEXITCODE -ne 0) { Fail 'Database backup failed; no files were updated.' }
  Write-Ok "Database backed up to $backup"
  return $backup
}

function Stop-RunningRecall($trayPath, $waitForPid) {
  if ($waitForPid -gt 0) {
    for ($i = 0; $i -lt 150 -and (Get-Process -Id $waitForPid -ErrorAction SilentlyContinue); $i++) {
      Start-Sleep -Milliseconds 200
    }
    if (Get-Process -Id $waitForPid -ErrorAction SilentlyContinue) {
      Fail 'The running tray did not exit; no files were updated.'
    }
  }
  Get-CimInstance Win32_Process -Filter "Name='recall-tray.exe'" |
    Where-Object { $_.ExecutablePath -eq $trayPath } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction Stop }

  $globalRoot = (& npm root -g).Trim()
  if ($LASTEXITCODE -ne 0) { Fail 'Could not locate the npm installation.' }
  $daemonScript = Join-Path $globalRoot '@edihasaj\recall\dist\daemon.js'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*$daemonScript*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction Stop }
  Start-Sleep -Milliseconds 400
}

function Install-Cli($releaseTag) {
  Write-Step 'Installing @edihasaj/recall CLI (provides the daemon)'
  # Point prebuild-install at edihasaj/recall-prebuilds, where native-prebuilds.yml
  # publishes our better-sqlite3 binaries. Without this, win32-arm64 falls through
  # to node-gyp + needs Python + MSVC Build Tools that users don't have.
  # prebuild-install appends "/v<bsq3-version>/<filename>" to this host.
  $env:npm_config_better_sqlite3_binary_host_mirror = 'https://github.com/edihasaj/recall-prebuilds/releases/download'
  $env:ONNXRUNTIME_NODE_INSTALL = 'skip'
  $version = $releaseTag -replace '^v',''
  $work = Join-Path ([IO.Path]::GetTempPath()) ('recall-install-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work | Out-Null
  $archive = Join-Path $work "edihasaj-recall-$version.tgz"
  $url = "https://github.com/$RecallRepo/releases/download/$releaseTag/edihasaj-recall-$version.tgz"
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
    Invoke-WebRequest -UseBasicParsing -Uri "$url.sha256" -OutFile "$archive.sha256"
    $expected = ((Get-Content "$archive.sha256" -Raw).Trim() -split '\s+')[0]
    if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash $archive -Algorithm SHA256).Hash -ne $expected) {
      throw 'CLI package checksum mismatch.'
    }
    # Windows PowerShell can turn npm's stderr warnings into terminating
    # errors under Stop. The native process exit code decides success here.
    $priorErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & npm.cmd install -g $archive
      $npmExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $priorErrorAction
    }
    if ($npmExitCode -ne 0) { throw 'npm install failed' }
  } finally {
    Remove-Item -Recurse -Force $work
  }
  Write-Ok 'CLI installed'
}

function Download-Tray($arch, $releaseTag, $release, $work, $backup) {
  Write-Step "Downloading recall-tray-$arch.exe"
  $assetName = "recall-tray-$arch.exe"
  $asset = $release.assets | Where-Object { $_.name -eq $assetName -and $_.state -eq 'uploaded' } | Select-Object -First 1
  if (-not $asset -or $asset.digest -notmatch '^sha256:[a-fA-F0-9]{64}$') {
    Fail "The $assetName release asset is not ready or has no checksum."
  }
  $expected = $asset.digest.Substring(7)
  $url = "https://github.com/$RecallRepo/releases/download/$releaseTag/recall-tray-$arch.exe"
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $dest = Join-Path $InstallDir $TrayExeName
  $staged = Join-Path $work $assetName
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $staged
  } catch {
    Fail "Could not download $url`: $($_.Exception.Message)"
  }
  if ((Get-FileHash $staged -Algorithm SHA256).Hash -ne $expected) {
    Fail 'Tray checksum mismatch; the installed tray was preserved.'
  }
  if (Test-Path $dest) {
    Move-Item -Path $dest -Destination (Join-Path $backup $TrayExeName) -Force
  }
  Move-Item -Path $staged -Destination $dest
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
  # A developer tray may have pointed at a temporary daemon. The published
  # installation must start from the package that was just installed.
  Remove-Item Env:RECALL_DAEMON_SCRIPT -ErrorAction SilentlyContinue
  Remove-Item Env:RECALL_NODE_PATH -ErrorAction SilentlyContinue
  Start-Process -FilePath $exePath -WindowStyle Hidden
  Write-Ok 'Tray running — look for the Recall icon in the system tray'
}

function Wait-ForHealth($version) {
  Write-Step "Waiting for Recall v$version to become healthy"
  for ($i = 0; $i -lt 20; $i++) {
    try {
      $health = Invoke-RestMethod -Uri 'http://127.0.0.1:7890/health' -TimeoutSec 10 -ErrorAction SilentlyContinue
      if ($null -ne $health -and $health.status -eq 'ok' -and $health.version -eq $version) { return }
    } catch {}
    Start-Sleep -Seconds 2
  }
  Fail "The updated daemon did not report version $version. See the tray log."
}

Write-Host ''
Write-Host 'Recall installer' -ForegroundColor Magenta
Write-Host '----------------' -ForegroundColor Magenta

$arch = Get-Arch
Write-Ok "Architecture: win32-$arch"
Test-Node
$releaseUrl = if ($Version) {
  "https://api.github.com/repos/$RecallRepo/releases/tags/v$Version"
} else {
  "https://api.github.com/repos/$RecallRepo/releases/latest"
}
$release = Invoke-RestMethod -Uri $releaseUrl
$releaseTag = $release.tag_name
if ($releaseTag -notmatch '^v\d+\.\d+\.\d+$') { Fail 'Latest release has an invalid version tag.' }
$releaseVersion = $releaseTag.Substring(1)
if ($Version -and $Version -ne $releaseVersion) { Fail 'The requested release version did not match the release tag.' }
$work = Join-Path ([IO.Path]::GetTempPath()) ('recall-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$tray = Join-Path $InstallDir $TrayExeName
$backup = $null
$stopped = $false
try {
  $backup = Backup-Install $releaseVersion $work
  Stop-RunningRecall $tray $WaitForPid
  $stopped = $true
  $globalRoot = (& npm root -g).Trim()
  if ($LASTEXITCODE -ne 0) { Fail 'Could not locate the npm installation.' }
  Install-Cli $releaseTag
  $installedCli = Join-Path $globalRoot '@edihasaj\recall\dist\cli.js'
  $installedVersion = & node $installedCli --version
  if ($LASTEXITCODE -ne 0 -or $installedVersion -ne $releaseVersion) {
    Fail 'The installed CLI version does not match the tray release.'
  }
  $tray = Download-Tray $arch $releaseTag $release $work $backup
  Register-Autostart $tray
  Launch-Tray $tray
  Wait-ForHealth $releaseVersion
} catch {
  if ($stopped) {
    Get-CimInstance Win32_Process -Filter "Name='recall-tray.exe'" |
      Where-Object { $_.ExecutablePath -eq $tray } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
    if ($backup -and (Test-Path (Join-Path $backup $TrayExeName))) {
      if (Test-Path $tray) { Move-Item $tray (Join-Path $work 'failed-tray.exe') -Force }
      Copy-Item (Join-Path $backup $TrayExeName) $tray
    }
    if (Test-Path $tray) { Start-Process -FilePath $tray -WindowStyle Hidden }
  }
  throw
} finally {
  Remove-Item -Recurse -Force $work
}

Write-Host ''
Write-Host "Done. Recall v$releaseVersion is running in the system tray." -ForegroundColor Green
Write-Host "Logs: $env:LOCALAPPDATA\Recall\tray.log (tray), $env:LOCALAPPDATA\Recall\daemon.log (daemon)"

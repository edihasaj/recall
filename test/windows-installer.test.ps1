$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot
$installer = Join-Path $root 'scripts\install.ps1'
if ((Get-Content $installer -Raw) -ne (Get-Content (Join-Path $root 'docs\install.ps1') -Raw)) {
    throw 'Published installer differs from source.'
}
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Installer syntax errors.' }
# Import functions only. Never execute the real installer's entry point.
$functions = $ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $false)
foreach ($function in $functions) { Invoke-Expression $function.Extent.Text }
$RecallRepo = 'edihasaj/recall'
function Write-Step($msg) {}
function Write-Ok($msg) {}
function Fail($msg) { throw $msg }
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
    if ($script:mode -eq 'download-error') { throw 'Simulated download failure.' }
    if ($Uri.EndsWith('.sha256')) {
        $hash = (Get-FileHash ($OutFile -replace '\.sha256$','') -Algorithm SHA256).Hash
        if ($script:mode -eq 'wrong-checksum') { $hash = '0' * 64 }
        if ($script:mode -eq 'invalid-checksum') { $hash = 'not-a-checksum' }
        "$hash  package.tgz" | Set-Content $OutFile
    } else {
        if ($Uri -ne 'https://github.com/edihasaj/recall/releases/download/v1.4.5/edihasaj-recall-1.4.5.tgz') {
            throw "Unexpected package URL: $Uri"
        }
        'Synthetic package: never executed' | Set-Content $OutFile
        $script:archive = $OutFile
    }
}
function npm.cmd {
    $script:npmCalls++
    if ($args[0] -ne 'install' -or $args[1] -ne '-g' -or $args[2] -ne $script:archive) {
        throw 'Unexpected npm arguments.'
    }
    $global:LASTEXITCODE = if ($script:mode -eq 'npm-error') { 1 } else { 0 }
}

foreach ($case in @('success', 'wrong-checksum', 'invalid-checksum', 'download-error', 'npm-error')) {
    $script:mode = $case
    $script:npmCalls = 0
    $script:archive = $null
    $failed = $false
    try { Install-Cli 'v1.4.5' } catch { $failed = $true }
    if ($failed -ne ($case -ne 'success')) { throw "Unexpected outcome: $case" }
    $expectedCalls = if ($case -in @('success', 'npm-error')) { 1 } else { 0 }
    if ($script:npmCalls -ne $expectedCalls) { throw "Unverified package reached npm: $case" }
    if ($script:archive -and (Test-Path (Split-Path $script:archive))) { throw "Temporary files remain: $case" }
    Write-Host "PASS $case"
}

$trayRoot = Join-Path ([IO.Path]::GetTempPath()) ('recall-tray-update-' + [guid]::NewGuid().ToString('N'))
$InstallDir = Join-Path $trayRoot 'programs'
$TrayExeName = 'recall-tray.exe'
$work = Join-Path $trayRoot 'work'
$backup = Join-Path $trayRoot 'backup'
New-Item -ItemType Directory -Force $InstallDir, $work, $backup | Out-Null
$oldTray = Join-Path $InstallDir $TrayExeName
$payload = Join-Path $trayRoot 'payload.exe'
'old tray' | Set-Content $oldTray
'new tray' | Set-Content $payload
$digest = (Get-FileHash $payload -Algorithm SHA256).Hash
$release = [pscustomobject]@{
    assets = @([pscustomobject]@{ name='recall-tray-amd64.exe'; state='uploaded'; digest="sha256:$digest" })
}
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
    Copy-Item $payload $OutFile
}
try {
    $installed = Download-Tray 'amd64' 'v1.4.18' $release $work $backup
    if ((Get-Content $installed -Raw) -ne (Get-Content $payload -Raw)) { throw 'Verified tray was not installed.' }
    if ((Get-Content (Join-Path $backup $TrayExeName) -Raw) -notmatch 'old tray') { throw 'Old tray was not backed up.' }
    $release.assets[0].digest = 'sha256:' + ('0' * 64)
    $failed = $false
    try { Download-Tray 'amd64' 'v1.4.18' $release $work $backup | Out-Null } catch { $failed = $true }
    if (-not $failed -or (Get-Content $installed -Raw) -ne (Get-Content $payload -Raw)) {
        throw 'Unverified tray replaced the installed copy.'
    }
    Write-Host 'PASS tray checksum and rollback copy'
} finally {
    Remove-Item -Recurse -Force $trayRoot
}
# GitHub's PowerShell wrapper forwards LASTEXITCODE. The final case deliberately
# sets it to 1; clear that mock state after all assertions have succeeded.
$global:LASTEXITCODE = 0

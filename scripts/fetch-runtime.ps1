# Downloads official portable Node.js x64 Windows binary into .\runtime\node.exe for standalone installer builds.
param(
    [string]$NodeVersion = "v24.0.0"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $root "runtime"
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

$targetNode = Join-Path $runtimeDir "node.exe"
if (Test-Path $targetNode) {
    Write-Host "runtime\node.exe already present." -ForegroundColor Green
    exit 0
}

$zipUrl = "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip"
$tmpZip = Join-Path $env:TEMP "warpdm-node-$NodeVersion.zip"
$tmpExt = Join-Path $env:TEMP "warpdm-node-extract"

Write-Host "Downloading portable Node.js ($NodeVersion)..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -UseBasicParsing

if (Test-Path $tmpExt) { Remove-Item $tmpExt -Recurse -Force }
Expand-Archive -Path $tmpZip -DestinationPath $tmpExt -Force

$extractedExe = Get-ChildItem $tmpExt -Recurse -Filter "node.exe" | Select-Object -First 1
if (-not $extractedExe) { throw "node.exe not found in archive" }

Copy-Item $extractedExe.FullName $targetNode -Force
Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
Remove-Item $tmpExt -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Saved portable runtime to $targetNode" -ForegroundColor Green

# WarpDM (Warp Download Manager) v3.5.0 - Official Monolithic Installer Builder
# Compiles standalone WarpDM.exe launcher & self-contained WarpDMSetup.exe embedding all assets, Chromium + Firefox extensions & refreshes Shell Icons.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = $PSScriptRoot
$stage = Join-Path $root "build_stage"
$payloadZip = Join-Path $root "payload.zip"
$outputExe = Join-Path $root "WarpDMSetup.exe"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   WARPDM v3.5.0 - MONOLITHIC INSTALLER BUILDER           " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

Get-Process -Name "WarpDM", "Hogra" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300

# Step 1: Compile WarpDM.exe native launcher
Write-Host "`n[1/4] Compiling native launcher (WarpDM.exe)..." -ForegroundColor Yellow
& "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" `
  /nologo `
  /codepage:65001 `
  /target:winexe `
  /optimize+ `
  /platform:anycpu `
  /win32icon:"$root\assets\app.ico" `
  /out:"$root\WarpDM.exe" `
  "$root\src\launcher\Program.cs"

if ($LASTEXITCODE -ne 0) { throw "Failed to compile WarpDM.exe" }

# Step 2: Stage payload files
Write-Host "`n[2/4] Staging payload files..." -ForegroundColor Yellow
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

Copy-Item (Join-Path $root "WarpDM.exe") $stage
Copy-Item (Join-Path $root "package.json") $stage
Copy-Item (Join-Path $root "README.md") $stage
Copy-Item (Join-Path $root "assets") $stage -Recurse
if (Test-Path (Join-Path $root "runtime")) {
  Copy-Item (Join-Path $root "runtime") $stage -Recurse
}
Copy-Item (Join-Path $root "src") $stage -Recurse
Copy-Item (Join-Path $root "extension") $stage -Recurse

# Generate Firefox-compatible Manifest V3 extension folder + WarpDM-Firefox.xpi
$ffStageDir = Join-Path $stage "extension-firefox"
Copy-Item (Join-Path $root "extension") $ffStageDir -Recurse
$ffManifest = Get-Content (Join-Path $root "extension\manifest.json") -Raw | ConvertFrom-Json
$ffManifest.background = [PSCustomObject]@{ scripts = @("background.js") }
$ffManifest | Add-Member -NotePropertyName "browser_specific_settings" -NotePropertyValue ([PSCustomObject]@{
  gecko = [PSCustomObject]@{
    id = "warpdm@jossefhlv.github.io"
    strict_min_version = "115.0"
  }
}) -Force
$ffJson = $ffManifest | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText((Join-Path $ffStageDir "manifest.json"), $ffJson, (New-Object System.Text.UTF8Encoding($false)))

$ffZipTemp = Join-Path $root "WarpDM-Firefox.zip"
$ffXpiStage = Join-Path $stage "WarpDM-Firefox.xpi"
$ffXpiRoot  = Join-Path $root "WarpDM-Firefox.xpi"
if (Test-Path $ffZipTemp) { Remove-Item $ffZipTemp -Force }
Compress-Archive -Path "$ffStageDir\*" -DestinationPath $ffZipTemp -CompressionLevel Optimal
Copy-Item $ffZipTemp $ffXpiStage -Force
Copy-Item $ffZipTemp $ffXpiRoot -Force
Remove-Item $ffZipTemp -Force

# Step 3: Compress payload
Write-Host "`n[3/4] Compressing payload archive..." -ForegroundColor Yellow
if (Test-Path $payloadZip) { Remove-Item $payloadZip -Force }
Compress-Archive -Path "$stage\*" -DestinationPath $payloadZip -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force

$zipSize = (Get-Item $payloadZip).Length
Write-Host "Payload archive created: $([math]::Round($zipSize / 1MB, 2)) MB" -ForegroundColor Green

# Step 4: Compile monolithic WarpDMSetup.exe
Write-Host "`n[4/4] Compiling monolithic WarpDMSetup.exe with embedded payload..." -ForegroundColor Yellow
& "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" `
  /nologo `
  /codepage:65001 `
  /target:winexe `
  /optimize+ `
  /platform:anycpu `
  /r:"System.IO.Compression.dll" `
  /r:"System.IO.Compression.FileSystem.dll" `
  /win32icon:"$root\assets\app.ico" `
  /resource:"$payloadZip,WarpDMInstaller.Payload.zip" `
  /resource:"$root\assets\app.ico,WarpDMInstaller.app.ico" `
  /resource:"$root\assets\logo128.png,WarpDMInstaller.logo.png" `
  /out:"$outputExe" `
  "$root\src\installer\Setup.cs"

if ($LASTEXITCODE -ne 0) { throw "Failed to compile WarpDMSetup.exe" }

Remove-Item $payloadZip -Force

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ShellIconRefresh {
    [DllImport("shell32.dll")]
    public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
}
"@ -ErrorAction SilentlyContinue
[ShellIconRefresh]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
Start-Process "ie4uinit.exe" -ArgumentList "-show" -WindowStyle Hidden -ErrorAction SilentlyContinue

$finalSize = (Get-Item $outputExe).Length
Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host " SUCCESS! WarpDM v3.5.0 Installer Built & Icons Refreshed!" -ForegroundColor Green
Write-Host " Output Binary : $outputExe" -ForegroundColor Green
Write-Host " Size          : $([math]::Round($finalSize / 1MB, 2)) MB ($finalSize bytes)" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green

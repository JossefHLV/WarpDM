# WarpDM - One-Command GitHub Release Publisher
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\publish-release.ps1 -Version "3.5.0" -NotesFile ".\release-notes.md"

param(
  [Parameter(Mandatory = $true)]
  [string]$Version,

  [string]$NotesFile = ""
)

$ErrorActionPreference = "Stop"
$gh = if (Get-Command gh -ErrorAction SilentlyContinue) { "gh" } else { "C:\Program Files\GitHub CLI\gh.exe" }
$tag = "v$Version"

Write-Host "=== 1. Running UTF-8 & E2E Integrity Suite ===" -ForegroundColor Cyan
$testFiles = (Get-ChildItem -Path ".\tests\*.test.mjs").FullName
& ".\runtime\node.exe" --test $testFiles
if ($LASTEXITCODE -ne 0) { throw "Test suite failed - aborting release!" }

Write-Host "=== 2. Building WarpDM v$Version Installer ===" -ForegroundColor Cyan
powershell -NoProfile -ExecutionPolicy Bypass -File .\Build-Installer.ps1
if ($LASTEXITCODE -ne 0) { throw "Build-Installer.ps1 failed!" }

$exeAsset = ".\WarpDMSetup-v$Version-x64.exe"
$extZip   = ".\WarpDM-Extension-v$Version.zip"
$ffXpi    = ".\WarpDM-Firefox-v$Version.xpi"

Copy-Item -Path ".\WarpDMSetup.exe" -Destination $exeAsset -Force
if (Test-Path ".\WarpDM-Firefox.xpi") { Copy-Item -Path ".\WarpDM-Firefox.xpi" -Destination $ffXpi -Force }
if (Test-Path $extZip) { Remove-Item $extZip -Force }
Compress-Archive -Path ".\extension\*" -DestinationPath $extZip -CompressionLevel Optimal

Write-Host "=== 3. Committing, Tagging ($tag), and Pushing Source ===" -ForegroundColor Cyan
git add -A
$status = git status --porcelain
if ($status) {
  git commit -m "chore(release): WarpDM $tag"
}
git tag -f $tag
git push origin main --tags

Write-Host "=== 4. Creating GitHub Release ($tag) ===" -ForegroundColor Cyan
$assetsToUpload = @($exeAsset, $extZip)
if (Test-Path $ffXpi) { $assetsToUpload += $ffXpi }

if ($NotesFile -and (Test-Path $NotesFile)) {
  & $gh release create $tag @assetsToUpload `
    --title "WarpDM $tag - Warp Download Manager (Windows x64)" `
    --notes-file $NotesFile `
    --latest
} else {
  & $gh release create $tag @assetsToUpload `
    --title "WarpDM $tag - Warp Download Manager (Windows x64)" `
    --notes "Official WarpDM $tag release for Windows 10/11 (x64)." `
    --latest
}

Write-Host "SUCCESS! Published $tag to GitHub Releases!" -ForegroundColor Green

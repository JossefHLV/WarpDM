@echo off
title WarpDM v3.5.0
cd /d "%~dp0"

echo ========================================================
echo   Starting WarpDM v3.5.0
echo ========================================================
echo.

start "" "http://127.0.0.1:20888/"
if exist "runtime\node.exe" (
  "runtime\node.exe" src/server.mjs
) else (
  node src/server.mjs
)

pause

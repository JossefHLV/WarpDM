# Contributing to WarpDM

Thank you for helping make **WarpDM (Warp Download Manager)** the fastest, cleanest open-source download accelerator and stream grabber on Windows!

## Development Setup

1. **Prerequisites**:
   - Windows 10 / 11 (x64)
   - Node.js **v22.5+** or **v24+** (uses built-in `node:sqlite`)
   - Optional for 4K video/stream extraction: `yt-dlp` and `ffmpeg` in `PATH` or `runtime/`

2. **Run from Source**:
   ```powershell
   node src/server.mjs
   ```
   Open `http://127.0.0.1:20888/` in your browser.

3. **Run Syntax & Automated E2E Test Suite**:
   ```powershell
   npm test
   ```
   Every pull request must pass all E2E tests (zero-reconnect segment halving, adaptive HTTP 429 concurrency step-down, pause/resume SHA-256 verification, and approval flow).

4. **Build Monolithic Standalone Installer (`WarpDMSetup.exe`)**:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\fetch-runtime.ps1
   powershell -ExecutionPolicy Bypass -File .\Build-Installer.ps1
   ```

## Versioning Policy

Every functional fix, UI improvement, or extension update increments the semantic version (`vX.Y.Z`) across `package.json`, `extension/manifest.json`, `src/installer/Setup.cs`, `src/bridge/server.mjs`, and `src/ui/index.html`.

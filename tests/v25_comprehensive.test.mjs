import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DownloadEngine } from "../src/core/engine.mjs";
import { BridgeServer } from "../src/bridge/server.mjs";
import { resolveDirectHostUrl } from "../src/core/protocol.mjs";

test("Smart File-Host URL Resolvers rewrite viewer links into direct downloads", () => {
  assert.strictEqual(
    resolveDirectHostUrl("https://www.dropbox.com/s/abc123/archive.zip?dl=0"),
    "https://www.dropbox.com/s/abc123/archive.zip?dl=1"
  );
  assert.strictEqual(
    resolveDirectHostUrl("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing"),
    "https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMnOp&export=download&confirm=t"
  );
  assert.strictEqual(
    resolveDirectHostUrl("https://github.com/user/repo/blob/main/release.zip"),
    "https://raw.githubusercontent.com/user/repo/main/release.zip"
  );
  assert.strictEqual(
    resolveDirectHostUrl("https://pixeldrain.com/u/XyZ987"),
    "https://pixeldrain.com/api/file/XyZ987?download"
  );
});

test("Server returning 200 OK with fake Accept-Ranges falls back cleanly to single-stream", async () => {
  const payload = crypto.randomBytes(512 * 1024);
  const expectedHash = crypto.createHash("sha256").update(payload).digest("hex");

  const server = http.createServer((_req, res) => {
    // Deliberately ignore Range header and return 200 OK with a misleading Accept-Ranges: bytes header
    res.writeHead(200, {
      "Content-Length": payload.length,
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
    });
    res.end(payload);
  });

  const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
  const tmpData = path.resolve("./data_test_fake_range");
  const tmpDl = path.resolve("./dl_test_fake_range");
  const engine = new DownloadEngine(tmpData);

  try {
    const session = await engine.startDownload(`http://127.0.0.1:${port}/fake_range.bin`, tmpDl, 8);
    const finalPath = await new Promise((resolve, reject) => {
      session.on("completed", (res) => resolve(res.destination));
      session.on("error", reject);
    });

    const actualHash = crypto.createHash("sha256").update(fs.readFileSync(finalPath)).digest("hex");
    assert.strictEqual(actualHash, expectedHash, "Single-stream fallback must match SHA-256");
  } finally {
    server.close();
    engine.storage.close();
    await new Promise((r) => setTimeout(r, 150));
    fs.rmSync(tmpData, { recursive: true, force: true });
    fs.rmSync(tmpDl, { recursive: true, force: true });
  }
});

test("Multi-connection Pause and 8-Worker Resume preserves exact SHA-256 integrity", async () => {
  const size = 6 * 1024 * 1024;
  const payload = crypto.randomBytes(size);
  const expectedHash = crypto.createHash("sha256").update(payload).digest("hex");

  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { "Content-Length": size, "Accept-Ranges": "bytes" });
      res.end(payload);
      return;
    }
    const m = range.match(/bytes=(\d+)-(\d+)?/);
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : size - 1;
    const slice = payload.subarray(start, end + 1);
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": slice.length,
    });
    // Throttle chunks slightly so we can pause mid-flight deterministically
    let offset = 0;
    const timer = setInterval(() => {
      if (res.destroyed || offset >= slice.length) {
        clearInterval(timer);
        if (!res.destroyed) res.end();
        return;
      }
      const step = Math.min(65536, slice.length - offset);
      res.write(slice.subarray(offset, offset + step));
      offset += step;
    }, 10);
    req.on("close", () => clearInterval(timer));
  });

  const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
  const tmpData = path.resolve("./data_test_pause_resume");
  const tmpDl = path.resolve("./dl_test_pause_resume");
  const engine = new DownloadEngine(tmpData);

  try {
    const session = await engine.startDownload(`http://127.0.0.1:${port}/resumable.bin`, tmpDl, 4);
    const dlId = session.id;

    // Wait until >1 MB is downloaded, then pause!
    await new Promise((resolve, reject) => {
      session.on("progress", (p) => {
        if (p.downloadedBytes > 1024 * 1024 && p.state === "downloading") {
          engine.pauseDownload(dlId);
          resolve();
        }
      });
      session.on("error", reject);
    });

    await new Promise((r) => setTimeout(r, 150));
    const recPaused = engine.storage.getDownload(dlId);
    assert.strictEqual(recPaused.status, "paused");

    // Now resume and await completion!
    await engine.resumeDownload(dlId);
    const resumedSession = engine.getSession(dlId);
    assert.ok(resumedSession, "Resumed session must be active");

    const finalPath = await new Promise((resolve, reject) => {
      resumedSession.on("completed", (res) => resolve(res.destination));
      resumedSession.on("error", reject);
    });

    const actualHash = crypto.createHash("sha256").update(fs.readFileSync(finalPath)).digest("hex");
    assert.strictEqual(actualHash, expectedHash, "Paused & resumed file must match SHA-256 byte-for-byte");
  } finally {
    server.close();
    engine.storage.close();
    await new Promise((r) => setTimeout(r, 150));
    fs.rmSync(tmpData, { recursive: true, force: true });
    fs.rmSync(tmpDl, { recursive: true, force: true });
  }
});

test("Hetzner-style per-IP concurrent connection cap (HTTP 429 on >3 sockets) steps down cleanly & finishes 100%", async () => {
  const size = 4 * 1024 * 1024;
  const payload = crypto.randomBytes(size);
  const expectedHash = crypto.createHash("sha256").update(payload).digest("hex");

  let activeRangeStreams = 0;
  let throttled429Count = 0;

  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { "Content-Length": size, "Accept-Ranges": "bytes" });
      res.end(payload);
      return;
    }

    const m = range.match(/bytes=(\d+)-(\d+)?/);
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : size - 1;

    // Probe checks bytes=0-0 -> always allow probe, enforce 3-socket cap on real multi-MB transfers
    const isTinyProbe = start === 0 && end === 0;
    if (!isTinyProbe && activeRangeStreams >= 3) {
      throttled429Count++;
      res.writeHead(429, { "Retry-After": "1", "Content-Type": "text/plain" });
      res.end("Too Many Requests");
      return;
    }

    const slice = payload.subarray(start, end + 1);
    if (!isTinyProbe) activeRangeStreams++;
    let decremented = false;
    const dec = () => {
      if (!isTinyProbe && !decremented) {
        decremented = true;
        activeRangeStreams--;
      }
    };

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": slice.length,
    });

    if (isTinyProbe) {
      res.end(slice);
      return;
    }

    let offset = 0;
    const timer = setInterval(() => {
      if (res.destroyed || offset >= slice.length) {
        clearInterval(timer);
        dec();
        if (!res.destroyed) res.end();
        return;
      }
      const step = Math.min(32768, slice.length - offset);
      res.write(slice.subarray(offset, offset + step));
      offset += step;
    }, 35);
    req.on("close", () => {
      clearInterval(timer);
      dec();
    });
  });

  const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
  const tmpData = path.resolve("./data_test_429_stepdown");
  const tmpDl = path.resolve("./dl_test_429_stepdown");
  const engine = new DownloadEngine(tmpData);

  try {
    // Request 8 concurrent connections against a server that rejects socket #4..#8 with HTTP 429!
    const session = await engine.startDownload(`http://127.0.0.1:${port}/hetzner_sim.bin`, tmpDl, 8);
    const finalPath = await new Promise((resolve, reject) => {
      session.on("completed", (res) => resolve(res.destination));
      session.on("error", reject);
    });

    assert.ok(throttled429Count >= 1, "Server should have triggered at least one HTTP 429 throttle");
    assert.ok(session.effectiveMaxConnections <= 3, "Session must step down effectiveMaxConnections to <= 3");
    const actualHash = crypto.createHash("sha256").update(fs.readFileSync(finalPath)).digest("hex");
    assert.strictEqual(actualHash, expectedHash, "Stepped-down 429 transfer must match SHA-256 byte-for-byte");
  } finally {
    server.close();
    engine.storage.close();
    await new Promise((r) => setTimeout(r, 150));
    fs.rmSync(tmpData, { recursive: true, force: true });
    fs.rmSync(tmpDl, { recursive: true, force: true });
  }
});

test("IDM-style Download File Info approval workflow holds unapproved downloads until approved", async () => {
  const payload = crypto.randomBytes(256 * 1024);
  const expectedHash = crypto.createHash("sha256").update(payload).digest("hex");

  const fileServer = http.createServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d+)?/);
      const s = parseInt(m[1], 10);
      const e = m[2] ? parseInt(m[2], 10) : payload.length - 1;
      const slice = payload.subarray(s, e + 1);
      res.writeHead(206, {
        "Content-Range": `bytes ${s}-${e}/${payload.length}`,
        "Accept-Ranges": "bytes",
        "Content-Length": slice.length,
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { "Content-Length": payload.length, "Accept-Ranges": "bytes" });
    res.end(payload);
  });

  const filePort = await new Promise((r) => fileServer.listen(0, "127.0.0.1", () => r(fileServer.address().port)));
  const tmpData = path.resolve("./data_test_approval");
  const tmpDl = path.resolve("./dl_test_approval");
  fs.mkdirSync(tmpDl, { recursive: true });
  const engine = new DownloadEngine(tmpData);
  const bridge = new BridgeServer(engine, 0);
  await bridge.start();
  const apiPort = bridge.server.address().port;

  try {
    // 1. Browser extension sends unapproved POST /api/download -> must hold for user approval!
    const captureRes = await fetch(`http://127.0.0.1:${apiPort}/api/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: `http://127.0.0.1:${filePort}/setup_test.bin`,
        suppressPopup: true,
      }),
    }).then((r) => r.json());

    assert.strictEqual(captureRes.status, "ok");
    assert.strictEqual(captureRes.awaiting_approval, true);
    assert.ok(captureRes.pending_approval_id);
    assert.strictEqual(engine.listHistory().length, 0, "Must NOT start download before user approves");

    // Wait briefly for background probe to populate size & resume support
    await new Promise((r) => setTimeout(r, 250));
    const approvalView = await fetch(
      `http://127.0.0.1:${apiPort}/api/approval?id=${captureRes.pending_approval_id}`
    ).then((r) => r.json());
    assert.strictEqual(approvalView.data.totalBytes, payload.length);
    assert.strictEqual(approvalView.data.acceptsRanges, true);

    // 2. User clicks "Start Download" with custom filename & folder
    const startDone = new Promise((resolve, reject) => {
      engine.on("download_progress", (p) => {
        if (p.state === "completed") resolve(p.destination);
        else if (p.state === "failed") reject(new Error(p.errorMessage || "Failed"));
      });
    });

    const approveRes = await fetch(`http://127.0.0.1:${apiPort}/api/approve-download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: captureRes.pending_approval_id,
        mode: "start",
        filename: "approved_custom_name.bin",
        folder: tmpDl,
        max_connections: 4,
      }),
    }).then((r) => r.json());

    assert.strictEqual(approveRes.action, "started");
    assert.ok(approveRes.download_id, "approve-download must return download_id for progress.html transition");
    const finalPath = await startDone;
    assert.strictEqual(path.basename(finalPath), "approved_custom_name.bin");
    const actualHash = crypto.createHash("sha256").update(fs.readFileSync(finalPath)).digest("hex");
    assert.strictEqual(actualHash, expectedHash);

    // 3. Verify /api/download-item snapshot endpoint returns 100% progressPercent for progress.html!
    const snapRes = await fetch(
      `http://127.0.0.1:${apiPort}/api/download-item?id=${approveRes.download_id}`
    ).then((r) => r.json());
    assert.strictEqual(snapRes.status, "ok");
    assert.strictEqual(snapRes.data.progressPercent, 100);
    assert.strictEqual(snapRes.data.state, "completed");

    // 4. Verify progress.html serves 200 OK
    const progHtmlStatus = (await fetch(`http://127.0.0.1:${apiPort}/progress.html?id=${approveRes.download_id}`)).status;
    assert.strictEqual(progHtmlStatus, 200);
  } finally {
    bridge.server.close();
    fileServer.close();
    engine.storage.close();
    await new Promise((r) => setTimeout(r, 150));
    fs.rmSync(tmpData, { recursive: true, force: true });
    fs.rmSync(tmpDl, { recursive: true, force: true });
  }
});

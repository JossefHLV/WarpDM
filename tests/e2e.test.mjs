import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DownloadEngine } from "../src/core/engine.mjs";

test("End-to-End Multi-Connection Work-Stealing Download & Verification", async () => {
  // Generate 8 MB of deterministic test data
  const testSize = 8 * 1024 * 1024;
  const testBuffer = Buffer.alloc(testSize);
  for (let i = 0; i < testSize; i += 4) {
    testBuffer.writeUInt32LE((i * 1103515245 + 12345) >>> 0, i);
  }
  const sourceHash = crypto.createHash("sha256").update(testBuffer).digest("hex");

  // Spin up local HTTP server supporting byte ranges
  const server = http.createServer((req, res) => {
    const range = req.headers.range;

    if (!range) {
      res.writeHead(200, {
        "Content-Length": testSize,
        "Accept-Ranges": "bytes",
        "Content-Disposition": 'attachment; filename="e2e_test_payload.bin"',
        "Content-Type": "application/octet-stream",
      });
      res.end(testBuffer);
      return;
    }

    const match = range.match(/bytes=(\d+)-(\d+)?/);
    if (!match) {
      res.writeHead(416);
      res.end();
      return;
    }

    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : testSize - 1;

    if (start >= testSize || end >= testSize) {
      res.writeHead(416);
      res.end();
      return;
    }

    const slice = testBuffer.subarray(start, end + 1);
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${testSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": slice.length,
      "Content-Type": "application/octet-stream",
    });
    res.end(slice);
  });

  const port = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address().port);
    });
  });

  const testDataDir = path.resolve("./data_e2e");
  const testDownloadDir = path.resolve("./downloads_e2e");
  fs.mkdirSync(testDownloadDir, { recursive: true });

  const engine = new DownloadEngine(testDataDir);
  const targetUrl = `http://127.0.0.1:${port}/e2e_test_payload.bin`;

  const session = await engine.startDownload(targetUrl, testDownloadDir, 4);

  // Await download completion
  const downloadedPath = await new Promise((resolve, reject) => {
    session.on("completed", (res) => resolve(res.destination));
    session.on("error", (err) => reject(err));
  });

  // Verify file on disk
  assert.ok(fs.existsSync(downloadedPath), "Downloaded file must exist");
  const downloadedBuffer = fs.readFileSync(downloadedPath);
  assert.strictEqual(downloadedBuffer.length, testSize, "File size must match exactly");

  const downloadedHash = crypto.createHash("sha256").update(downloadedBuffer).digest("hex");
  assert.strictEqual(downloadedHash, sourceHash, "SHA-256 checksum must match byte-for-byte");

  // Cleanup
  server.close();
  engine.storage.close();
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.rmSync(testDataDir, { recursive: true, force: true });
  fs.rmSync(testDownloadDir, { recursive: true, force: true });
});

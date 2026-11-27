import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { StorageManager } from "../src/core/storage.mjs";

test("StorageManager creates SQLite WAL and stores chunk progress", () => {
  const testDir = path.resolve("./data_test");
  const storage = new StorageManager(testDir);

  const downloadId = "test-download-123";
  storage.saveDownload(
    downloadId,
    "https://example.com/file.bin",
    "./test.bin",
    "test.bin",
    1000,
    "downloading"
  );

  const rec = storage.getDownload(downloadId);
  assert.strictEqual(rec.id, downloadId);
  assert.strictEqual(rec.status, "downloading");

  // Write and assemble sample chunks
  const w0 = storage.openChunkWriter(downloadId, 0);
  w0.write(Buffer.from("Hello "));
  w0.close();

  const w1 = storage.openChunkWriter(downloadId, 1);
  w1.write(Buffer.from("Hogra!"));
  w1.close();

  const finalPath = path.join(testDir, "final.txt");
  storage.assembleFinalFile(downloadId, 2, finalPath);

  const content = fs.readFileSync(finalPath, "utf8");
  assert.strictEqual(content, "Hello Hogra!");

  // Close database handle before deletion on Windows
  storage.close();

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
});

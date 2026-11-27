import test from "node:test";
import assert from "node:assert";
import { ChunksList } from "../src/core/chunk.mjs";

test("ChunksList initializes single full-range chunk", () => {
  const list = new ChunksList(10 * 1024 * 1024, 8);
  assert.strictEqual(list.chunks.length, 1);
  assert.strictEqual(list.chunks[0].startByte, 0);
  assert.strictEqual(list.chunks[0].endByte, 10 * 1024 * 1024 - 1);
  assert.strictEqual(list.totalDownloaded, 0);
});

test("ChunksList dynamic in-flight midpoint halving without reconnect", () => {
  const list = new ChunksList(10 * 1024 * 1024, 4);
  const worker0Chunk = list.findNextPending(0);
  assert.strictEqual(worker0Chunk.workerId, 0);

  // Advance worker 0 progress to 2 MB
  worker0Chunk.currentByte = 2 * 1024 * 1024;

  // Trigger dynamic work-stealing split for worker 1
  const newChunk = list.splitLargestChunk(1);
  assert.ok(newChunk);
  assert.strictEqual(list.chunks.length, 2);
  assert.strictEqual(newChunk.workerId, 1);

  // Verify that chunk 0 upper bound shrank in-place
  assert.strictEqual(list.chunks[0].endByte, newChunk.startByte - 1);
  assert.strictEqual(newChunk.endByte, 10 * 1024 * 1024 - 1);
});

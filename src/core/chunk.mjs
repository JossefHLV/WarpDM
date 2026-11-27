/**
 * Dynamic Multi-Connection Chunk Segmentation Engine
 * Implements IDM's initial multi-segment partitioning + zero-reconnect in-flight work-stealing.
 */

export const MIN_CHUNK_SPLIT_SIZE = 512 * 1024; // 512 KB minimum remaining to justify halving
export const MAX_TOTAL_PARTS = 256; // Safety cap on total segment files per download

export class ChunkItem {
  constructor(id, startByte, endByte) {
    this.id = id;
    this.startByte = startByte;
    this.currentByte = startByte;
    this.endByte = endByte;
    this.status = "pending"; // 'pending' | 'downloading' | 'completed' | 'failed' | 'paused'
    this.workerId = null;
  }

  get remainingBytes() {
    if (this.endByte >= this.currentByte) {
      return this.endByte - this.currentByte + 1;
    }
    return 0;
  }

  get totalBytes() {
    if (this.endByte >= this.startByte) {
      return this.endByte - this.startByte + 1;
    }
    return 0;
  }

  get downloadedBytes() {
    if (this.currentByte >= this.startByte) {
      return Math.min(this.totalBytes, this.currentByte - this.startByte);
    }
    return 0;
  }

  get isCompleted() {
    return this.status === "completed" || (this.endByte >= this.startByte && this.currentByte > this.endByte);
  }

  snapshot() {
    return {
      id: this.id,
      startByte: this.startByte,
      currentByte: this.currentByte,
      endByte: this.endByte,
      remainingBytes: this.remainingBytes,
      downloadedBytes: this.downloadedBytes,
      totalBytes: this.totalBytes,
      status: this.status,
      workerId: this.workerId,
    };
  }
}

export class ChunksList {
  constructor(totalFileSize = null, maxConnections = 8) {
    this.totalFileSize = totalFileSize;
    this.maxConnections = Math.max(1, Math.min(64, maxConnections));
    this.chunks = [];

    if (totalFileSize !== null && totalFileSize > 0) {
      // Initialize initial chunk covering the complete range [0, total - 1]
      this.chunks.push(new ChunkItem(0, 0, totalFileSize - 1));
    }
  }

  /**
   * Partition file upfront into N parallel segments so all workers saturate bandwidth immediately,
   * while still allowing dynamic in-flight work-stealing when fast workers finish early.
   */
  initializeParallelSegments(desiredConns = this.maxConnections) {
    if (!this.totalFileSize || this.totalFileSize <= 0) return;

    const maxViable = Math.max(1, Math.floor(this.totalFileSize / MIN_CHUNK_SPLIT_SIZE));
    const count = Math.max(1, Math.min(desiredConns, this.maxConnections, maxViable));

    if (count <= 1) return;

    this.chunks = [];
    const baseSize = Math.floor(this.totalFileSize / count);
    let cursor = 0;

    for (let i = 0; i < count; i++) {
      const start = cursor;
      const end = i === count - 1 ? this.totalFileSize - 1 : cursor + baseSize - 1;
      this.chunks.push(new ChunkItem(i, start, end));
      cursor = end + 1;
    }
  }

  /**
   * Restore persisted chunks from SQLite WAL for crash-safe pause/resume.
   */
  restoreFromRecords(records) {
    this.chunks = records.map((r) => {
      const item = new ChunkItem(r.chunk_id, r.start_byte, r.end_byte);
      item.currentByte = r.current_byte;
      if (item.currentByte > item.endByte) {
        item.status = "completed";
      } else {
        item.status = "pending";
      }
      return item;
    });
  }

  get totalDownloaded() {
    return this.chunks.reduce((acc, c) => acc + c.downloadedBytes, 0);
  }

  get activeWorkerCount() {
    return this.chunks.filter((c) => c.status === "downloading").length;
  }

  isAllCompleted() {
    if (this.chunks.length === 0) return false;
    return this.chunks.every((c) => c.isCompleted);
  }

  findNextPending(workerId) {
    const chunk = this.chunks.find(
      (c) => (c.status === "pending" || c.status === "failed" || c.status === "paused") && !c.isCompleted
    );
    if (chunk) {
      chunk.status = "downloading";
      chunk.workerId = workerId;
      return chunk;
    }
    return null;
  }

  /**
   * IDM Dynamic Work-Stealing Halving Algorithm:
   * Finds the active chunk with the maximum remaining bytes.
   * If remaining bytes >= MIN_CHUNK_SPLIT_SIZE * 2, shrinks its boundary in-place
   * and creates a new chunk for the idle worker without closing the existing socket.
   */
  splitLargestChunk(newWorkerId, effectiveMaxConns = this.maxConnections) {
    if (this.activeWorkerCount >= effectiveMaxConns || this.chunks.length >= MAX_TOTAL_PARTS) {
      return null;
    }

    let candidate = null;
    let maxRemaining = 0;

    for (const chunk of this.chunks) {
      if (chunk.status === "downloading") {
        const rem = chunk.remainingBytes;
        if (rem > maxRemaining) {
          maxRemaining = rem;
          candidate = chunk;
        }
      }
    }

    if (!candidate || maxRemaining < MIN_CHUNK_SPLIT_SIZE * 2) {
      return null;
    }

    const cur = candidate.currentByte;
    const oldEnd = candidate.endByte;
    const splitMidpoint = cur + Math.floor((oldEnd - cur) / 2);

    if (splitMidpoint <= cur || splitMidpoint >= oldEnd) {
      return null;
    }

    // Zero-reconnect bound shrinking: update active chunk's end boundary in-place!
    candidate.endByte = splitMidpoint - 1;

    // Create the second half as a new chunk assigned to the idle worker
    const nextId = this.chunks.reduce((m, c) => Math.max(m, c.id), -1) + 1;
    const newChunk = new ChunkItem(nextId, splitMidpoint, oldEnd);
    newChunk.status = "downloading";
    newChunk.workerId = newWorkerId;

    this.chunks.push(newChunk);
    return newChunk.snapshot();
  }

  markCompleted(chunkId) {
    const chunk = this.chunks.find((c) => c.id === chunkId);
    if (chunk) {
      chunk.status = "completed";
      chunk.workerId = null;
    }
  }

  markFailed(chunkId) {
    const chunk = this.chunks.find((c) => c.id === chunkId);
    if (chunk && !chunk.isCompleted) {
      chunk.status = "failed";
      chunk.workerId = null;
    }
  }

  releaseToPending(chunkId) {
    const chunk = this.chunks.find((c) => c.id === chunkId);
    if (chunk && !chunk.isCompleted) {
      chunk.status = "pending";
      chunk.workerId = null;
    }
  }

  markPausedAll() {
    for (const chunk of this.chunks) {
      if (!chunk.isCompleted) {
        chunk.status = "paused";
        chunk.workerId = null;
      }
    }
  }

  snapshots() {
    return [...this.chunks]
      .sort((a, b) => a.startByte - b.startByte)
      .map((c) => c.snapshot());
  }
}

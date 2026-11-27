/**
 * Download Session Orchestrator (v3.0 IDM-Grade Adaptive Concurrency Edition)
 * - Per-host dynamic connection step-down on HTTP 429 / 503 / socket limits (never kills healthy transfers!)
 * - Retry-After backoff compliance, zero-loss work-stealing, and atomic resume
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { ChunksList } from "./chunk.mjs";
import { ProtocolHandler, extractFilename, formatDownloadError } from "./protocol.mjs";

// Learned per-hostname maximum concurrent connections (mirrors IDM's CMaxConnNumbers)
const hostConcurrencyCaps = new Map();

export class DownloadSession extends EventEmitter {
  constructor(id, url, destination, maxConnections = 8, storage, speedLimiter, options = {}) {
    super();
    this.id = id;
    this.url = url;
    this.rawDestination = destination;
    this.destination = path.resolve(destination);
    this.maxConnections = Math.max(1, Math.min(64, maxConnections || 8));
    this.effectiveMaxConnections = this.maxConnections;
    this.storage = storage;
    this.speedLimiter = speedLimiter;
    this.options = options;

    this.filename = options.filename || extractFilename({}, url);
    this.state = "probing";
    this.statusText = "Connecting to remote server...";
    this.metadata = null;
    this.chunksList = null;
    this.isCancelled = false;
    this.isPaused = false;
    this.totalDownloaded = options.initialDownloadedBytes || 0;
    this.initialTotalBytes = options.initialTotalBytes || null;
    this.bytesPerSec = 0;
    this.etaSeconds = null;
    this.errorMessage = null;
    this.workers = new Map();
    this.telemetryTimer = null;
    this.lastInstantEmitTs = 0;
    this.speedWindowStartBytes = this.totalDownloaded;
    this.speedWindowStartTs = performance.now();
  }

  abortOnly() {
    this.isCancelled = true;
    this._abortAllWorkers();
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
  }

  cancel() {
    this.isCancelled = true;
    this.isPaused = false;
    this.state = "cancelled";
    this._abortAllWorkers();
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.storage.deleteDownload(this.id, false);
    this.emitProgress();
    this.emit("state_change", this.state);
  }

  pause() {
    if (this.state !== "downloading" && this.state !== "probing") return false;
    this.isPaused = true;
    this.state = "paused";
    this._abortAllWorkers();
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);

    if (this.chunksList) {
      this.chunksList.markPausedAll();
      const snaps = this.chunksList.snapshots();
      this.storage.checkpointChunks(this.id, snaps, this.chunksList.totalDownloaded);
    }

    this.bytesPerSec = 0;
    this.etaSeconds = null;
    this.storage.saveDownload(
      this.id,
      this.url,
      this.destination,
      this.filename,
      this.metadata?.contentLength || null,
      "paused",
      {
        downloadedSize: this.chunksList ? this.chunksList.totalDownloaded : this.totalDownloaded,
        referer: this.options.referer || null,
        pageUrl: this.options.pageUrl || null,
        cookies: this.options.cookies || null,
        userAgent: this.metadata?.userAgent || this.options.userAgent || null,
      }
    );
    this.emitProgress();
    this.emit("state_change", "paused");
    return true;
  }

  _abortAllWorkers() {
    for (const [_, worker] of this.workers) {
      if (worker.abortController) {
        try {
          worker.abortController.abort();
        } catch (_) {}
      }
    }
  }

  _buildCustomHeaders() {
    const h = { ...(this.options.headers || {}) };
    if (this.options.referer && !h.Referer && !h.referer) h.Referer = this.options.referer;
    if (this.options.cookies) h.Cookie = this.options.cookies;
    if (this.metadata?.cookies) {
      h.Cookie = [h.Cookie, this.metadata.cookies].filter(Boolean).join("; ");
    }
    return h;
  }

  _resolveDestinationFile(destInput, filename) {
    const resolved = path.resolve(destInput);
    const hasKnownExt = path.extname(resolved).length > 0 && path.basename(resolved) === filename;

    if (hasKnownExt && this.options.isResume) {
      this.storage.ensureDirectorySafe(path.dirname(resolved));
      return resolved;
    }

    let treatAsDir = false;
    if (fs.existsSync(resolved)) {
      const st = fs.statSync(resolved);
      if (st.isDirectory()) {
        treatAsDir = true;
      } else if (path.basename(resolved).toLowerCase() === "downloads") {
        this.storage.ensureDirectorySafe(resolved);
        treatAsDir = true;
      }
    } else if (!path.extname(resolved) || destInput.endsWith("/") || destInput.endsWith("\\")) {
      this.storage.ensureDirectorySafe(resolved);
      treatAsDir = true;
    }

    if (!treatAsDir) {
      this.storage.ensureDirectorySafe(path.dirname(resolved));
      return resolved;
    }

    let candidate = path.join(resolved, filename);
    const dupMode = this.storage.getSetting("duplicate_action", "rename");
    if (!this.options.isResume && dupMode !== "overwrite" && fs.existsSync(candidate)) {
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);
      let counter = 1;
      while (fs.existsSync(candidate) && counter < 1000) {
        candidate = path.join(resolved, `${base} (${counter})${ext}`);
        counter++;
      }
    }
    return candidate;
  }

  emitProgress(overrideState = null) {
    const st = overrideState || this.state;
    const downloaded = this.chunksList ? this.chunksList.totalDownloaded : this.totalDownloaded;
    const total = this.metadata?.contentLength ?? this.initialTotalBytes ?? null;
    const snaps = this.chunksList ? this.chunksList.snapshots() : [];
    const activeConns =
      st === "downloading"
        ? snaps.length > 0
          ? snaps.filter((c) => c.status === "downloading").length
          : this.workers.size
        : 0;
    const finalDl = st === "completed" && total ? total : downloaded;
    const progressPercent =
      st === "completed"
        ? 100
        : total && total > 0
          ? Math.min(99.9, (finalDl / total) * 100)
          : 0;

    this.emit("progress", {
      downloadId: this.id,
      url: this.url,
      filename: this.filename,
      destination: this.destination,
      state: st,
      statusText:
        st === "completed"
          ? "Complete"
          : st === "paused"
            ? "Paused"
            : st === "failed"
              ? this.errorMessage || "Failed"
              : this.statusText,
      totalBytes: total,
      downloadedBytes: finalDl,
      progressPercent,
      bytesPerSec: st === "downloading" ? Math.round(this.bytesPerSec) : 0,
      etaSeconds: st === "downloading" ? this.etaSeconds : null,
      activeConnections: activeConns,
      errorMessage: this.errorMessage,
      chunks: snaps,
    });
  }

  async start() {
    try {
      this.state = "probing";
      this.errorMessage = null;
      this.emitProgress("probing");
      this.emit("state_change", this.state);

      const protocol = new ProtocolHandler(this.options.userAgent || null);
      const meta = await protocol.probe(this.url, this._buildCustomHeaders(), this.options.filename);
      this.metadata = meta;

      if (this.isCancelled || this.isPaused) return;

      const totalSize = meta.contentLength;
      const acceptsRanges = meta.acceptsRanges;
      let targetHostname = "";
      try {
        targetHostname = new URL(meta.url || this.url).hostname.toLowerCase();
      } catch (_) {}

      const learnedCap = targetHostname ? hostConcurrencyCaps.get(targetHostname) : null;
      this.effectiveMaxConnections = learnedCap
        ? Math.min(this.maxConnections, learnedCap)
        : this.maxConnections;

      this.destination = this._resolveDestinationFile(this.rawDestination, meta.filename);
      this.filename = path.basename(this.destination);

      if (totalSize) {
        this.storage.checkDiskSpace(path.dirname(this.destination), totalSize - this.totalDownloaded);
      }

      const canMultiSegment = acceptsRanges && totalSize !== null && totalSize > 0;

      if (canMultiSegment) {
        this.chunksList = new ChunksList(totalSize, this.maxConnections);

        if (Array.isArray(this.options.resumeChunks) && this.options.resumeChunks.length > 0) {
          const savedTotal = Math.max(...this.options.resumeChunks.map((c) => c.end_byte)) + 1;
          if (savedTotal === totalSize) {
            this.chunksList.restoreFromRecords(this.options.resumeChunks);
          } else {
            this.storage.cleanupPartDir(this.id);
            this.storage.stmtDeleteChunks.run(this.id);
            this.chunksList.initializeParallelSegments(this.effectiveMaxConnections);
          }
        } else {
          this.chunksList.initializeParallelSegments(this.effectiveMaxConnections);
        }
        this.totalDownloaded = this.chunksList.totalDownloaded;
      }

      this.storage.saveDownload(
        this.id,
        this.url,
        this.destination,
        this.filename,
        totalSize,
        "downloading",
        {
          downloadedSize: this.totalDownloaded,
          referer: this.options.referer || null,
          pageUrl: this.options.pageUrl || null,
          cookies: this.options.cookies || null,
          userAgent: meta.userAgent || null,
        }
      );

      this.state = "downloading";
      this.statusText = "Receiving data...";
      this.speedWindowStartBytes = this.totalDownloaded;
      this.speedWindowStartTs = performance.now();
      this.emit("state_change", this.state);
      this.emitProgress("downloading");

      let lastSampleBytes = this.totalDownloaded;
      let lastSampleTime = performance.now();
      let checkpointCounter = 0;

      // High-frequency 80ms telemetry ticker so even fast 5-50 MB files show smooth percentage & MB/s updates!
      this.telemetryTimer = setInterval(() => {
        if (this.isCancelled || this.isPaused || this.state === "completed" || this.state === "failed") {
          clearInterval(this.telemetryTimer);
          return;
        }

        const now = performance.now();
        const dt = (now - lastSampleTime) / 1000;
        const currentBytes = this.chunksList ? this.chunksList.totalDownloaded : this.totalDownloaded;

        if (dt >= 0.07) {
          const instantSpeed = Math.max(0, (currentBytes - lastSampleBytes) / dt);
          this.bytesPerSec = this.bytesPerSec === 0 ? instantSpeed : this.bytesPerSec * 0.6 + instantSpeed * 0.4;
          lastSampleBytes = currentBytes;
          lastSampleTime = now;

          if (totalSize && totalSize > currentBytes && this.bytesPerSec > 100) {
            this.etaSeconds = Math.ceil((totalSize - currentBytes) / this.bytesPerSec);
          } else {
            this.etaSeconds = null;
          }
        }

        this.emitProgress();

        checkpointCounter++;
        if (checkpointCounter % 3 === 0 && this.chunksList && !this.isCancelled && !this.isPaused) {
          this.storage.checkpointChunks(this.id, this.chunksList.snapshots(), currentBytes);
        }
      }, 80);

      if (canMultiSegment) {
        this.emitProgress();
        const workerPromises = [];

        for (let workerId = 0; workerId < this.effectiveMaxConnections; workerId++) {
          let chunk = this.chunksList.findNextPending(workerId);
          if (!chunk) {
            const stolenSnap = this.chunksList.splitLargestChunk(workerId, this.effectiveMaxConnections);
            if (stolenSnap) {
              chunk = this.chunksList.chunks.find((c) => c.id === stolenSnap.id) || null;
            }
          }

          if (chunk) {
            // Smooth ramp-up (140ms per extra socket) prevents NGINX/CDN burst rate-limit 429s!
            const delayMs = workerId * 140;
            workerPromises.push(
              new Promise((resolve, reject) => {
                setTimeout(() => {
                  if (this.isCancelled || this.isPaused) return resolve();
                  if (workerId >= this.effectiveMaxConnections && workerId > 0) {
                    // Concurrency was already stepped down before this worker woke up!
                    this.chunksList.releaseToPending(chunk.id);
                    return resolve();
                  }
                  this.spawnRangeWorker(workerId, chunk, protocol.userAgent, targetHostname).then(resolve, reject);
                }, delayMs);
              })
            );
          }
        }

        await Promise.all(workerPromises);

        // Safety sweep: if excess workers retired due to 429 step-down and any pending chunks remain,
        // drain them cleanly with Worker 0 before assembling!
        while (
          !this.isCancelled &&
          !this.isPaused &&
          !this.chunksList.isAllCompleted() &&
          this.chunksList.chunks.some((c) => c.status === "pending")
        ) {
          const nextPending = this.chunksList.findNextPending(0);
          if (!nextPending) break;
          await this.spawnRangeWorker(0, nextPending, protocol.userAgent, targetHostname);
        }

        clearInterval(this.telemetryTimer);
        if (this.isCancelled || this.isPaused) return;

        if (!this.chunksList.isAllCompleted()) {
          throw new Error("One or more download segments failed after multiple retries");
        }

        this.storage.assembleFinalFile(this.id, this.chunksList.chunks, this.destination);
      } else {
        await this.runSingleStreamDownload(meta.url || this.url, protocol.userAgent);
        clearInterval(this.telemetryTimer);
        if (this.isCancelled || this.isPaused) return;
      }

      const finalStatSize = fs.existsSync(this.destination)
        ? fs.statSync(this.destination).size
        : totalSize || this.totalDownloaded;

      this.state = "completed";
      this.bytesPerSec = 0;
      this.etaSeconds = 0;

      this.storage.saveDownload(
        this.id,
        this.url,
        this.destination,
        this.filename,
        finalStatSize,
        "completed",
        {
          downloadedSize: finalStatSize,
          referer: this.options.referer || null,
          pageUrl: this.options.pageUrl || null,
          cookies: this.options.cookies || null,
          userAgent: meta.userAgent || null,
        }
      );

      this.emitProgress("completed");
      this.emit("completed", {
        downloadId: this.id,
        filename: this.filename,
        destination: this.destination,
        totalBytes: finalStatSize,
      });
    } catch (err) {
      if (this.telemetryTimer) clearInterval(this.telemetryTimer);
      this._abortAllWorkers();
      if (this.isCancelled || this.isPaused) return;

      // Save chunk checkpoints before marking failed so Retry/Resume keeps all downloaded MBs!
      if (this.chunksList) {
        try {
          this.storage.checkpointChunks(this.id, this.chunksList.snapshots(), this.chunksList.totalDownloaded);
        } catch (_) {}
      }

      this.state = "failed";
      this.errorMessage = formatDownloadError(err);
      this.bytesPerSec = 0;
      this.etaSeconds = null;

      this.storage.saveDownload(
        this.id,
        this.url,
        this.destination,
        this.filename,
        this.metadata?.contentLength || null,
        "failed",
        {
          downloadedSize: this.chunksList ? this.chunksList.totalDownloaded : this.totalDownloaded,
          errorMessage: this.errorMessage,
          referer: this.options.referer || null,
          pageUrl: this.options.pageUrl || null,
          cookies: this.options.cookies || null,
        }
      );

      this.emitProgress("failed");
      this.emit("error", err);
    }
  }

  async runSingleStreamDownload(targetUrl, winningUa) {
    const protocol = new ProtocolHandler(winningUa);
    const abortController = new AbortController();
    this.workers.set(0, { abortController, streaming: true });

    const partDir = this.storage.downloadPartDir(this.id);
    fs.mkdirSync(partDir, { recursive: true });
    const tempFile = path.join(partDir, "single_stream.part");
    const fd = fs.openSync(tempFile, "w");
    this.totalDownloaded = 0;

    try {
      const stream = await protocol.openFullStream(targetUrl, {
        ...this._buildCustomHeaders(),
        signal: abortController.signal,
      });

      for await (const chunk of stream) {
        if (this.isCancelled || this.isPaused) break;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        await this.speedLimiter.acquire(buf.length);
        fs.writeSync(fd, buf);
        this.totalDownloaded += buf.length;
        const now = performance.now();
        if (now - this.lastInstantEmitTs >= 65) {
          const elapsed = Math.max(0.02, (now - this.speedWindowStartTs) / 1000);
          this.bytesPerSec = Math.max(this.bytesPerSec, (this.totalDownloaded - this.speedWindowStartBytes) / elapsed);
          this.lastInstantEmitTs = now;
          this.emitProgress("downloading");
        }
      }
    } finally {
      try {
        fs.closeSync(fd);
      } catch (_) {}
      this.workers.delete(0);
    }

    if (!this.isCancelled && !this.isPaused) {
      this.storage.safeMoveFileSync(tempFile, this.destination);
      this.storage.cleanupPartDir(this.id);
    }
  }

  async spawnRangeWorker(workerId, chunk, winningUa, targetHostname = "") {
    const chunkId = chunk.id;
    const maxRetries = 8;
    let attempt = 0;

    const partPath = this.storage.chunkFilePath(this.id, chunkId);
    const expectedExisting = Math.max(0, chunk.currentByte - chunk.startByte);
    if (expectedExisting === 0 && fs.existsSync(partPath)) {
      try {
        fs.unlinkSync(partPath);
      } catch (_) {}
    } else if (expectedExisting > 0 && fs.existsSync(partPath)) {
      const actualSize = fs.statSync(partPath).size;
      if (actualSize !== expectedExisting) {
        chunk.currentByte = chunk.startByte + Math.min(actualSize, chunk.totalBytes);
      }
    } else if (expectedExisting > 0 && !fs.existsSync(partPath)) {
      chunk.currentByte = chunk.startByte;
    }

    while (attempt < maxRetries && !this.isCancelled && !this.isPaused) {
      if (chunk.currentByte > chunk.endByte) {
        this.chunksList.markCompleted(chunkId);
        break;
      }

      const protocol = new ProtocolHandler(winningUa);
      const abortController = new AbortController();
      const workerState = { abortController, streaming: false };
      this.workers.set(workerId, workerState);
      const writer = this.storage.openChunkWriter(this.id, chunkId, false);

      try {
        const start = chunk.currentByte;
        const end = chunk.endByte;
        const targetUrl = this.metadata?.url || this.url;

        const stream = await protocol.openRangeStream(targetUrl, start, end, {
          ...this._buildCustomHeaders(),
          signal: abortController.signal,
        });

        workerState.streaming = true;

        for await (const rawValue of stream) {
          if (this.isCancelled || this.isPaused) break;

          const value = Buffer.isBuffer(rawValue) ? rawValue : Buffer.from(rawValue);
          const maxAllowed = chunk.endByte - chunk.currentByte + 1;
          if (maxAllowed <= 0) {
            stream.destroy();
            break;
          }

          const slice = value.length > maxAllowed ? value.subarray(0, maxAllowed) : value;

          await this.speedLimiter.acquire(slice.length);
          writer.write(slice);

          chunk.currentByte += slice.length;
          this.totalDownloaded += slice.length;
          const now = performance.now();
          if (now - this.lastInstantEmitTs >= 65) {
            const curTot = this.chunksList ? this.chunksList.totalDownloaded : this.totalDownloaded;
            const elapsed = Math.max(0.02, (now - this.speedWindowStartTs) / 1000);
            if (this.bytesPerSec === 0 && curTot > this.speedWindowStartBytes) {
              this.bytesPerSec = (curTot - this.speedWindowStartBytes) / elapsed;
            }
            this.lastInstantEmitTs = now;
            this.emitProgress("downloading");
          }

          if (chunk.currentByte > chunk.endByte) {
            stream.destroy();
            break;
          }
        }

        if (!this.isCancelled && !this.isPaused && chunk.currentByte > chunk.endByte) {
          this.chunksList.markCompleted(chunkId);
          break;
        }
      } catch (err) {
        if (this.isCancelled || this.isPaused) break;
        if (chunk.currentByte > chunk.endByte) {
          this.chunksList.markCompleted(chunkId);
          break;
        }

        const isThrottleOrCap =
          err.statusCode === 429 ||
          err.statusCode === 503 ||
          (workerId > 0 && (err.statusCode === 403 || err.code === "ECONNRESET"));

        // Count other actively streaming workers right now
        let otherStreamingCount = 0;
        for (const [otherId, st] of this.workers) {
          if (otherId !== workerId && st.streaming) otherStreamingCount++;
        }

        // IDM Adaptive Concurrency Step-Down:
        // If server caps concurrent sockets per IP (429/503) while >= 1 other worker is actively streaming,
        // retire this excess worker cleanly and return its chunk to pending so surviving workers finish it!
        if (isThrottleOrCap && otherStreamingCount >= 1) {
          this.effectiveMaxConnections = Math.max(1, Math.min(this.effectiveMaxConnections - 1, otherStreamingCount));
          if (targetHostname && targetHostname !== "127.0.0.1" && targetHostname !== "localhost") {
            hostConcurrencyCaps.set(targetHostname, this.effectiveMaxConnections);
          }
          this.chunksList.releaseToPending(chunkId);
          return;
        }

        attempt++;
        if (attempt >= maxRetries) {
          this.chunksList.markFailed(chunkId);
          throw err;
        }

        // Honor server Retry-After or exponential backoff
        const backoffMs =
          err.retryAfterMs ||
          (err.statusCode === 429 || err.statusCode === 503
            ? Math.min(15000, 2000 * Math.pow(1.6, attempt))
            : Math.min(8000, 500 * Math.pow(1.8, attempt)));
        await new Promise((r) => setTimeout(r, backoffMs));
      } finally {
        writer.close();
        this.workers.delete(workerId);
      }
    }

    if (!this.isCancelled && !this.isPaused && this.metadata?.acceptsRanges) {
      if (this.workers.size >= this.effectiveMaxConnections) {
        return;
      }

      const pending = this.chunksList.findNextPending(workerId);
      if (pending) {
        await this.spawnRangeWorker(workerId, pending, winningUa, targetHostname);
        return;
      }

      const stolenSnap = this.chunksList.splitLargestChunk(workerId, this.effectiveMaxConnections);
      if (stolenSnap) {
        const newChunk = this.chunksList.chunks.find((c) => c.id === stolenSnap.id);
        if (newChunk) {
          await this.spawnRangeWorker(workerId, newChunk, winningUa, targetHostname);
        }
      }
    }
  }
}

/**
 * Hogra Download Engine (v3.0 IDM-Grade Edition)
 * - Pre-approval URL & Video probing (Download File Info)
 * - Download Later, Start Queue, Stop All, and Partial-Progress Retry Preservation
 * - Clean graceful shutdown checkpointing active SQLite WAL state
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StorageManager } from "./storage.mjs";
import { SpeedLimiter } from "./limiter.mjs";
import { DownloadSession } from "./session.mjs";
import { RemoteZipInspector } from "./zip_preview.mjs";
import { ProtocolHandler, extractFilename, sanitizeFilename } from "./protocol.mjs";
import { SiteGrabber } from "../grabber/spider.mjs";
import {
  VideoDownloadSession,
  resolveAndClassifyUrl,
  probeMediaFormats,
  findYtDlpPath,
  findFfmpegPath,
} from "../media/ytdlp.mjs";

export function classifyFileCategory(filename, isStreaming = false, mediaFormat = null) {
  if (mediaFormat && String(mediaFormat).startsWith("audio-")) return "Music";
  if (isStreaming || mediaFormat) return "Video";
  const dot = String(filename || "").lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
  if (["zip", "rar", "7z", "iso", "tar", "gz", "bz2", "xz"].includes(ext)) return "Compressed";
  if (["pdf", "doc", "docx", "txt", "xlsx", "pptx", "csv", "md", "epub"].includes(ext)) return "Documents";
  if (["mp3", "wav", "flac", "aac", "ogg", "m4a", "opus"].includes(ext)) return "Music";
  if (["exe", "msi", "apk", "bat", "dmg", "deb", "rpm"].includes(ext)) return "Programs";
  if (["mp4", "mkv", "avi", "mov", "webm", "ts", "flv"].includes(ext)) return "Video";
  return "General";
}

export class DownloadEngine extends EventEmitter {
  constructor(dataDir = "./data") {
    super();
    this.storage = new StorageManager(dataDir);
    const startupLimitEnabled = this.storage.getSetting("speed_limit_startup", false);
    const savedKbps = Number(this.storage.getSetting("speed_limit_kbps", 0)) || 0;
    const initialBps = startupLimitEnabled && savedKbps > 0 ? Math.round(savedKbps * 1024) : 0;
    this.globalLimiter = new SpeedLimiter(initialBps);
    this.activeSessions = new Map();
    this.pendingQueue = [];
    this._lastScheduledTriggerKey = "";

    this.schedulerTimer = setInterval(() => this._checkScheduleTick(), 15000);
    if (this.schedulerTimer.unref) this.schedulerTimer.unref();
  }

  _checkScheduleTick() {
    try {
      const s = this.getSettings();
      if (!s.scheduler_enabled && !s.scheduler_stop_enabled) return;
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const dayKey = `${now.toDateString()}-${hhmm}`;
      if (this._lastScheduledTriggerKey === dayKey) return;

      if (s.scheduler_enabled && s.scheduler_start_time === hhmm) {
        this._lastScheduledTriggerKey = dayKey;
        this.startQueue("scheduled").then((c) => {
          if (c === 0) this.startQueue(null);
        });
      } else if (s.scheduler_stop_enabled && s.scheduler_stop_time === hhmm) {
        this._lastScheduledTriggerKey = dayKey;
        this.stopAll();
      }
    } catch (_) {}
  }

  setGlobalSpeedLimit(bytesPerSec) {
    const val = Math.max(0, Number(bytesPerSec) || 0);
    this.globalLimiter.setLimit(val);
    this.emit("speed_limit_updated", { bytes_per_sec: val });
  }

  getCapabilities() {
    return {
      ytDlpAvailable: !!findYtDlpPath(),
      ffmpegAvailable: !!findFfmpegPath(),
      speedLimitBytesPerSec: this.globalLimiter.bytesPerSecond,
      settings: this.storage.getAllSettings(),
    };
  }

  getSettings() {
    return this.storage.getAllSettings();
  }

  updateSettings(patch = {}) {
    if (patch.default_download_dir) {
      const cleanDir = this.storage.ensureDirectorySafe(patch.default_download_dir);
      this.storage.setSetting("default_download_dir", cleanDir);
    }
    if (patch.category_dirs && typeof patch.category_dirs === "object") {
      const cleanMap = {};
      for (const [cat, dir] of Object.entries(patch.category_dirs)) {
        if (dir && typeof dir === "string" && dir.trim()) {
          cleanMap[cat] = this.storage.ensureDirectorySafe(dir.trim());
        }
      }
      this.storage.setSetting("category_dirs", cleanMap);
    }
    if (patch.temp_parts_dir !== undefined) {
      const tDir = String(patch.temp_parts_dir || "").trim();
      this.storage.setSetting("temp_parts_dir", tDir ? this.storage.ensureDirectorySafe(tDir) : "");
    }
    if (patch.max_connections !== undefined) {
      this.storage.setSetting("max_connections", Math.max(1, Math.min(64, Number(patch.max_connections) || 8)));
    }
    if (patch.max_concurrent_downloads !== undefined) {
      this.storage.setSetting(
        "max_concurrent_downloads",
        Math.max(1, Math.min(16, Number(patch.max_concurrent_downloads) || 4))
      );
      this._pumpQueue();
    }

    const boolKeys = [
      "quiet_mode",
      "auto_capture",
      "ask_confirmation",
      "show_progress_popup",
      "show_complete_dialog",
      "prestart_in_approval",
      "category_subfolders",
      "speed_limit_startup",
      "sound_complete",
      "sound_failed",
      "sound_queue_done",
      "scheduler_enabled",
      "scheduler_stop_enabled",
      "scheduler_open_folder_on_done",
      "launch_on_startup",
      "clipboard_monitor",
    ];
    for (const k of boolKeys) {
      if (patch[k] !== undefined) this.storage.setSetting(k, !!patch[k]);
    }

    const strKeys = [
      "duplicate_action",
      "custom_user_agent",
      "captured_file_types",
      "excluded_domains",
      "proxy_host",
      "proxy_port",
      "scheduler_start_time",
      "scheduler_stop_time",
      "ui_theme",
      "toolbar_size",
      "toolbar_style",
      "ui_language",
    ];
    for (const k of strKeys) {
      if (patch[k] !== undefined) this.storage.setSetting(k, String(patch[k]));
    }

    if (patch.scheduler_max_concurrent !== undefined) {
      this.storage.setSetting(
        "scheduler_max_concurrent",
        Math.max(1, Math.min(16, Number(patch.scheduler_max_concurrent) || 2))
      );
    }

    if (patch.speed_limit_kbps !== undefined) {
      const kbps = Math.max(0, Number(patch.speed_limit_kbps) || 0);
      this.storage.setSetting("speed_limit_kbps", kbps);
    }

    return this.getSettings();
  }

  getSuggestedFolderForCategory(category) {
    const catDirs = this.storage.getSetting("category_dirs", {}) || {};
    if (category && catDirs[category] && typeof catDirs[category] === "string") {
      return catDirs[category];
    }
    const base = this.storage.getDefaultDownloadDir();
    const useSubs = this.storage.getSetting("category_subfolders", false);
    if (!useSubs || !category || category === "General") return base;
    return path.join(base, category);
  }

  _resolveDestinationDir(dest, knownFilename = null) {
    const defaultDir = this.storage.getDefaultDownloadDir();
    if (!dest) return defaultDir;
    const resolved = path.resolve(dest);

    if (knownFilename && path.basename(resolved) === knownFilename) {
      return path.dirname(resolved);
    }
    if (fs.existsSync(resolved)) {
      return fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
    }
    if (dest.endsWith("/") || dest.endsWith("\\")) {
      return resolved;
    }
    return path.extname(resolved) ? path.dirname(resolved) : defaultDir;
  }

  /**
   * Probes file or streaming video metadata for the IDM-style Download File Info dialog.
   */
  async probeDownloadInfo(rawUrl, options = {}) {
    const { url, isStreaming } = resolveAndClassifyUrl(rawUrl, options.pageUrl || options.referer);

    if (isStreaming || options.forceVideo) {
      const info = await probeMediaFormats(url, options.pageUrl || null, {
        cookies: options.cookies || null,
        cookiesTxt: options.cookiesTxt || null,
        userAgent: options.userAgent || null,
      });
      const selectedQ = options.quality || "best";
      const ext = selectedQ === "audio-mp3" ? ".mp3" : selectedQ === "audio-m4a" ? ".m4a" : ".mp4";
      const cleanTitle = sanitizeFilename((info.title || "video").replace(/^\(\d+\)\s*/, ""));
      const filename = cleanTitle.toLowerCase().endsWith(ext) ? cleanTitle : `${cleanTitle}${ext}`;
      const matchedOpt = info.qualities?.find((q) => q.id === selectedQ) || info.qualities?.[0];
      const category = classifyFileCategory(filename, true, selectedQ);

      return {
        isVideo: true,
        url: info.url || url,
        title: info.title,
        filename,
        totalBytes: matchedOpt?.approxBytes || null,
        acceptsRanges: true,
        category,
        folder: this.getSuggestedFolderForCategory(category),
        qualities: info.qualities || [],
      };
    }

    const protocol = new ProtocolHandler(options.userAgent || null);
    const customHeaders = { ...(options.headers || {}) };
    if (options.referer && !customHeaders.Referer) customHeaders.Referer = options.referer;
    if (options.cookies) customHeaders.Cookie = options.cookies;

    const meta = await protocol.probe(url, customHeaders, options.filename || null);
    const category = classifyFileCategory(meta.filename, false, null);

    return {
      isVideo: false,
      url: meta.url || url,
      filename: meta.filename,
      totalBytes: meta.contentLength,
      acceptsRanges: meta.acceptsRanges,
      contentType: meta.contentType,
      category,
      folder: this.getSuggestedFolderForCategory(category),
      qualities: [],
    };
  }

  async previewRemoteZip(url) {
    const protocol = new ProtocolHandler();
    const meta = await protocol.probe(url);
    if (!meta.contentLength) {
      throw new Error("Content-Length header required to preview remote ZIP archive");
    }
    const inspector = new RemoteZipInspector();
    inspector.protocol = protocol;
    return await inspector.inspectRemoteZip(meta.url || url, meta.contentLength);
  }

  async probeMedia(url, pageUrl = null, authOptions = {}) {
    return await probeMediaFormats(url, pageUrl, authOptions);
  }

  async crawlSite(url, maxDepth = 1) {
    const grabber = new SiteGrabber({ maxDepth: Math.max(1, Math.min(3, maxDepth)) });
    return await grabber.crawl(url);
  }

  /**
   * Saves a transfer in 'paused' (Unfinished / Download Later) state without starting network sockets.
   */
  saveDownloadLater(rawUrl, folder = null, options = {}) {
    const id = randomUUID();
    const { url, isStreaming } = resolveAndClassifyUrl(rawUrl, options.pageUrl || options.referer);
    const targetFolder = this.storage.ensureDirectorySafe(folder || this.storage.getDefaultDownloadDir());
    const fname = sanitizeFilename(options.filename || extractFilename({}, url));
    const fullDest = path.join(targetFolder, fname);
    const mediaFormat = isStreaming || options.forceVideo ? options.quality || "best" : null;

    this.storage.saveDownload(id, url, fullDest, fname, options.totalBytes || null, "paused", {
      downloadedSize: 0,
      mediaFormat,
      referer: options.referer || null,
      pageUrl: options.pageUrl || null,
      cookies: options.cookies || null,
      cookiesTxt: options.cookiesTxt || null,
      userAgent: options.userAgent || null,
    });

    this.emit("download_progress", {
      downloadId: id,
      url,
      filename: fname,
      destination: fullDest,
      state: "paused",
      totalBytes: options.totalBytes || null,
      downloadedBytes: 0,
      bytesPerSec: 0,
      etaSeconds: null,
      activeConnections: 0,
      mediaFormat,
      chunks: [],
    });

    return id;
  }

  async startDownload(rawUrl, destination = null, maxConnections = null, options = {}) {
    const id = options.existingId || randomUUID();
    const defaultDir = this.storage.getDefaultDownloadDir();
    const dest = destination || defaultDir;
    const conns = maxConnections || this.storage.getSetting("max_connections", 8);

    const { url, isStreaming } = resolveAndClassifyUrl(rawUrl, options.pageUrl || options.referer);

    const headers = { ...(options.headers || {}) };
    if (options.authUser) {
      const token = Buffer.from(`${options.authUser}:${options.authPass || ""}`, "utf8").toString("base64");
      headers.Authorization = `Basic ${token}`;
    }
    const configuredUa = this.storage.getSetting("custom_user_agent", "");
    const effectiveUa = options.userAgent || (configuredUa ? configuredUa : null);

    let session;
    if (isStreaming || options.forceVideo || options.quality) {
      const destFolder = this._resolveDestinationDir(dest, options.filename);
      session = new VideoDownloadSession(id, url, destFolder, conns, this.storage, this.globalLimiter, {
        quality: options.quality || "best",
        filename: options.filename || null,
        customFilenameApproved: !!options.customFilenameApproved,
        referer: options.referer || null,
        pageUrl: options.pageUrl || null,
        cookies: options.cookies || null,
        cookiesTxt: options.cookiesTxt || null,
        headers,
        userAgent: effectiveUa,
        fallbackStreams: options.fallbackStreams || null,
        initialDownloadedBytes: options.initialDownloadedBytes || 0,
        initialTotalBytes: options.initialTotalBytes || null,
      });
    } else {
      session = new DownloadSession(id, url, dest, conns, this.storage, this.globalLimiter, {
        ...options,
        headers,
        userAgent: effectiveUa,
      });
    }

    const maxConcurrent = this.storage.getSetting("max_concurrent_downloads", 4);
    if (this.activeSessions.size >= maxConcurrent) {
      session.state = "queued";
      const qName = session.filename || extractFilename({}, url);
      this.storage.saveDownload(id, url, session.destination, qName, null, "queued", {
        downloadedSize: options.initialDownloadedBytes || 0,
        mediaFormat: options.quality || null,
        referer: options.referer || null,
        pageUrl: options.pageUrl || null,
        cookies: options.cookies || null,
        cookiesTxt: options.cookiesTxt || null,
      });
      this.pendingQueue.push({ id, session });
      this.emit("download_progress", {
        downloadId: id,
        url,
        filename: qName,
        destination: session.destination,
        state: "queued",
        totalBytes: null,
        downloadedBytes: options.initialDownloadedBytes || 0,
        bytesPerSec: 0,
        etaSeconds: null,
        activeConnections: 0,
        mediaFormat: options.quality || null,
        chunks: [],
      });
      return session;
    }

    this._launchSessionNow(id, session);
    return session;
  }

  _launchSessionNow(id, session) {
    this.activeSessions.set(id, session);

    session.on("progress", (prog) => {
      this.emit("download_progress", prog);
    });

    const onDone = () => {
      this.activeSessions.delete(id);
      this._pumpQueue();
    };

    session.on("completed", (res) => {
      this.emit("download_completed", res);
      onDone();
    });
    session.on("error", (err) => {
      this.emit("download_error", { downloadId: id, error: err?.message || String(err) });
      onDone();
    });
    session.on("state_change", (st) => {
      if (st === "paused" || st === "cancelled") {
        onDone();
      }
    });

    session.start().catch((err) => {
      console.error(`[Engine] Session ${id} error:`, err.message);
    });
  }

  _pumpQueue() {
    const maxConcurrent = this.storage.getSetting("max_concurrent_downloads", 4);
    while (this.activeSessions.size < maxConcurrent && this.pendingQueue.length > 0) {
      const next = this.pendingQueue.shift();
      if (next && !next.session.isCancelled && !next.session.isPaused) {
        this._launchSessionNow(next.id, next.session);
      }
    }
  }

  async startQueue(queueName = null) {
    const pausedItems = this.storage
      .listDownloads()
      .filter((r) => r.status === "paused" && (!queueName || (r.queue_name || "main") === queueName));
    let count = 0;
    for (const item of pausedItems.reverse()) {
      await this.resumeDownload(item.id);
      count++;
    }
    this.emit("queue_state", { event: "started", queueName: queueName || "main", count });
    return count;
  }

  moveToQueue(id, queueName = "main") {
    const rec = this.storage.getDownload(id);
    if (!rec) return false;
    this.storage.db.prepare(`UPDATE downloads SET queue_name = ? WHERE id = ?`).run(queueName, id);
    return true;
  }

  stopAll() {
    let count = 0;
    for (const q of [...this.pendingQueue]) {
      if (this.pauseDownload(q.id)) count++;
    }
    for (const [id] of [...this.activeSessions]) {
      if (this.pauseDownload(id)) count++;
    }
    return count;
  }

  shutdown() {
    try {
      this.stopAll();
    } catch (_) {}
    try {
      this.storage.close();
    } catch (_) {}
  }

  getSession(id) {
    return this.activeSessions.get(id) || null;
  }

  pauseDownload(id) {
    const qIdx = this.pendingQueue.findIndex((q) => q.id === id);
    if (qIdx >= 0) {
      const { session } = this.pendingQueue.splice(qIdx, 1)[0];
      session.isPaused = true;
      session.state = "paused";
      this.storage.saveDownload(id, session.url, session.destination, session.filename, null, "paused");
      this.emit("download_progress", {
        downloadId: id,
        url: session.url,
        filename: session.filename,
        destination: session.destination,
        state: "paused",
        totalBytes: null,
        downloadedBytes: 0,
        bytesPerSec: 0,
        etaSeconds: null,
        activeConnections: 0,
        chunks: [],
      });
      return true;
    }

    const session = this.activeSessions.get(id);
    if (session && typeof session.pause === "function") {
      return session.pause();
    }
    return false;
  }

  async resumeDownload(id) {
    if (this.activeSessions.has(id) || this.pendingQueue.some((q) => q.id === id)) return true;

    const rec = this.storage.getDownload(id);
    if (!rec) return false;

    const savedChunks = this.storage.getChunks(id);
    const cleanName = rec.filename && rec.filename !== "Fetching video info..." ? rec.filename : null;

    await this.startDownload(rec.url, rec.destination, null, {
      existingId: id,
      isResume: true,
      resumeChunks: savedChunks,
      initialDownloadedBytes: rec.downloaded_size || 0,
      filename: cleanName,
      referer: rec.referer || null,
      pageUrl: rec.page_url || null,
      cookies: rec.cookies || null,
      cookiesTxt: rec.cookies_txt || null,
      userAgent: rec.user_agent || null,
      quality: rec.media_format || undefined,
      forceVideo: !!rec.media_format,
    });
    return true;
  }

  async retryDownload(id) {
    const rec = this.storage.getDownload(id);
    if (!rec) return false;

    const qIdx = this.pendingQueue.findIndex((q) => q.id === id);
    if (qIdx >= 0) this.pendingQueue.splice(qIdx, 1);

    const active = this.activeSessions.get(id);
    if (active) {
      active.abortOnly();
      this.activeSessions.delete(id);
    }

    // Check if valid partial chunk files exist on disk — if so, preserve downloaded MBs instead of wiping!
    const savedChunks = this.storage.getChunks(id);
    const partDir = this.storage.downloadPartDir(id);
    let hasPartialBytesOnDisk = false;
    if (savedChunks.length > 0 && fs.existsSync(partDir)) {
      try {
        hasPartialBytesOnDisk = fs
          .readdirSync(partDir)
          .some((f) => f.endsWith(".part") && fs.statSync(path.join(partDir, f)).size > 0);
      } catch (_) {}
    }

    const cleanName =
      rec.filename && !["Fetching video info...", "download"].includes(rec.filename) ? rec.filename : null;

    if (hasPartialBytesOnDisk && !rec.media_format) {
      await this.startDownload(rec.url, rec.destination, null, {
        existingId: id,
        isResume: true,
        resumeChunks: savedChunks,
        initialDownloadedBytes: rec.downloaded_size || 0,
        filename: cleanName,
        referer: rec.referer || null,
        pageUrl: rec.page_url || null,
        cookies: rec.cookies || null,
        cookiesTxt: rec.cookies_txt || null,
        userAgent: rec.user_agent || null,
      });
      return true;
    }

    this.storage.stmtDeleteChunks.run(id);
    this.storage.cleanupPartDir(id);
    const destDir = this._resolveDestinationDir(rec.destination, rec.filename);

    await this.startDownload(rec.url, destDir, null, {
      existingId: id,
      filename: cleanName,
      referer: rec.referer || null,
      pageUrl: rec.page_url || null,
      cookies: rec.cookies || null,
      cookiesTxt: rec.cookies_txt || null,
      userAgent: rec.user_agent || null,
      quality: rec.media_format || undefined,
      forceVideo: !!rec.media_format,
    });
    return true;
  }

  cancelDownload(id) {
    const qIdx = this.pendingQueue.findIndex((q) => q.id === id);
    if (qIdx >= 0) {
      this.pendingQueue.splice(qIdx, 1);
      this.storage.deleteDownload(id, false);
      this.emit("download_removed", { downloadId: id });
      return true;
    }

    const session = this.activeSessions.get(id);
    if (session) {
      session.cancel();
      this.activeSessions.delete(id);
      this.emit("download_removed", { downloadId: id });
      this._pumpQueue();
      return true;
    }
    return false;
  }

  deleteDownload(id, deleteDiskFile = false) {
    const qIdx = this.pendingQueue.findIndex((q) => q.id === id);
    if (qIdx >= 0) this.pendingQueue.splice(qIdx, 1);

    const session = this.activeSessions.get(id);
    if (session) {
      session.abortOnly();
      this.activeSessions.delete(id);
      this._pumpQueue();
    }

    this.storage.deleteDownload(id, deleteDiskFile);
    this.emit("download_removed", { downloadId: id });
    return true;
  }

  clearDownloads(mode = "failed") {
    const count = this.storage.clearDownloadsByFilter(mode);
    this.emit("downloads_cleared", { mode, count });
    return count;
  }

  listHistory() {
    return this.storage.listDownloads();
  }
}

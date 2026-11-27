/**
 * Storage Manager (v2.5 Crash-Safe Atomic Edition)
 * - Atomic .hogra_tmp assembly + cross-drive EXDEV & Windows Defender EBUSY/EPERM safe move
 * - Pre-flight disk space verification
 * - Full persistence of cookies, cookies_txt, page_url, referer, and user_agent for reliable Resume/Retry
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class StorageManager {
  constructor(baseDir = "./data") {
    this.baseDataDir = path.resolve(baseDir);
    fs.mkdirSync(this.baseDataDir, { recursive: true });

    const dbPath = path.join(this.baseDataDir, "hogra_state.db");
    this.db = new DatabaseSync(dbPath);

    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS downloads (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        destination TEXT NOT NULL,
        filename TEXT NOT NULL,
        total_size INTEGER,
        downloaded_size INTEGER DEFAULT 0,
        status TEXT NOT NULL,
        error_message TEXT,
        media_format TEXT,
        referer TEXT,
        page_url TEXT,
        cookies TEXT,
        cookies_txt TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        download_id TEXT NOT NULL,
        chunk_id INTEGER NOT NULL,
        start_byte INTEGER NOT NULL,
        current_byte INTEGER NOT NULL,
        end_byte INTEGER NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (download_id, chunk_id),
        FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    for (const colDef of [
      "downloaded_size INTEGER DEFAULT 0",
      "error_message TEXT",
      "media_format TEXT",
      "referer TEXT",
      "page_url TEXT",
      "cookies TEXT",
      "cookies_txt TEXT",
      "user_agent TEXT",
      "queue_name TEXT DEFAULT 'main'",
      "description TEXT",
    ]) {
      try {
        this.db.exec(`ALTER TABLE downloads ADD COLUMN ${colDef};`);
      } catch (_) {}
    }

    // Recover interrupted downloads cleanly on startup
    try {
      this.db.exec(`
        UPDATE downloads
        SET status = CASE WHEN downloaded_size > 0 THEN 'paused' ELSE 'failed' END
        WHERE status IN ('downloading', 'probing', 'merging', 'queued');
      `);
    } catch (_) {}

    this.stmtUpsertDownload = this.db.prepare(`
      INSERT INTO downloads (
        id, url, destination, filename, total_size, downloaded_size, status,
        error_message, media_format, referer, page_url, cookies, cookies_txt, user_agent, queue_name, description, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        destination = excluded.destination,
        filename = excluded.filename,
        total_size = COALESCE(excluded.total_size, downloads.total_size),
        downloaded_size = excluded.downloaded_size,
        status = excluded.status,
        error_message = excluded.error_message,
        media_format = COALESCE(excluded.media_format, downloads.media_format),
        referer = COALESCE(excluded.referer, downloads.referer),
        page_url = COALESCE(excluded.page_url, downloads.page_url),
        cookies = COALESCE(excluded.cookies, downloads.cookies),
        cookies_txt = COALESCE(excluded.cookies_txt, downloads.cookies_txt),
        user_agent = COALESCE(excluded.user_agent, downloads.user_agent),
        queue_name = COALESCE(excluded.queue_name, downloads.queue_name),
        description = COALESCE(excluded.description, downloads.description)
    `);

    this.stmtUpsertChunk = this.db.prepare(`
      INSERT INTO chunks (download_id, chunk_id, start_byte, current_byte, end_byte, status)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(download_id, chunk_id) DO UPDATE SET
        start_byte = excluded.start_byte,
        current_byte = excluded.current_byte,
        end_byte = excluded.end_byte,
        status = excluded.status
    `);

    this.stmtGetDownload = this.db.prepare(`SELECT * FROM downloads WHERE id = ?`);
    this.stmtListDownloads = this.db.prepare(`SELECT * FROM downloads ORDER BY created_at DESC`);
    this.stmtGetChunks = this.db.prepare(`SELECT * FROM chunks WHERE download_id = ? ORDER BY start_byte ASC`);
    this.stmtDeleteChunks = this.db.prepare(`DELETE FROM chunks WHERE download_id = ?`);
    this.stmtDeleteDownload = this.db.prepare(`DELETE FROM downloads WHERE id = ?`);
    this.stmtGetSetting = this.db.prepare(`SELECT value FROM settings WHERE key = ?`);
    this.stmtSetSetting = this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
  }

  close() {
    try {
      this.db.close();
    } catch (_) {}
  }

  getDefaultDownloadDir() {
    const fallback = path.join(os.homedir(), "Downloads", "WarpDM");
    const dir = this.getSetting("default_download_dir", fallback);
    this.ensureDirectorySafe(dir);
    return dir;
  }

  ensureDirectorySafe(dirPath) {
    const resolved = path.resolve(dirPath);
    if (fs.existsSync(resolved)) {
      const st = fs.statSync(resolved);
      if (!st.isDirectory()) {
        const rescueTemp = `${resolved}.rescued_${Date.now()}.bak`;
        fs.renameSync(resolved, rescueTemp);
        fs.mkdirSync(resolved, { recursive: true });
        fs.renameSync(rescueTemp, path.join(resolved, "rescued_download.bin"));
      }
    } else {
      fs.mkdirSync(resolved, { recursive: true });
    }
    return resolved;
  }

  checkDiskSpace(targetDir, requiredBytes) {
    if (!requiredBytes || requiredBytes <= 0 || typeof fs.statfsSync !== "function") return;
    try {
      const dir = this.ensureDirectorySafe(targetDir);
      const stats = fs.statfsSync(dir);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      const minRequired = requiredBytes + 32 * 1024 * 1024;
      if (freeBytes > 0 && freeBytes < minRequired) {
        const needGb = (requiredBytes / 1073741824).toFixed(2);
        const freeGb = (freeBytes / 1073741824).toFixed(2);
        const err = new Error(`Insufficient disk space: need ${needGb} GB, only ${freeGb} GB available`);
        err.code = "ENOSPC";
        throw err;
      }
    } catch (err) {
      if (err.code === "ENOSPC") throw err;
    }
  }

  /**
   * Moves srcPath -> destPath safely across drives (EXDEV fallback) and retries transient Windows Defender locks.
   */
  safeMoveFileSync(srcPath, destPath) {
    this.ensureDirectorySafe(path.dirname(destPath));
    let lastErr = null;

    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        fs.renameSync(srcPath, destPath);
        return;
      } catch (err) {
        lastErr = err;
        if (err.code === "EXDEV") {
          // Cross-volume move (e.g. C: -> D:): stream copy + unlink
          const buf = Buffer.alloc(1024 * 1024);
          const rFd = fs.openSync(srcPath, "r");
          const wFd = fs.openSync(destPath, "w");
          try {
            let bytesRead = 0;
            while ((bytesRead = fs.readSync(rFd, buf, 0, buf.length, null)) > 0) {
              fs.writeSync(wFd, buf, 0, bytesRead);
            }
          } finally {
            fs.closeSync(rFd);
            fs.closeSync(wFd);
          }
          try {
            fs.unlinkSync(srcPath);
          } catch (_) {}
          return;
        }

        if (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") {
          // Brief synchronous wait via Atomics.wait for antivirus file-handle release
          const sab = new SharedArrayBuffer(4);
          Atomics.wait(new Int32Array(sab), 0, 0, 80 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  getSetting(key, fallback = null) {
    try {
      const row = this.stmtGetSetting.get(key);
      return row ? JSON.parse(row.value) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  setSetting(key, value) {
    this.stmtSetSetting.run(key, JSON.stringify(value));
  }

  getAllSettings() {
    return {
      default_download_dir: this.getDefaultDownloadDir(),
      category_dirs: this.getSetting("category_dirs", {}),
      temp_parts_dir: this.getSetting("temp_parts_dir", ""),
      max_connections: this.getSetting("max_connections", 8),
      max_concurrent_downloads: this.getSetting("max_concurrent_downloads", 4),
      quiet_mode: this.getSetting("quiet_mode", true),
      auto_capture: this.getSetting("auto_capture", true),
      ask_confirmation: this.getSetting("ask_confirmation", true),
      show_progress_popup: this.getSetting("show_progress_popup", true),
      show_complete_dialog: this.getSetting("show_complete_dialog", false),
      prestart_in_approval: this.getSetting("prestart_in_approval", false),
      duplicate_action: this.getSetting("duplicate_action", "rename"),
      custom_user_agent: this.getSetting("custom_user_agent", ""),
      category_subfolders: this.getSetting("category_subfolders", false),
      captured_file_types: this.getSetting(
        "captured_file_types",
        "3GP 7Z AAC APK AVI BIN BZ2 DMG EXE FLAC GZ IMG ISO M4A M4V MKV MOV MP3 MP4 MSI OGG PDF PPTX RAR TAR WAV WEBM XLSX XZ ZIP"
      ),
      excluded_domains: this.getSetting(
        "excluded_domains",
        "*.update.microsoft.com download.windowsupdate.com"
      ),
      speed_limit_kbps: this.getSetting("speed_limit_kbps", 0),
      speed_limit_startup: this.getSetting("speed_limit_startup", false),
      proxy_host: this.getSetting("proxy_host", ""),
      proxy_port: this.getSetting("proxy_port", ""),
      sound_complete: this.getSetting("sound_complete", false),
      sound_failed: this.getSetting("sound_failed", false),
      sound_queue_done: this.getSetting("sound_queue_done", false),
      scheduler_enabled: this.getSetting("scheduler_enabled", false),
      scheduler_start_time: this.getSetting("scheduler_start_time", "02:00"),
      scheduler_stop_enabled: this.getSetting("scheduler_stop_enabled", false),
      scheduler_stop_time: this.getSetting("scheduler_stop_time", "07:00"),
      scheduler_max_concurrent: this.getSetting("scheduler_max_concurrent", 2),
      scheduler_open_folder_on_done: this.getSetting("scheduler_open_folder_on_done", false),
      launch_on_startup: this.getSetting("launch_on_startup", false),
      clipboard_monitor: this.getSetting("clipboard_monitor", false),
      ui_theme: this.getSetting("ui_theme", "warp-dark"),
      toolbar_size: this.getSetting("toolbar_size", "large"),
      toolbar_style: this.getSetting("toolbar_style", "neon"),
      ui_language: this.getSetting("ui_language", "en"),
    };
  }

  downloadPartDir(downloadId) {
    const customTmp = this.getSetting("temp_parts_dir", "");
    if (customTmp && typeof customTmp === "string" && customTmp.trim()) {
      try {
        const resolvedTmp = this.ensureDirectorySafe(customTmp.trim());
        return path.join(resolvedTmp, downloadId);
      } catch (_) {}
    }
    return path.join(this.baseDataDir, downloadId);
  }

  cleanupPartDir(downloadId) {
    const partDir = this.downloadPartDir(downloadId);
    try {
      if (fs.existsSync(partDir)) {
        fs.rmSync(partDir, { recursive: true, force: true });
      }
    } catch (_) {}
  }

  chunkFilePath(downloadId, chunkId) {
    return path.join(this.downloadPartDir(downloadId), `chunk_${chunkId}.part`);
  }

  openChunkWriter(downloadId, chunkId, truncate = false) {
    const dir = this.downloadPartDir(downloadId);
    fs.mkdirSync(dir, { recursive: true });

    const filePath = this.chunkFilePath(downloadId, chunkId);
    const fd = fs.openSync(filePath, truncate ? "w" : "a+");
    return {
      fd,
      filePath,
      write(buffer) {
        fs.writeSync(fd, buffer);
      },
      close() {
        try {
          fs.closeSync(fd);
        } catch (_) {}
      },
    };
  }

  saveDownload(id, url, destination, filename, totalSize, status, extra = {}) {
    const now = new Date().toISOString();
    const downloadedSize =
      extra.downloadedSize !== undefined
        ? extra.downloadedSize
        : status === "completed" && totalSize
          ? totalSize
          : 0;

    this.stmtUpsertDownload.run(
      id,
      url,
      path.resolve(destination),
      filename,
      totalSize ?? null,
      downloadedSize ?? 0,
      status,
      extra.errorMessage ?? null,
      extra.mediaFormat ?? null,
      extra.referer ?? null,
      extra.pageUrl ?? null,
      extra.cookies ?? null,
      extra.cookiesTxt ?? null,
      extra.userAgent ?? null,
      extra.queueName ?? null,
      extra.description ?? null,
      now
    );
  }

  getDownload(id) {
    return this.stmtGetDownload.get(id);
  }

  getChunks(downloadId) {
    return this.stmtGetChunks.all(downloadId);
  }

  listDownloads() {
    return this.stmtListDownloads.all();
  }

  deleteDownload(id, deleteDiskFile = false) {
    const rec = this.getDownload(id);
    this.stmtDeleteChunks.run(id);
    this.stmtDeleteDownload.run(id);
    this.cleanupPartDir(id);

    if (deleteDiskFile && rec?.destination && fs.existsSync(rec.destination)) {
      try {
        if (fs.statSync(rec.destination).isFile()) {
          fs.unlinkSync(rec.destination);
        }
      } catch (_) {}
    }
    return true;
  }

  clearDownloadsByFilter(mode = "failed") {
    const all = this.listDownloads();
    let removed = 0;
    for (const item of all) {
      if (
        (mode === "failed" && (item.status === "failed" || item.status === "cancelled")) ||
        (mode === "completed" && item.status === "completed")
      ) {
        this.deleteDownload(item.id, false);
        removed++;
      }
    }
    return removed;
  }

  checkpointChunks(downloadId, chunks, totalDownloaded = null) {
    if (!this.getDownload(downloadId)) return;
    this.db.exec("BEGIN TRANSACTION;");
    try {
      for (const c of chunks) {
        this.stmtUpsertChunk.run(
          downloadId,
          c.id,
          c.startByte,
          c.currentByte,
          c.endByte,
          c.status
        );
      }
      if (totalDownloaded !== null) {
        this.db
          .prepare(`UPDATE downloads SET downloaded_size = ? WHERE id = ?`)
          .run(totalDownloaded, downloadId);
      }
      this.db.exec("COMMIT;");
    } catch (e) {
      this.db.exec("ROLLBACK;");
      throw e;
    }
  }

  assembleFinalFile(downloadId, chunksOrCount, destination) {
    const destDir = path.dirname(destination);
    this.ensureDirectorySafe(destDir);

    const tmpDest = `${destination}.warpdm_tmp`;
    const destFd = fs.openSync(tmpDest, "w");
    const buffer = Buffer.alloc(1024 * 1024);

    try {
      let orderedSpecs = [];
      if (Array.isArray(chunksOrCount)) {
        orderedSpecs = [...chunksOrCount]
          .sort((a, b) => a.startByte - b.startByte)
          .map((c) => ({
            id: c.id,
            expectedBytes: c.endByte >= c.startByte ? c.endByte - c.startByte + 1 : null,
          }));
      } else {
        for (let i = 0; i < chunksOrCount; i++) {
          orderedSpecs.push({ id: i, expectedBytes: null });
        }
      }

      for (const spec of orderedSpecs) {
        const partPath = this.chunkFilePath(downloadId, spec.id);
        if (!fs.existsSync(partPath)) {
          throw new Error(`Missing chunk file: ${partPath}`);
        }

        const partFd = fs.openSync(partPath, "r");
        let remaining = spec.expectedBytes;
        try {
          while (remaining === null || remaining > 0) {
            const toRead = remaining !== null ? Math.min(buffer.length, remaining) : buffer.length;
            const bytesRead = fs.readSync(partFd, buffer, 0, toRead, null);
            if (bytesRead <= 0) break;
            fs.writeSync(destFd, buffer, 0, bytesRead);
            if (remaining !== null) remaining -= bytesRead;
          }
        } finally {
          fs.closeSync(partFd);
        }
      }
    } catch (err) {
      try {
        fs.closeSync(destFd);
      } catch (_) {}
      try {
        if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
      } catch (_) {}
      throw err;
    }

    fs.closeSync(destFd);
    this.safeMoveFileSync(tmpDest, destination);
    this.cleanupPartDir(downloadId);
    this.stmtDeleteChunks.run(downloadId);
  }
}

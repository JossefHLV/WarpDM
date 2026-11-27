/**
 * Hogra Universal Streaming Video & Media Engine (v3.0)
 * - Smart YouTube Two-Try Strategy: runs unauthenticated visionos/tv clients FIRST (avoiding Chrome rotated-cookie
 *   "The page needs to be reloaded" error), retrying WITH cookies ONLY on age-gated/private/members-only videos!
 * - Automatic bundled node.exe JS challenge solver (--js-runtimes node:<path>)
 * - Authenticated cookies.txt on X/Twitter, Instagram, TikTok, Facebook, Reddit, Twitch, Vimeo
 * - Universal H.264 (avc1) + AAC (m4a) MP4 selection + UTF-8 --print-to-file path tracking
 */

import { EventEmitter } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProtocolHandler,
  DEFAULT_USER_AGENT,
  sanitizeFilename,
  formatDownloadError,
} from "../core/protocol.mjs";
import { DownloadSession } from "../core/session.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");

const YOUTUBE_HOST_RE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;
const YT_AUTH_REQUIRED_RE =
  /(sign in to confirm your age|age-restricted|inappropriate for some users|private video|members-only|available to this channel's members|join this channel|requires payment|login_required)/i;

export function isYouTubeUrl(rawUrl) {
  try {
    return YOUTUBE_HOST_RE.test(new URL(rawUrl).hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

function findNodeRuntimePath() {
  if (path.basename(process.execPath).toLowerCase().startsWith("node") && fs.existsSync(process.execPath)) {
    return process.execPath;
  }
  const bundled = path.join(PROJECT_ROOT, "runtime", "node.exe");
  return fs.existsSync(bundled) ? bundled : null;
}

const NODE_RUNTIME_PATH = findNodeRuntimePath();

const YTDLP_ENV = {
  ...process.env,
  PATH: NODE_RUNTIME_PATH
    ? `${path.dirname(NODE_RUNTIME_PATH)}${path.delimiter}${process.env.PATH || ""}`
    : process.env.PATH,
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
  PYTHONUNBUFFERED: "1",
};

const STREAMING_HOST_PATTERNS = [
  /(^|\.)youtube\.com$/i,
  /(^|\.)youtu\.be$/i,
  /(^|\.)youtube-nocookie\.com$/i,
  /(^|\.)tiktok\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)twitch\.tv$/i,
  /(^|\.)vimeo\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)fb\.watch$/i,
  /(^|\.)dailymotion\.com$/i,
  /(^|\.)reddit\.com$/i,
  /(^|\.)v\.redd\.it$/i,
  /(^|\.)soundcloud\.com$/i,
  /(^|\.)kick\.com$/i,
  /(^|\.)bilibili\.com$/i,
  /(^|\.)rumble\.com$/i,
  /(^|\.)odysee\.com$/i,
  /(^|\.)streamable\.com$/i,
];

let cachedYtDlpPath = undefined;
let cachedFfmpegPath = undefined;
let cachedJsRuntimeArgs = undefined;

export function findYtDlpPath() {
  if (cachedYtDlpPath !== undefined) return cachedYtDlpPath;

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    path.join(PROJECT_ROOT, "runtime", "yt-dlp.exe"),
    path.join(process.cwd(), "runtime", "yt-dlp.exe"),
  ];

  const pyRoot = path.join(localAppData, "Programs", "Python");
  if (fs.existsSync(pyRoot)) {
    try {
      for (const sub of fs.readdirSync(pyRoot)) {
        candidates.push(path.join(pyRoot, sub, "Scripts", "yt-dlp.exe"));
      }
    } catch (_) {}
  }

  candidates.push(
    path.join(localAppData, "Microsoft", "WinGet", "Links", "yt-dlp.exe"),
    "C:\\yt-dlp\\yt-dlp.exe"
  );

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      cachedYtDlpPath = c;
      return c;
    }
  }

  try {
    const out = execFileSync("where.exe", ["yt-dlp"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
    if (first) {
      cachedYtDlpPath = first;
      return first;
    }
  } catch (_) {}

  cachedYtDlpPath = null;
  return null;
}

export function findFfmpegPath() {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath;

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    path.join(PROJECT_ROOT, "runtime", "ffmpeg.exe"),
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    path.join(localAppData, "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
  ];

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      cachedFfmpegPath = c;
      return c;
    }
  }

  try {
    const out = execFileSync("where.exe", ["ffmpeg"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
    if (first) {
      cachedFfmpegPath = first;
      return first;
    }
  } catch (_) {}

  cachedFfmpegPath = null;
  return null;
}

function getYtDlpJsRuntimeArgs(ytDlpPath) {
  if (cachedJsRuntimeArgs !== undefined) return cachedJsRuntimeArgs;
  if (!NODE_RUNTIME_PATH) return (cachedJsRuntimeArgs = []);
  try {
    const helpOut = execFileSync(ytDlpPath, ["--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const args = [];
    if (helpOut.includes("--js-runtimes")) {
      args.push("--js-runtimes", `node:${NODE_RUNTIME_PATH}`);
    }
    if (helpOut.includes("--remote-components")) {
      args.push("--remote-components", "ejs:github");
    }
    cachedJsRuntimeArgs = args;
    return args;
  } catch (_) {
    return (cachedJsRuntimeArgs = []);
  }
}

export function resolveAndClassifyUrl(rawUrl, pageUrl = null) {
  let effectiveUrl = String(rawUrl || "").trim();

  if (effectiveUrl.startsWith("blob:")) {
    if (pageUrl && (pageUrl.startsWith("http://") || pageUrl.startsWith("https://"))) {
      effectiveUrl = pageUrl;
    } else {
      const stripped = effectiveUrl.slice(5);
      if (stripped.startsWith("http")) effectiveUrl = stripped;
    }
  }

  let isStreaming = false;
  try {
    const parsed = new URL(effectiveUrl);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    if (STREAMING_HOST_PATTERNS.some((re) => re.test(host))) {
      isStreaming = true;
    } else if (
      /\.m3u8($|[?#;])/i.test(effectiveUrl) ||
      /\.mpd($|[?#;])/i.test(effectiveUrl) ||
      pathname.endsWith(".m3u8") ||
      pathname.endsWith(".mpd")
    ) {
      isStreaming = true;
    }
  } catch (_) {}

  return { url: effectiveUrl, isStreaming };
}

function prepareTempCookiesFile(cookiesTxt, cookieHeader, targetUrl) {
  const tmpFile = path.join(
    os.tmpdir(),
    `hogra-cookies-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );

  if (cookiesTxt && typeof cookiesTxt === "string" && cookiesTxt.includes("# Netscape HTTP Cookie File")) {
    fs.writeFileSync(tmpFile, cookiesTxt, { encoding: "utf8", mode: 0o600 });
    return tmpFile;
  }

  if (cookieHeader && typeof cookieHeader === "string" && cookieHeader.trim()) {
    try {
      const u = new URL(targetUrl);
      const host = u.hostname.replace(/^www\./i, "");
      const isHttps = u.protocol === "https:";
      const isIp = /^(\d+\.){3}\d+$/.test(host) || host === "localhost";
      const domains = isIp ? [host] : [`.${host}`];
      if (host === "x.com") domains.push(".twitter.com");
      if (host === "twitter.com") domains.push(".x.com");
      if (host === "youtu.be") domains.push(".youtube.com");

      const expiry = Math.floor(Date.now() / 1000) + 86400 * 30;
      const lines = ["# Netscape HTTP Cookie File", ""];

      for (const pair of cookieHeader.split(";")) {
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim().replace(/[\r\n\t]/g, "");
        const val = pair.slice(eq + 1).trim().replace(/[\r\n\t]/g, "");
        if (!name) continue;
        for (const dom of domains) {
          const includeSub = dom.startsWith(".") ? "TRUE" : "FALSE";
          lines.push(`${dom}\t${includeSub}\t/\t${isHttps ? "TRUE" : "FALSE"}\t${expiry}\t${name}\t${val}`);
        }
      }

      if (lines.length > 2) {
        fs.writeFileSync(tmpFile, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
        return tmpFile;
      }
    } catch (_) {}
  }

  return null;
}

function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
}

/**
 * Probes available video/audio qualities (uses unauthenticated visionos/tv first on YouTube!).
 */
export async function probeMediaFormats(rawUrl, pageUrl = null, authOptions = {}) {
  const { url } = resolveAndClassifyUrl(rawUrl, pageUrl);
  const ytDlp = findYtDlpPath();
  if (!ytDlp) {
    throw new Error("yt-dlp media extractor not found on system");
  }

  const isYt = isYouTubeUrl(url);
  const cookieFile = prepareTempCookiesFile(authOptions.cookiesTxt, authOptions.cookies, url);

  const runProbeOnce = (useCookies, extraArgs = []) =>
    new Promise((resolve, reject) => {
      const args = [
        "--encoding",
        "utf-8",
        "--no-update",
        "--dump-single-json",
        "--no-playlist",
        "--no-warnings",
        "--skip-download",
        ...getYtDlpJsRuntimeArgs(ytDlp),
        ...extraArgs,
      ];

      if (useCookies && cookieFile) args.push("--cookies", cookieFile);
      if (authOptions.userAgent && !isYt) args.push("--user-agent", authOptions.userAgent);
      args.push(url);

      const proc = spawn(ytDlp, args, { windowsHide: true, env: YTDLP_ENV });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => (stdout += d.toString("utf8")));
      proc.stderr.on("data", (d) => (stderr += d.toString("utf8")));

      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0 && stdout.trim()) resolve(stdout);
        else reject(new Error(stderr.trim() || `Media probe exited with code ${code}`));
      });
    });

  try {
    let jsonText;
    if (isYt) {
      try {
        jsonText = await runProbeOnce(false);
      } catch (err) {
        if (cookieFile && YT_AUTH_REQUIRED_RE.test(err.message || "")) {
          jsonText = await runProbeOnce(true, ["--extractor-args", "youtube:player_client=default,mweb,web_creator"]);
        } else {
          throw err;
        }
      }
    } else {
      jsonText = await runProbeOnce(true);
    }

    const info = JSON.parse(jsonText);
    const formats = Array.isArray(info.formats) ? info.formats : [];

    let bestAudioBytes = 0;
    for (const f of formats) {
      if (f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none")) {
        const sz = f.filesize || f.filesize_approx || 0;
        if (sz > bestAudioBytes && (f.protocol === "https" || bestAudioBytes === 0)) {
          bestAudioBytes = sz;
        }
      }
    }

    const heightMap = new Map();
    for (const f of formats) {
      if (f.vcodec && f.vcodec !== "none" && f.height && f.height >= 144) {
        const h = f.height;
        const sz = (f.filesize || f.filesize_approx || 0) + (f.acodec === "none" ? bestAudioBytes : 0);
        const score =
          (f.protocol === "https" ? 1000 : 0) +
          (/^avc/i.test(f.vcodec || "") ? 500 : 0) +
          (f.filesize ? 200 : 0) +
          (f.tbr || 0) * 0.05;

        const existing = heightMap.get(h);
        if (!existing || score > existing.score) {
          heightMap.set(h, {
            height: h,
            fps: f.fps || null,
            score,
            approxBytes: sz > 0 ? sz : null,
          });
        }
      }
    }

    const sortedHeights = [...heightMap.values()].sort((a, b) => b.height - a.height);

    const qualityOptions = [
      {
        id: "best",
        label: "Best Quality (Auto MP4)",
        badge: sortedHeights[0] ? `${sortedHeights[0].height}p` : "HD",
        approxBytes: sortedHeights[0]?.approxBytes || null,
      },
    ];

    const tierLabels = {
      2160: "4K Ultra HD",
      1440: "2K QHD",
      1080: "Full HD",
      720: "HD",
      480: "SD",
      360: "Data Saver",
      240: "Low",
    };

    for (const item of sortedHeights) {
      if ([2160, 1440, 1080, 720, 480, 360, 240].includes(item.height)) {
        const tag = tierLabels[item.height] || `${item.height}p`;
        const fpsTag = item.fps && item.fps > 30 ? ` ${Math.round(item.fps)}fps` : "";
        qualityOptions.push({
          id: `${item.height}p`,
          label: `${item.height}p ${tag}${fpsTag} (MP4)`,
          badge: `${item.height}p`,
          approxBytes: item.approxBytes,
        });
      }
    }

    qualityOptions.push(
      {
        id: "audio-mp3",
        label: "Audio Only — MP3 (High Quality)",
        badge: "MP3",
        approxBytes: bestAudioBytes || null,
      },
      {
        id: "audio-m4a",
        label: "Audio Only — M4A (Original)",
        badge: "M4A",
        approxBytes: bestAudioBytes || null,
      }
    );

    return {
      url: info.webpage_url || url,
      title: info.title || "Video",
      uploader: info.uploader || info.channel || null,
      duration: info.duration || null,
      thumbnail: info.thumbnail || null,
      qualities: qualityOptions,
    };
  } finally {
    safeUnlink(cookieFile);
  }
}

function buildFormatArgs(qualityId, hasFfmpeg) {
  const q = String(qualityId || "best").toLowerCase();

  if (q === "audio-mp3") {
    return hasFfmpeg
      ? ["-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "0"]
      : ["-f", "bestaudio/best"];
  }

  if (q === "audio-m4a") {
    return hasFfmpeg
      ? ["-f", "bestaudio[ext=m4a]/bestaudio/best", "-x", "--audio-format", "m4a"]
      : ["-f", "bestaudio[ext=m4a]/bestaudio/best"];
  }

  const fastStartArgs = hasFfmpeg ? ["--ppa", "Merger+ffmpeg_o:-movflags +faststart"] : [];
  const heightMatch = q.match(/^(\d{3,4})p?$/);

  if (heightMatch) {
    const h = parseInt(heightMatch[1], 10);
    if (hasFfmpeg) {
      const fmt =
        h <= 1080
          ? `bestvideo[height<=${h}][vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`
          : `bestvideo[height<=${h}]+bestaudio[acodec^=mp4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
      return [
        "-f",
        fmt,
        "-S",
        `res:${h},vcodec:h264,acodec:m4a,proto:https`,
        "--merge-output-format",
        "mp4",
        ...fastStartArgs,
      ];
    }
    return ["-f", `best[height<=${h}][vcodec^=avc][ext=mp4]/best[height<=${h}][ext=mp4]/best[height<=${h}]/best`];
  }

  if (hasFfmpeg) {
    return [
      "-f",
      "bestvideo+bestaudio[acodec^=mp4a]/bestvideo+bestaudio/best",
      "-S",
      "res,vcodec:h264,acodec:m4a,proto:https",
      "--merge-output-format",
      "mp4",
      ...fastStartArgs,
    ];
  }
  return ["-f", "best[vcodec^=avc][ext=mp4]/best[ext=mp4]/best"];
}

function deriveInitialVideoFilename(rawName, url, quality) {
  const ext = quality === "audio-mp3" ? ".mp3" : quality === "audio-m4a" ? ".m4a" : ".mp4";
  if (rawName && typeof rawName === "string") {
    const trimmed = rawName.replace(/^\(\d+\)\s*/, "").trim();
    if (trimmed && !["video", "download", "fetching video info...", "fetching video info"].includes(trimmed.toLowerCase())) {
      const clean = sanitizeFilename(trimmed);
      if (/\.(mp4|mkv|webm|mp3|m4a|mov|avi)$/i.test(clean)) return clean;
      return sanitizeFilename(`${clean}${ext}`);
    }
  }

  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, "");
    const statusMatch = u.pathname.match(/\/status\/(\d+)/);
    if (statusMatch) return `${host}_${statusMatch[1]}${ext}`;
    const vParam = u.searchParams.get("v");
    if (vParam) return `youtube_${sanitizeFilename(vParam)}${ext}`;
    const lastSeg = u.pathname.split("/").filter(Boolean).pop();
    if (lastSeg && lastSeg.length < 60) return sanitizeFilename(`${host}_${lastSeg}${ext}`);
    return sanitizeFilename(`${host}_media${ext}`);
  } catch (_) {
    return `media_stream${ext}`;
  }
}

export class VideoDownloadSession extends EventEmitter {
  constructor(id, url, destinationDir, maxConnections = 8, storage, speedLimiter = null, options = {}) {
    super();
    this.id = id;
    this.url = url;
    this.destinationDir = storage.ensureDirectorySafe(destinationDir);
    this.maxConnections = Math.max(1, Math.min(16, maxConnections || 8));
    this.storage = storage;
    this.speedLimiter = speedLimiter;
    this.options = options;

    this.quality = options.quality || "best";
    this.state = "probing";
    this.statusText = "Connecting & negotiating stream...";
    this.filename = deriveInitialVideoFilename(options.filename, url, this.quality);
    this.destination = path.join(this.destinationDir, this.filename);
    this.totalBytes = options.initialTotalBytes || null;
    this.downloadedBytes = options.initialDownloadedBytes || 0;
    this.progressPercent = 0;
    this.bytesPerSec = 0;
    this.etaSeconds = null;
    this.errorMessage = null;
    this.isCancelled = false;
    this.isPaused = false;
    this.proc = null;
    this.postProcTimer = null;
    this.childHttpSession = null;
  }

  abortOnly() {
    this.isCancelled = true;
    this._killProcess();
    if (this.childHttpSession) this.childHttpSession.abortOnly();
  }

  pause() {
    if (this.childHttpSession) {
      this.isPaused = true;
      this.state = "paused";
      const ok = this.childHttpSession.pause();
      if (ok) this.emit("state_change", "paused");
      return ok;
    }
    if (this.state !== "downloading" && this.state !== "probing") return false;
    this.isPaused = true;
    this.state = "paused";
    this._killProcess();
    this.bytesPerSec = 0;
    this.etaSeconds = null;

    this.storage.saveDownload(
      this.id,
      this.url,
      this.destination,
      this.filename,
      this.totalBytes,
      "paused",
      {
        downloadedSize: this.downloadedBytes,
        mediaFormat: this.quality,
        referer: this.options.referer || null,
        pageUrl: this.options.pageUrl || null,
        cookies: this.options.cookies || null,
        cookiesTxt: this.options.cookiesTxt || null,
        userAgent: this.options.userAgent || null,
      }
    );
    this.emitProgress("paused");
    this.emit("state_change", "paused");
    return true;
  }

  cancel() {
    this.isCancelled = true;
    this.isPaused = false;
    this.state = "cancelled";
    this._killProcess();
    if (this.childHttpSession) this.childHttpSession.abortOnly();
    this.storage.deleteDownload(this.id, false);
    this.emitProgress("cancelled");
    this.emit("state_change", "cancelled");
  }

  _killProcess() {
    if (this.postProcTimer) {
      clearInterval(this.postProcTimer);
      this.postProcTimer = null;
    }
    if (this.proc && !this.proc.killed) {
      try {
        if (process.platform === "win32" && this.proc.pid) {
          spawn("taskkill", ["/PID", String(this.proc.pid), "/T", "/F"], { windowsHide: true });
        } else {
          this.proc.kill("SIGTERM");
        }
      } catch (_) {}
    }
  }

  _buildSyntheticChunks() {
    if (this.state === "failed" || this.state === "probing" || this.state === "queued") {
      return [];
    }
    const total = this.totalBytes || 100;
    const dl = Math.min(total, this.downloadedBytes || 0);
    const n = Math.min(this.maxConnections, 8);
    const segSize = Math.max(1, Math.floor(total / n));
    const pct =
      this.state === "completed"
        ? 1
        : this.progressPercent > 0
          ? Math.min(1, this.progressPercent / 100)
          : total > 0
            ? dl / total
            : 0;

    const chunks = [];
    for (let i = 0; i < n; i++) {
      const start = i * segSize;
      const end = i === n - 1 ? total - 1 : (i + 1) * segSize - 1;
      const cur = Math.min(end + 1, Math.floor(start + (end - start + 1) * pct));
      chunks.push({
        id: i,
        startByte: start,
        currentByte: this.state === "completed" ? end + 1 : cur,
        endByte: end,
        remainingBytes: Math.max(0, end - cur + 1),
        downloadedBytes: Math.max(0, cur - start),
        totalBytes: Math.max(1, end - start + 1),
        status:
          this.state === "completed"
            ? "completed"
            : this.state === "paused"
              ? "paused"
              : "downloading",
        workerId: this.state === "downloading" ? i : null,
      });
    }
    return chunks;
  }

  emitProgress(overrideState = null) {
    const st = overrideState || this.state;
    const pct =
      st === "completed"
        ? 100
        : st === "merging"
          ? Math.max(99.5, this.progressPercent)
          : this.progressPercent > 0
            ? Math.min(99.9, this.progressPercent)
            : this.totalBytes && this.totalBytes > 0
              ? Math.min(99.9, (this.downloadedBytes / this.totalBytes) * 100)
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
      totalBytes: this.totalBytes,
      downloadedBytes: st === "completed" && this.totalBytes ? this.totalBytes : this.downloadedBytes,
      progressPercent: pct,
      bytesPerSec: st === "downloading" ? Math.round(this.bytesPerSec) : 0,
      etaSeconds: st === "downloading" ? this.etaSeconds : null,
      activeConnections: st === "downloading" ? this.maxConnections : 0,
      mediaFormat: this.quality,
      errorMessage: this.errorMessage,
      chunks: this._buildSyntheticChunks(),
    });
  }

  async _runYtDlpForUrl(targetUrl, ytDlp, ffmpeg, cookieFile, extraArgs = []) {
    const partDir = this.storage.downloadPartDir(this.id);
    fs.mkdirSync(partDir, { recursive: true });
    const finalPathRecordFile = path.join(partDir, "final_filepath.txt");
    safeUnlink(finalPathRecordFile);

    const isTargetYt = isYouTubeUrl(targetUrl);
    const extHint = this.quality === "audio-mp3" ? "mp3" : this.quality === "audio-m4a" ? "m4a" : "mp4";
    const qualitySuffix =
      this.quality && this.quality !== "best" && !this.quality.startsWith("audio-")
        ? ` [${this.quality}]`
        : "";

    // If user customized filename in Approval Dialog, respect their exact chosen name!
    const outTemplate = this.options.customFilenameApproved
      ? path.join(this.destinationDir, `${path.basename(this.filename, path.extname(this.filename))}.%(ext)s`)
      : path.join(this.destinationDir, `%(title).140B${qualitySuffix}.%(ext)s`);

    const args = [
      "--encoding",
      "utf-8",
      "--no-update",
      "--no-playlist",
      "--progress",
      "--newline",
      "--continue",
      "--no-warnings",
      "--concurrent-fragments",
      String(this.maxConnections),
      "--progress-template",
      "download:HOGRA_PROG:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s|%(progress._percent_str)s",
      "--print",
      "before_dl:HOGRA_TITLE:%(title)s",
      "--print-to-file",
      "after_move:%(filepath)s",
      finalPathRecordFile,
      "-o",
      outTemplate,
      ...getYtDlpJsRuntimeArgs(ytDlp),
      ...extraArgs,
      ...buildFormatArgs(this.quality, !!ffmpeg),
    ];

    if (ffmpeg) {
      args.push("--ffmpeg-location", path.dirname(ffmpeg));
    }

    if (cookieFile) {
      args.push("--cookies", cookieFile);
    }

    if (this.speedLimiter?.bytesPerSecond > 0) {
      args.push("--limit-rate", String(Math.round(this.speedLimiter.bytesPerSecond)));
    }

    const customUa =
      this.options.headers?.["User-Agent"] ||
      this.options.headers?.["user-agent"] ||
      this.options.userAgent;

    if (customUa && !isTargetYt) {
      args.push("--user-agent", customUa);
    }

    if (this.options.referer && !isTargetYt) {
      args.push("--referer", this.options.referer);
    }

    if (!isTargetYt && (this.options.headers?.Origin || this.options.headers?.origin)) {
      args.push("--add-header", `Origin:${this.options.headers.Origin || this.options.headers.origin}`);
    }
    if (!isTargetYt && (this.options.headers?.Authorization || this.options.headers?.authorization)) {
      args.push("--add-header", `Authorization:${this.options.headers.Authorization || this.options.headers.authorization}`);
    }

    args.push(targetUrl);

    let stderrLines = [];
    let trackBaseBytes = 0;
    let currentTrackMax = 0;
    const startTs = Date.now() - 1500;

    try {
      await new Promise((resolve, reject) => {
        if (this.isCancelled || this.isPaused) return resolve();

        this.proc = spawn(ytDlp, args, { windowsHide: true, env: YTDLP_ENV });

        const handleLine = (rawLine) => {
          const line = rawLine.trim();
          if (!line) return;

          if (line.startsWith("HOGRA_TITLE:")) {
            const rawTitle = line.slice("HOGRA_TITLE:".length).trim();
            if (rawTitle && rawTitle !== "NA" && !this.options.customFilenameApproved) {
              this.filename = sanitizeFilename(`${rawTitle}${qualitySuffix}.${extHint}`);
              this.destination = path.join(this.destinationDir, this.filename);
            }
            this.state = "downloading";
            this.statusText = "Opening media stream...";
            this.progressPercent = Math.max(this.progressPercent, 3.5);
            this.storage.saveDownload(
              this.id,
              this.url,
              this.destination,
              this.filename,
              this.totalBytes,
              "downloading",
              {
                downloadedSize: this.downloadedBytes,
                mediaFormat: this.quality,
              }
            );
            this.emitProgress("downloading");
            return;
          }

          if (line.startsWith("[youtube]") || line.startsWith("[info]") || line.includes("Extracting URL")) {
            if (this.progressPercent < 2.5) {
              this.statusText = "Resolving stream manifest...";
              this.progressPercent = Math.max(this.progressPercent, 2.0);
              this.emitProgress("downloading");
            }
            return;
          }

          if (line.startsWith("HOGRA_PROG:")) {
            this.state = "downloading";
            this.statusText = "Receiving data...";
            const parts = line.slice("HOGRA_PROG:".length).split("|");
            const dl = parseFloat(parts[0]);
            const totExact = parseFloat(parts[1]);
            const totEst = parseFloat(parts[2]);
            const spd = parseFloat(parts[3]);
            const eta = parseFloat(parts[4]);
            const fragIdx = parseFloat(parts[5]);
            const fragCount = parseFloat(parts[6]);
            const pctRaw = parseFloat(String(parts[7] || "").replace("%", "").trim());

            if (!isNaN(dl)) {
              if (dl < currentTrackMax * 0.3 && currentTrackMax > 256 * 1024) {
                trackBaseBytes += currentTrackMax;
                currentTrackMax = 0;
              }
              if (dl > currentTrackMax) currentTrackMax = dl;
              this.downloadedBytes = Math.round(trackBaseBytes + dl);
            }

            const trackTotal =
              !isNaN(totExact) && totExact > 0 ? totExact : !isNaN(totEst) && totEst > 0 ? totEst : null;
            if (trackTotal !== null) {
              this.totalBytes = Math.max(this.totalBytes || 0, Math.round(trackBaseBytes + trackTotal));
            }

            // Scale download phase smoothly across 0% -> 94% (reserving 94%->99.5% for FFmpeg audio/MP4 muxing!)
            const capPct = this.quality.startsWith("audio-") ? 92.0 : 96.0;
            if (this.totalBytes && this.totalBytes > 0 && this.downloadedBytes > 0) {
              const rawRatio = Math.min(1, this.downloadedBytes / this.totalBytes);
              this.progressPercent = Math.max(this.progressPercent, Math.min(capPct, rawRatio * capPct));
            } else if (!isNaN(fragCount) && fragCount > 0 && !isNaN(fragIdx) && fragIdx >= 0) {
              const fRatio = Math.min(1, (fragIdx + 1) / fragCount);
              this.progressPercent = Math.max(this.progressPercent, Math.min(capPct, fRatio * capPct));
              if (this.downloadedBytes > 0 && fRatio >= 0.02) {
                this.totalBytes = Math.round(this.downloadedBytes / fRatio);
              }
            } else if (!isNaN(pctRaw) && pctRaw > 0 && pctRaw <= 100) {
              this.progressPercent = Math.max(this.progressPercent, Math.min(capPct, (pctRaw / 100) * capPct));
            }

            this.bytesPerSec = !isNaN(spd) && spd > 0 ? spd : this.bytesPerSec;
            this.etaSeconds = !isNaN(eta) && eta >= 0 ? Math.ceil(eta) : null;

            this.emitProgress("downloading");
            return;
          }

          if (line.startsWith("[Merger]") || line.startsWith("[ExtractAudio]") || line.startsWith("[Fixup")) {
            this.state = "merging";
            this.statusText = line.startsWith("[ExtractAudio]")
              ? "Converting audio to MP3 (FFmpeg)..."
              : "Remuxing video & audio into MP4 (FFmpeg)...";
            this.bytesPerSec = 0;
            this.etaSeconds = 1;
            this.progressPercent = Math.max(this.progressPercent, 93.0);
            this.emitProgress("merging");

            if (!this.postProcTimer) {
              this.postProcTimer = setInterval(() => {
                if (this.isCancelled || this.isPaused || this.state === "completed" || this.state === "failed") {
                  clearInterval(this.postProcTimer);
                  this.postProcTimer = null;
                  return;
                }
                if (this.progressPercent < 99.2) {
                  this.progressPercent = Math.min(99.2, this.progressPercent + 0.9);
                  this.emitProgress("merging");
                }
              }, 220);
            }
          }
        };

        let outBuf = "";
        this.proc.stdout.on("data", (chunk) => {
          outBuf += chunk.toString("utf8");
          const lines = outBuf.split(/\r?\n|\r/);
          outBuf = lines.pop() || "";
          for (const l of lines) handleLine(l);
        });

        let errBuf = "";
        this.proc.stderr.on("data", (chunk) => {
          errBuf += chunk.toString("utf8");
          const lines = errBuf.split(/\r?\n|\r/);
          errBuf = lines.pop() || "";
          for (const l of lines) {
            const trimmed = l.trim();
            if (!trimmed) continue;
            if (
              trimmed.startsWith("HOGRA_") ||
              trimmed.startsWith("[") ||
              trimmed.includes("Extracting URL")
            ) {
              handleLine(trimmed);
            } else {
              stderrLines.push(trimmed);
            }
          }
        });

        this.proc.on("error", reject);
        this.proc.on("close", (code) => {
          if (this.postProcTimer) {
            clearInterval(this.postProcTimer);
            this.postProcTimer = null;
          }
          if (outBuf.trim()) handleLine(outBuf);
          if (errBuf.trim()) {
            const t = errBuf.trim();
            if (t.startsWith("HOGRA_") || t.startsWith("[")) handleLine(t);
            else stderrLines.push(t);
          }
          if (this.isCancelled || this.isPaused) return resolve();
          if (code === 0) {
            resolve();
          } else {
            const lastErr = stderrLines.slice(-2).join(" | ") || `Video extractor exited with code ${code}`;
            reject(new Error(lastErr));
          }
        });
      });

      if (this.isCancelled || this.isPaused) return null;

      let resolvedFile = null;
      if (fs.existsSync(finalPathRecordFile)) {
        const lines = fs
          .readFileSync(finalPathRecordFile, "utf8")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        const lastPath = lines.pop();
        if (lastPath && fs.existsSync(lastPath)) {
          resolvedFile = lastPath;
        }
      }

      if (!resolvedFile && !fs.existsSync(this.destination)) {
        try {
          const recent = fs
            .readdirSync(this.destinationDir)
            .map((name) => {
              const full = path.join(this.destinationDir, name);
              const st = fs.statSync(full);
              return { full, isFile: st.isFile(), mtimeMs: st.mtimeMs };
            })
            .filter((f) => f.isFile && f.mtimeMs >= startTs && !f.full.endsWith(".part") && !f.full.endsWith(".ytdl"))
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
          if (recent.length > 0) resolvedFile = recent[0].full;
        } catch (_) {}
      }

      this.storage.cleanupPartDir(this.id);
      return resolvedFile || this.destination;
    } catch (err) {
      this.storage.cleanupPartDir(this.id);
      throw err;
    }
  }

  async _discoverFallbackStreams() {
    const candidates = [];
    const seen = new Set();
    const addCandidate = (u) => {
      if (u && typeof u === "string" && u.startsWith("http") && !seen.has(u) && u !== this.url) {
        seen.add(u);
        candidates.push(u);
      }
    };

    for (const s of this.options.fallbackStreams || []) addCandidate(s);
    if (isYouTubeUrl(this.url)) return candidates;

    try {
      const proto = new ProtocolHandler(this.options.userAgent || DEFAULT_USER_AGENT);
      const headers = {};
      if (this.options.cookies) headers.Cookie = this.options.cookies;
      if (this.options.referer) headers.Referer = this.options.referer;

      const res = await proto.rawRequest(this.url, { method: "GET", headers, timeoutMs: 12000 });
      const ct = String(res.headers["content-type"] || "").toLowerCase();

      if (ct.startsWith("video/") || ct.startsWith("audio/") || ct.includes("mpegurl") || ct.includes("dash+xml")) {
        res.destroy();
        candidates.unshift(res.finalUrl || this.url);
        return candidates;
      }

      if (ct.includes("text/html")) {
        res.destroy();
        const { html } = await proto._readHtmlSnippet(res.finalUrl || this.url, proto.userAgent, headers, 900 * 1024);
        const unescaped = html.replace(/\\\//g, "/").replace(/\\u0026/g, "&").replace(/&amp;/g, "&");

        const metaRegex = /<meta[^>]+(?:property|name)=["'](?:og:video(?::secure_url|:url)?|twitter:player:stream)["'][^>]+content=["'](https?:\/\/[^"']+)["']/gi;
        let m;
        while ((m = metaRegex.exec(unescaped)) !== null) addCandidate(m[1]);

        const tagRegex = /<(?:video|source)[^>]+src=["'](https?:\/\/[^"']+)["']/gi;
        while ((m = tagRegex.exec(unescaped)) !== null) addCandidate(m[1]);

        const streamRegex = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4|webm|m4v)(?:\?[^\s"'<>\\]*)?/gi;
        while ((m = streamRegex.exec(unescaped)) !== null) {
          if (!/preview|sprite|thumb|poster/i.test(m[0])) addCandidate(m[0]);
        }
      } else {
        res.destroy();
      }
    } catch (_) {}

    return candidates;
  }

  async _runFfmpegStreamFallback(manifestUrl, ffmpeg) {
    const outPath = path.join(
      this.destinationDir,
      this.filename.endsWith(".mp4") ? this.filename : `${path.basename(this.filename, path.extname(this.filename))}.mp4`
    );

    const headerLines = [];
    if (this.options.referer) headerLines.push(`Referer: ${this.options.referer}`);
    if (this.options.cookies) headerLines.push(`Cookie: ${this.options.cookies}`);

    const args = ["-y", "-user_agent", this.options.userAgent || DEFAULT_USER_AGENT];
    if (headerLines.length > 0) {
      args.push("-headers", headerLines.join("\r\n") + "\r\n");
    }
    args.push(
      "-i",
      manifestUrl,
      "-c",
      "copy",
      "-bsf:a",
      "aac_adtstoasc",
      "-movflags",
      "+faststart",
      "-progress",
      "pipe:1",
      outPath
    );

    this.state = "downloading";
    this.emitProgress("downloading");

    await new Promise((resolve, reject) => {
      this.proc = spawn(ffmpeg, args, { windowsHide: true });
      let lastBytes = 0;
      let lastTs = performance.now();

      this.proc.stdout.on("data", (d) => {
        const text = d.toString("utf8");
        const szMatch = text.match(/total_size=(\d+)/);
        if (szMatch) {
          const cur = parseInt(szMatch[1], 10);
          const now = performance.now();
          const dt = (now - lastTs) / 1000;
          if (dt >= 0.25) {
            this.bytesPerSec = Math.max(0, (cur - lastBytes) / dt);
            lastBytes = cur;
            lastTs = now;
          }
          this.downloadedBytes = cur;
          this.emitProgress("downloading");
        }
      });

      this.proc.on("error", reject);
      this.proc.on("close", (code) => {
        if (this.isCancelled || this.isPaused) return resolve();
        if (code === 0 && fs.existsSync(outPath)) resolve();
        else reject(new Error(`FFmpeg stream capture exited with code ${code}`));
      });
    });

    return outPath;
  }

  async start() {
    const ytDlp = findYtDlpPath();
    const ffmpeg = findFfmpegPath();
    const isYt = isYouTubeUrl(this.url);
    const cookieFile = prepareTempCookiesFile(this.options.cookiesTxt, this.options.cookies, this.url);

    try {
      this.state = "probing";
      this.errorMessage = null;
      this.storage.saveDownload(this.id, this.url, this.destination, this.filename, null, "probing", {
        downloadedSize: this.downloadedBytes,
        mediaFormat: this.quality,
        referer: this.options.referer || null,
        pageUrl: this.options.pageUrl || null,
        cookies: this.options.cookies || null,
        cookiesTxt: this.options.cookiesTxt || null,
        userAgent: this.options.userAgent || null,
      });
      this.emitProgress("probing");

      let finalFile = null;
      let primaryErr = null;

      if (ytDlp) {
        if (isYt) {
          // Try 1: Unauthenticated YouTube (uses visionos / tv_samsung — immune to Chrome rotated-cookie failure!)
          try {
            finalFile = await this._runYtDlpForUrl(this.url, ytDlp, ffmpeg, null);
          } catch (err) {
            primaryErr = err;
            // Try 2: Retry WITH cookies ONLY if video is age-gated, private, or members-only!
            if (
              cookieFile &&
              !this.isCancelled &&
              !this.isPaused &&
              YT_AUTH_REQUIRED_RE.test(err.message || "")
            ) {
              try {
                primaryErr = null;
                finalFile = await this._runYtDlpForUrl(this.url, ytDlp, ffmpeg, cookieFile, [
                  "--extractor-args",
                  "youtube:player_client=default,mweb,web_creator",
                ]);
              } catch (authErr) {
                primaryErr = authErr;
              }
            }
          }
        } else {
          try {
            finalFile = await this._runYtDlpForUrl(this.url, ytDlp, ffmpeg, cookieFile);
          } catch (err) {
            primaryErr = err;
          }
        }
      } else {
        primaryErr = new Error("yt-dlp not found");
      }

      if (!finalFile && !this.isCancelled && !this.isPaused && (!isYt || this.options.fallbackStreams?.length)) {
        const candidates = await this._discoverFallbackStreams();

        for (const candidateUrl of candidates) {
          if (this.isCancelled || this.isPaused) break;
          const isManifest = /\.m3u8($|[?#;])/i.test(candidateUrl) || /\.mpd($|[?#;])/i.test(candidateUrl);

          if (isManifest) {
            if (ytDlp) {
              try {
                finalFile = await this._runYtDlpForUrl(candidateUrl, ytDlp, ffmpeg, cookieFile);
                if (finalFile && fs.existsSync(finalFile)) break;
              } catch (_) {}
            }
            if (ffmpeg) {
              try {
                finalFile = await this._runFfmpegStreamFallback(candidateUrl, ffmpeg);
                if (finalFile && fs.existsSync(finalFile)) break;
              } catch (_) {}
            }
          } else {
            try {
              const httpSession = new DownloadSession(
                this.id,
                candidateUrl,
                this.destinationDir,
                this.maxConnections,
                this.storage,
                this.speedLimiter,
                {
                  filename: this.filename,
                  referer: this.options.referer || this.url,
                  cookies: this.options.cookies || null,
                  headers: this.options.headers || null,
                }
              );
              this.childHttpSession = httpSession;
              httpSession.on("progress", (p) => this.emit("progress", p));
              await httpSession.start();
              this.childHttpSession = null;

              if (this.isCancelled || this.isPaused) return;

              if (httpSession.state === "completed" && fs.existsSync(httpSession.destination)) {
                this.destination = httpSession.destination;
                this.filename = path.basename(httpSession.destination);
                this.state = "completed";
                this.emit("completed", {
                  downloadId: this.id,
                  filename: this.filename,
                  destination: this.destination,
                  totalBytes: fs.statSync(this.destination).size,
                });
                return;
              }
            } catch (_) {}
          }
        }
      }

      if (!finalFile && primaryErr && !this.isCancelled && !this.isPaused) {
        let cleanMsg = primaryErr.message;
        if (cleanMsg.includes("onboarding/web") || cleanMsg.includes("redirect_after_login")) {
          cleanMsg = "X.com requires login cookies or a direct tweet link";
        }
        throw new Error(cleanMsg);
      }

      if (this.isCancelled || this.isPaused) return;

      if (finalFile && fs.existsSync(finalFile)) {
        this.destination = finalFile;
        this.filename = path.basename(finalFile);
      }

      const finalSize = fs.existsSync(this.destination)
        ? fs.statSync(this.destination).size
        : this.totalBytes || this.downloadedBytes;

      this.totalBytes = finalSize;
      this.downloadedBytes = finalSize;
      this.bytesPerSec = 0;
      this.etaSeconds = 0;
      this.state = "completed";

      this.storage.saveDownload(
        this.id,
        this.url,
        this.destination,
        this.filename,
        finalSize,
        "completed",
        {
          downloadedSize: finalSize,
          mediaFormat: this.quality,
          referer: this.options.referer || null,
          pageUrl: this.options.pageUrl || null,
          cookies: this.options.cookies || null,
          cookiesTxt: this.options.cookiesTxt || null,
        }
      );

      this.emitProgress("completed");
      this.emit("completed", {
        downloadId: this.id,
        filename: this.filename,
        destination: this.destination,
        totalBytes: finalSize,
      });
    } catch (err) {
      if (this.isCancelled || this.isPaused) return;
      this.state = "failed";
      this.errorMessage = formatDownloadError(err);
      this.bytesPerSec = 0;
      this.etaSeconds = null;

      this.storage.saveDownload(
        this.id,
        this.url,
        this.destination,
        this.filename,
        this.totalBytes,
        "failed",
        {
          downloadedSize: this.downloadedBytes,
          errorMessage: this.errorMessage,
          mediaFormat: this.quality,
          referer: this.options.referer || null,
          pageUrl: this.options.pageUrl || null,
          cookies: this.options.cookies || null,
          cookiesTxt: this.options.cookiesTxt || null,
        }
      );

      this.emitProgress("failed");
      this.emit("error", err);
    } finally {
      safeUnlink(cookieFile);
    }
  }
}

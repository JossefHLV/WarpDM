/**
 * Protocol Handler (v2.5 Universal Edition)
 * - Resilient HTTP/HTTPS engine with multi-profile User-Agent fallback
 * - Smart direct file-host resolvers (Google Drive + virus-scan form, MediaFire CDN, Dropbox, GitHub, Pixeldrain, OneDrive)
 * - Redirect & cookie jar tracking, true 206 Range verification, and HTML landing-page trap protection
 */

import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

export const USER_AGENT_PROFILES = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Wget/1.21.4",
];

export const DEFAULT_USER_AGENT = USER_AGENT_PROFILES[0];

const MIME_EXT_MAP = {
  "application/zip": ".zip",
  "application/x-zip-compressed": ".zip",
  "application/x-rar-compressed": ".rar",
  "application/vnd.rar": ".rar",
  "application/x-7z-compressed": ".7z",
  "application/gzip": ".gz",
  "application/x-tar": ".tar",
  "application/pdf": ".pdf",
  "application/x-msdownload": ".exe",
  "application/vnd.microsoft.portable-executable": ".exe",
  "application/x-msi": ".msi",
  "application/vnd.android.package-archive": ".apk",
  "application/x-iso9660-image": ".iso",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "audio/flac": ".flac",
  "audio/ogg": ".ogg",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export function parseRetryAfterMs(headerVal) {
  if (!headerVal) return null;
  const raw = String(headerVal).trim();
  const secs = Number(raw);
  if (!isNaN(secs) && secs >= 0) {
    return Math.min(30000, Math.max(1000, Math.round(secs * 1000)));
  }
  const dateMs = Date.parse(raw);
  if (!isNaN(dateMs)) {
    return Math.min(30000, Math.max(1000, dateMs - Date.now()));
  }
  return null;
}

function makeHttpError(statusCode, headers) {
  const err = new Error(`Server returned HTTP error status ${statusCode}`);
  err.statusCode = statusCode;
  err.retryAfterMs = parseRetryAfterMs(headers?.["retry-after"]);
  return err;
}

const EXPECTED_BINARY_EXT_RE =
  /\.(zip|rar|7z|tar|gz|bz2|xz|iso|img|exe|msi|apk|dmg|bin|dat|mp4|mkv|webm|avi|mov|mp3|m4a|flac|wav|pdf)$/i;

/**
 * Rewrites sharing/viewer URLs from popular cloud hosts into direct binary download URLs.
 */
export function resolveDirectHostUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();

    // 1. Dropbox: force ?dl=1
    if ((host === "dropbox.com" || host.endsWith(".dropbox.com")) && /^\/(s|scl|sh)\//i.test(u.pathname)) {
      u.searchParams.set("dl", "1");
      u.searchParams.delete("raw");
      return u.toString();
    }

    // 2. Google Drive: /file/d/<ID>/view or /open?id=<ID> -> direct download
    if (host === "drive.google.com") {
      const fileMatch = u.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
      const id = fileMatch ? fileMatch[1] : u.searchParams.get("id");
      if (id) {
        return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
      }
    }

    // 3. GitHub blob -> raw.githubusercontent.com
    if (host === "github.com") {
      const blobMatch = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
      if (blobMatch) {
        return `https://raw.githubusercontent.com/${blobMatch[1]}/${blobMatch[2]}/${blobMatch[3]}`;
      }
    }

    // 4. Pixeldrain viewer -> API file download
    if (host === "pixeldrain.com" || host === "www.pixeldrain.com") {
      const pdMatch = u.pathname.match(/^\/u\/([a-zA-Z0-9_-]+)/);
      if (pdMatch) {
        return `https://pixeldrain.com/api/file/${pdMatch[1]}?download`;
      }
    }

    // 5. OneDrive / SharePoint shared links -> download=1
    if (host.endsWith(".sharepoint.com") || host === "onedrive.live.com") {
      if (!u.searchParams.has("download")) {
        u.searchParams.set("download", "1");
        return u.toString();
      }
    }
  } catch (_) {}
  return rawUrl;
}

export class ProtocolHandler {
  constructor(customUserAgent = null) {
    this.userAgent = customUserAgent;
  }

  async rawRequest(urlStr, options = {}, maxRedirects = 10) {
    let currentUrl = urlStr;
    let cookieJar = options.headers?.Cookie || options.headers?.cookie || "";
    let method = options.method || "GET";

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const parsed = new URL(currentUrl);
      const client = parsed.protocol === "https:" ? https : http;

      const reqHeaders = {
        "User-Agent": options.userAgent || this.userAgent || DEFAULT_USER_AGENT,
        Accept: "*/*",
        "Accept-Encoding": "identity",
        Connection: "keep-alive",
        ...options.headers,
      };

      if (cookieJar) {
        reqHeaders.Cookie = cookieJar;
      }

      for (const k of Object.keys(reqHeaders)) {
        if (reqHeaders[k] === undefined || reqHeaders[k] === null || reqHeaders[k] === "") {
          delete reqHeaders[k];
        }
      }

      const res = await new Promise((resolve, reject) => {
        let settled = false;
        const safeReject = (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        };

        if (options.signal?.aborted) {
          return safeReject(new Error("Request aborted"));
        }

        const req = client.request(
          parsed,
          {
            method,
            headers: reqHeaders,
            timeout: options.timeoutMs || 25000,
          },
          (response) => {
            settled = true;
            resolve(response);
          }
        );

        const onAbort = () => {
          safeReject(new Error("Request aborted"));
          req.destroy();
        };

        if (options.signal) {
          options.signal.addEventListener("abort", onAbort, { once: true });
          req.on("close", () => options.signal.removeEventListener("abort", onAbort));
        }

        req.on("timeout", () => {
          safeReject(new Error("Connection timed out"));
          req.destroy();
        });

        req.on("error", (err) => safeReject(err));
        req.end();
      });

      const setCookies = res.headers["set-cookie"];
      if (Array.isArray(setCookies) && setCookies.length > 0) {
        const pairs = setCookies.map((c) => c.split(";")[0]).filter(Boolean);
        cookieJar = [cookieJar, ...pairs].filter(Boolean).join("; ");
      }

      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        currentUrl = new URL(res.headers.location, currentUrl).toString();
        if (res.statusCode === 303) {
          method = "GET";
        }
        continue;
      }

      res.finalUrl = currentUrl;
      res.cookieJar = cookieJar;
      return res;
    }

    throw new Error("Too many HTTP redirects");
  }

  async _readHtmlSnippet(url, ua, customHeaders, maxBytes = 350 * 1024) {
    const res = await this.rawRequest(url, {
      method: "GET",
      userAgent: ua,
      headers: { ...customHeaders, "Accept-Encoding": "gzip, deflate" },
      timeoutMs: 15000,
    });
    const stream = wrapDecompression(res);
    const chunks = [];
    let total = 0;
    try {
      for await (const c of stream) {
        chunks.push(c);
        total += c.length;
        if (total >= maxBytes) {
          res.destroy();
          break;
        }
      }
    } catch (_) {}
    return { html: Buffer.concat(chunks).toString("utf8"), cookies: res.cookieJar };
  }

  /**
   * Resolves HTML interstitial landing pages for Google Drive (>100MB virus warning) and MediaFire.
   */
  async _resolveHtmlInterstitial(targetUrl, ua, customHeaders) {
    try {
      const host = new URL(targetUrl).hostname.toLowerCase();
      if (host.includes("drive.google.com") || host.includes("drive.usercontent.google.com")) {
        const { html } = await this._readHtmlSnippet(targetUrl, ua, customHeaders);
        const formMatch = html.match(/<form[^>]+id=["']download-form["'][^>]+action=["']([^"']+)["']/i);
        if (formMatch) {
          const confirmedUrl = new URL(formMatch[1].replace(/&amp;/g, "&"), targetUrl);
          const inputRegex = /<input[^>]+name=["']([^"']+)["'][^>]+value=["']([^"']*)["']/gi;
          let m;
          while ((m = inputRegex.exec(html)) !== null) {
            confirmedUrl.searchParams.set(m[1], m[2]);
          }
          return confirmedUrl.toString();
        }
      }

      if (host.includes("mediafire.com")) {
        const { html } = await this._readHtmlSnippet(targetUrl, ua, customHeaders);
        const directMatch = html.match(/id=["']downloadButton["'][^>]*href=["'](https?:\/\/download[^"']+)["']/i)
          || html.match(/href=["'](https?:\/\/download\d*\.mediafire\.com\/[^"']+)["']/i);
        if (directMatch) return directMatch[1];

        const scrambled = html.match(/data-scrambled-url=["']([^"']+)["']/i);
        if (scrambled) {
          const decoded = Buffer.from(scrambled[1], "base64").toString("utf8");
          if (decoded.startsWith("http")) return decoded;
        }
      }
    } catch (_) {}
    return null;
  }

  /**
   * Probe a remote URL to discover its file size, verified Range support, filename, and winning UA profile.
   */
  async probe(rawUrl, customHeaders = {}, preferredFilename = null) {
    let url = resolveDirectHostUrl(rawUrl);

    const profiles = this.userAgent
      ? [this.userAgent, ...USER_AGENT_PROFILES.filter((u) => u !== this.userAgent)]
      : [...USER_AGENT_PROFILES];

    let lastErr = null;

    for (const ua of profiles) {
      try {
        let usedRangeProbe = true;
        let res = await this.rawRequest(url, {
          method: "GET",
          userAgent: ua,
          headers: {
            ...customHeaders,
            Range: "bytes=0-0",
          },
          timeoutMs: 15000,
        });

        res.destroy();

        if (res.statusCode === 416 || res.statusCode === 400 || res.statusCode === 501) {
          usedRangeProbe = false;
          res = await this.rawRequest(url, {
            method: "GET",
            userAgent: ua,
            headers: { ...customHeaders },
            timeoutMs: 15000,
          });
          res.destroy();
        }

        if (res.statusCode === 429 || res.statusCode === 503) {
          const waitMs = parseRetryAfterMs(res.headers["retry-after"]) || 2000;
          await new Promise((r) => setTimeout(r, waitMs));
          lastErr = makeHttpError(res.statusCode, res.headers);
          continue;
        }

        if (res.statusCode === 403 || res.statusCode === 406) {
          lastErr = makeHttpError(res.statusCode, res.headers);
          continue;
        }

        if (res.statusCode < 200 || res.statusCode >= 400) {
          throw makeHttpError(res.statusCode, res.headers);
        }

        let currentFinalUrl = res.finalUrl || url;
        let h = res.headers;
        let contentType = String(h["content-type"] || "").toLowerCase();

        // Check if Google Drive or MediaFire returned an HTML interstitial download page
        if (contentType.includes("text/html") && !h["content-disposition"]) {
          const unwrapped = await this._resolveHtmlInterstitial(currentFinalUrl, ua, {
            ...customHeaders,
            Cookie: res.cookieJar || customHeaders.Cookie,
          });
          if (unwrapped && unwrapped !== currentFinalUrl) {
            usedRangeProbe = true;
            res = await this.rawRequest(unwrapped, {
              method: "GET",
              userAgent: ua,
              headers: {
                ...customHeaders,
                Cookie: res.cookieJar || customHeaders.Cookie,
                Range: "bytes=0-0",
              },
              timeoutMs: 15000,
            });
            res.destroy();
            currentFinalUrl = res.finalUrl || unwrapped;
            h = res.headers;
            contentType = String(h["content-type"] || "").toLowerCase();
          }
        }

        // HTML Landing-Page Trap Protection: never save an HTML login/error page as a corrupt .zip/.exe!
        if (
          contentType.includes("text/html") &&
          !String(h["content-disposition"] || "").toLowerCase().includes("attachment")
        ) {
          const pathnameOnly = new URL(currentFinalUrl).pathname;
          if (EXPECTED_BINARY_EXT_RE.test(pathnameOnly)) {
            throw new Error("Remote link returned an HTML webpage instead of the binary file (login required or expired link)");
          }
        }

        const contentRange = h["content-range"];
        const isPartial = res.statusCode === 206;

        // Only trust acceptsRanges = true if Range: bytes=0-0 actually returned 206 Partial Content!
        // (Prevents servers that return 200 OK with a fake static 'Accept-Ranges: bytes' header from breaking workers!)
        const acceptsRanges = usedRangeProbe
          ? isPartial
          : typeof h["accept-ranges"] === "string" && h["accept-ranges"].toLowerCase() === "bytes";

        let contentLength = null;
        if (contentRange) {
          const match = String(contentRange).match(/\/(\d+)$/);
          if (match) {
            contentLength = parseInt(match[1], 10);
          }
        }
        if (contentLength === null && h["content-length"]) {
          const parsedCl = parseInt(h["content-length"], 10);
          if (!isNaN(parsedCl) && !isPartial) {
            contentLength = parsedCl;
          }
        }

        if (contentLength === null && isPartial) {
          try {
            const headRes = await this.rawRequest(currentFinalUrl, {
              method: "HEAD",
              userAgent: ua,
              headers: customHeaders,
              timeoutMs: 10000,
            });
            headRes.destroy();
            if (headRes.headers["content-length"]) {
              const cl = parseInt(headRes.headers["content-length"], 10);
              if (!isNaN(cl) && cl > 1) contentLength = cl;
            }
          } catch (_) {}
        }

        const filename = extractFilename(h, currentFinalUrl, h["content-type"] || null, preferredFilename);

        this.userAgent = ua;
        return {
          url: currentFinalUrl,
          filename,
          contentLength,
          acceptsRanges,
          contentType: h["content-type"] || null,
          etag: h["etag"] || null,
          lastModified: h["last-modified"] || null,
          userAgent: ua,
          cookies: res.cookieJar || null,
        };
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error("Failed to connect to remote server");
  }

  async openRangeStream(url, start, end, options = {}) {
    const { signal, ...customHeaders } = options;
    const rangeHeader = end !== null && end !== undefined ? `bytes=${start}-${end}` : `bytes=${start}-`;

    const res = await this.rawRequest(url, {
      method: "GET",
      userAgent: this.userAgent || DEFAULT_USER_AGENT,
      signal,
      headers: {
        ...customHeaders,
        Range: rangeHeader,
      },
      timeoutMs: 30000,
    });

    if (start > 0 && res.statusCode === 200) {
      res.destroy();
      throw new Error("Server ignored Range header and returned 200 OK instead of 206 Partial Content");
    }

    if ((res.statusCode < 200 || res.statusCode >= 300) && res.statusCode !== 206) {
      const err = makeHttpError(res.statusCode, res.headers);
      res.destroy();
      throw err;
    }

    res.setTimeout(30000, () => {
      res.destroy(new Error("Stream socket read timeout"));
    });

    return wrapDecompression(res);
  }

  async openFullStream(url, options = {}) {
    const { signal, ...customHeaders } = options;
    const res = await this.rawRequest(url, {
      method: "GET",
      userAgent: this.userAgent || DEFAULT_USER_AGENT,
      signal,
      headers: { ...customHeaders },
      timeoutMs: 30000,
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      const err = makeHttpError(res.statusCode, res.headers);
      res.destroy();
      throw err;
    }

    res.setTimeout(30000, () => {
      res.destroy(new Error("Stream socket read timeout"));
    });

    return wrapDecompression(res);
  }
}

export function wrapDecompression(res) {
  const enc = (res.headers["content-encoding"] || "").toLowerCase();
  if (enc === "gzip") return res.pipe(zlib.createGunzip());
  if (enc === "deflate") return res.pipe(zlib.createInflate());
  if (enc === "br") return res.pipe(zlib.createBrotliDecompress());
  return res;
}

export function extractFilename(headers, urlStr, contentType = null, preferredFilename = null) {
  const mimeClean = contentType ? String(contentType).split(";")[0].trim().toLowerCase() : "";
  const guessedExt = MIME_EXT_MAP[mimeClean] || "";

  const disp = headers["content-disposition"] || headers.get?.("content-disposition");
  if (disp) {
    const fname = parseContentDisposition(String(disp));
    if (fname) return sanitizeFilename(fname);
  }

  if (preferredFilename && preferredFilename.trim()) {
    let cleanPref = sanitizeFilename(preferredFilename.trim());
    if (cleanPref && !["video", "download", "fetching video info"].includes(cleanPref.toLowerCase())) {
      if (!cleanPref.includes(".") && guessedExt) {
        cleanPref += guessedExt;
      }
      return cleanPref;
    }
  }

  try {
    const parsed = new URL(urlStr);

    for (const key of ["response-content-disposition", "filename", "file", "name", "title"]) {
      const qVal = parsed.searchParams.get(key);
      if (qVal) {
        const fromDisp = parseContentDisposition(qVal);
        if (fromDisp) return sanitizeFilename(fromDisp);
        const cleanQ = sanitizeFilename(decodeURIComponent(qVal));
        if (cleanQ && cleanQ.length < 180) {
          return !cleanQ.includes(".") && guessedExt ? cleanQ + guessedExt : cleanQ;
        }
      }
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    const last = segments.pop();
    if (last) {
      let decoded = sanitizeFilename(decodeURIComponent(last));
      if (decoded && !["download", "file", "uc", "view"].includes(decoded.toLowerCase())) {
        if (!decoded.includes(".") && guessedExt) {
          decoded += guessedExt;
        }
        return decoded;
      }
    }

    const host = parsed.hostname.replace(/^www\./, "");
    return sanitizeFilename(`${host}_file${guessedExt || ".bin"}`);
  } catch (_) {}

  return `downloaded_file${guessedExt || ".bin"}`;
}

function parseContentDisposition(disp) {
  const parts = disp.split(";");
  let fallback = null;
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.toLowerCase().startsWith("filename*=")) {
      const val = trimmed.slice(10).replace(/^["']|["']$/g, "");
      const idx = val.indexOf("''");
      try {
        if (idx !== -1) {
          return decodeURIComponent(val.slice(idx + 2));
        }
        return decodeURIComponent(val);
      } catch (_) {
        return val.slice(idx !== -1 ? idx + 2 : 0);
      }
    } else if (trimmed.toLowerCase().startsWith("filename=")) {
      const raw = trimmed.slice(9).replace(/^["']|["']$/g, "");
      try {
        fallback = decodeURIComponent(raw);
      } catch (_) {
        fallback = raw;
      }
    }
  }
  return fallback;
}

export function sanitizeFilename(name) {
  const cleaned = String(name)
    .replace(/[\x00-\x1f\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  return cleaned.slice(0, 200) || "downloaded_file";
}

export function formatDownloadError(err) {
  const code = err?.code || "";
  const msg = err?.message || String(err || "Download failed");
  if (code === "ENOSPC") return "Insufficient disk space on target drive";
  if (code === "EACCES" || code === "EPERM") return "Permission denied writing to destination folder";
  if (code === "EBUSY") return "Destination file is locked by another program";
  if (code === "ENOTFOUND") return "Domain could not be resolved (check internet connection or URL)";
  if (code === "ECONNREFUSED") return "Remote server refused connection";
  if (code === "ETIMEDOUT") return "Connection timed out";
  return msg;
}

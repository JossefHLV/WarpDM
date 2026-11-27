/**
 * WarpDM — Background Service Worker (v3.5.0)
 */

const HOGRA_API_BASE = "http://127.0.0.1:20888/api";
const SW_BOOT_TIMESTAMP = Date.now();
const recentAutoCapturedUrls = new Map(); // url -> timestamp (deduplicates rapid browser events)
const pendingReqHeaders = new Map(); // requestId -> { headers, tabId, frameId, parentFrameId, initiator, ts }
const tabMediaMap = new Map();       // tabId -> Array<SniffedStream>
let sessionHydrated = false;

const DOMAIN_COMPANIONS = {
  "x.com": ["x.com", "twitter.com", "twimg.com"],
  "twitter.com": ["twitter.com", "x.com", "twimg.com"],
  "youtube.com": ["youtube.com", "youtu.be", "google.com", "googlevideo.com"],
  "youtu.be": ["youtube.com", "youtu.be", "google.com"],
  "instagram.com": ["instagram.com", "cdninstagram.com", "fbcdn.net"],
  "facebook.com": ["facebook.com", "fb.com", "fbcdn.net"],
  "fb.watch": ["facebook.com", "fb.com", "fbcdn.net"],
  "tiktok.com": ["tiktok.com", "tiktokv.com", "tiktokcdn.com"],
  "reddit.com": ["reddit.com", "redd.it"],
  "v.redd.it": ["reddit.com", "redd.it"],
  "vimeo.com": ["vimeo.com", "vimeocdn.com"],
  "twitch.tv": ["twitch.tv"],
};

const MULTI_PART_TLDS = /\.(co\.uk|org\.uk|com\.au|co\.jp|com\.br|co\.kr|co\.in|com\.mx|com\.nz|com\.sg|com\.tr)$/i;

const CAPTURED_REQ_HEADERS = new Set([
  "referer",
  "origin",
  "authorization",
  "user-agent",
  "x-playback-session-id",
  "x-requested-with",
]);

const SEGMENT_PATH_RE = /\.(ts|m4s|m4f|cmfv|cmfa|f4f|dash|chk|vtt|srt|jpg|jpeg|png|gif|webp|svg|js|css|woff2?)($|\?)/i;
const SEGMENT_QUERY_RE = /(?:^|[?&])(bytestart|byteend|segment|seg|frag|part|sq|Initialization)=/i;
const SEGMENT_NAME_RE = /(\/seg-\d+|\/chunk[-_]\d+|\/frag[-_]\d+|\/init\.mp4\b|googlevideo\.com\/videoplayback)/i;
const DIRECT_MEDIA_EXT_RE = /\.(mp4|webm|m4v|mov|mkv|mp3|m4a|aac|flac|ogg|opus|wav)($|[?#])/i;
const VARIANT_M3U8_RE = /(chunklist|media[_-]?\d+|audio[_-]|video[_-]|subtitles|[_/-](?:144|240|360|480|540|720|1080|1440|2160)p?\b|level[_-]?\d+|rendition)/i;
const MASTER_M3U8_RE = /(master|playlist|manifest|index|multi|abr)/i;
const DOWNLOADABLE_FILE_EXT_RE = /\.(zip|rar|7z|tar|gz|bz2|xz|iso|img|exe|msi|apk|dmg|deb|rpm|bin|dat|mp4|mkv|webm|avi|mov|mp3|m4a|flac|wav|ogg|pdf|docx|xlsx|pptx)(\?.*)?$/i;

async function checkEngineOnline(timeoutMs = 900) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${HOGRA_API_BASE}/status?client=extension&v=3.5.0`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { online: false };
    const json = await res.json();
    return {
      online: json.status === "ok",
      capabilities: json.capabilities || {},
      settings: json.settings || {},
    };
  } catch (_) {
    clearTimeout(timer);
    return { online: false };
  }
}

// Initial heartbeat so WarpDM Desktop immediately detects active browser extension
checkEngineOnline(1200).catch(() => {});

function isDomainExcluded(urlOrHost, excludedListStr) {
  if (!urlOrHost || !excludedListStr) return false;
  let host = String(urlOrHost).toLowerCase();
  try {
    if (host.startsWith("http")) host = new URL(host).hostname.toLowerCase();
  } catch (_) {}
  const rules = String(excludedListStr)
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const rule of rules) {
    const clean = rule.replace(/^\*\./, "");
    if (host === clean || host.endsWith("." + clean)) return true;
  }
  return false;
}

function matchesCapturedFileTypes(url, filename, capturedTypesStr) {
  const target = `${filename || ""} ${url || ""}`;
  if (!capturedTypesStr) return DOWNLOADABLE_FILE_EXT_RE.test(url) || DOWNLOADABLE_FILE_EXT_RE.test(filename || "");
  const tokens = String(capturedTypesStr)
    .split(/[\s,;]+/)
    .map((t) => t.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return DOWNLOADABLE_FILE_EXT_RE.test(target);
  const escaped = tokens.map((t) => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9]*"));
  const re = new RegExp(`\\.(${escaped.join("|")})($|[?#\\s"'])`, "i");
  return re.test(filename || "") || re.test(url || "");
}

function getRegistrableDomain(hostname) {
  const clean = String(hostname || "").replace(/^\.+/, "").toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(clean) || clean === "localhost") return clean;
  const parts = clean.split(".");
  if (parts.length <= 2) return clean;
  return MULTI_PART_TLDS.test(clean) ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
}

async function getCookieStoreIdForTab(tabId) {
  if (typeof tabId !== "number" || tabId < 0) return undefined;
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    return stores.find((s) => s.tabIds.includes(tabId))?.id;
  } catch (_) {
    return undefined;
  }
}

async function queryCookiesSafe(filter) {
  try {
    return await chrome.cookies.getAll({ ...filter, partitionKey: {} });
  } catch (_) {
    try {
      return await chrome.cookies.getAll(filter);
    } catch (__) {
      return [];
    }
  }
}

/**
 * Exports decrypted cookies in both HTTP Cookie header format and Netscape cookies.txt format
 * so yt-dlp and direct HTTP downloads work seamlessly on X.com, Instagram, YouTube, etc.
 */
async function exportCookiesForDownload({ targetUrl, pageUrl, tabId }) {
  const storeId = await getCookieStoreIdForTab(tabId);
  const domains = new Set();
  const urls = new Set();

  for (const raw of [targetUrl, pageUrl]) {
    if (!raw || !raw.startsWith("http")) continue;
    try {
      const u = new URL(raw);
      urls.add(u.origin + "/");
      const base = getRegistrableDomain(u.hostname);
      domains.add(base);
      for (const comp of DOMAIN_COMPANIONS[base] || []) {
        domains.add(comp);
      }
    } catch (_) {}
  }

  if (domains.size === 0 && urls.size === 0) {
    return { cookieHeader: null, cookiesTxt: null };
  }

  const queries = [
    ...[...domains].map((domain) => queryCookiesSafe(storeId ? { domain, storeId } : { domain })),
    ...[...urls].map((url) => queryCookiesSafe(storeId ? { url, storeId } : { url })),
  ];

  const batches = await Promise.all(queries);
  const dedup = new Map();
  for (const list of batches) {
    for (const c of list) {
      if (!c.name) continue;
      const key = `${c.domain}\t${c.path}\t${c.name}\t${c.partitionKey?.topLevelSite || ""}`;
      dedup.set(key, c);
    }
  }

  if (dedup.size === 0) return { cookieHeader: null, cookiesTxt: null };

  const lines = [
    "# Netscape HTTP Cookie File",
    "# https://curl.se/docs/http-cookies.html",
    "",
  ];

  for (const c of dedup.values()) {
    const cleanName = String(c.name).replace(/[\r\n\t]/g, "");
    const cleanVal = String(c.value ?? "").replace(/[\r\n\t]/g, "");
    if (!cleanName) continue;

    const isHostOnly = Boolean(c.hostOnly);
    const domain = isHostOnly
      ? c.domain.replace(/^\.+/, "")
      : c.domain.startsWith(".") ? c.domain : `.${c.domain}`;
    const includeSubdomains = isHostOnly ? "FALSE" : "TRUE";
    const cookiePath = c.path || "/";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expires = c.session || !c.expirationDate ? 0 : Math.max(0, Math.floor(c.expirationDate));

    lines.push(`${domain}\t${includeSubdomains}\t${cookiePath}\t${secure}\t${expires}\t${cleanName}\t${cleanVal}`);
  }

  let cookieHeader = null;
  const directUrl = targetUrl?.startsWith("http") ? targetUrl : pageUrl;
  if (directUrl?.startsWith("http")) {
    const exact = await queryCookiesSafe(storeId ? { url: directUrl, storeId } : { url: directUrl });
    if (exact.length > 0) {
      cookieHeader = exact.map((c) => `${c.name}=${c.value}`).join("; ");
    }
  }

  return {
    cookieHeader,
    cookiesTxt: lines.join("\n") + "\n",
  };
}

async function ensureMediaMapHydrated() {
  if (sessionHydrated) return;
  sessionHydrated = true;
  if (!chrome.storage?.session) return;
  try {
    const stored = await chrome.storage.session.get("tabMedia");
    if (stored?.tabMedia) {
      for (const [k, v] of Object.entries(stored.tabMedia)) {
        if (!tabMediaMap.has(Number(k))) tabMediaMap.set(Number(k), v);
      }
    }
  } catch (_) {}
}

let persistTimer = null;
function persistMediaMap() {
  if (persistTimer || !chrome.storage?.session) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const obj = {};
    for (const [k, v] of tabMediaMap.entries()) obj[k] = v;
    chrome.storage.session.set({ tabMedia: obj }).catch(() => {});
  }, 350);
}

// Clear stale sniffed streams on navigation
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.type === "main_frame") {
      tabMediaMap.delete(details.tabId);
      persistMediaMap();
    } else if (details.type === "sub_frame") {
      const list = tabMediaMap.get(details.tabId);
      if (list) {
        tabMediaMap.set(details.tabId, list.filter((m) => m.frameId !== details.frameId));
        persistMediaMap();
      }
    }
  },
  { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] }
);

// Capture request headers (Referer, Origin, Authorization, User-Agent) — compatible with Chromium & Firefox
const onBeforeSendHeadersListener = (details) => {
  if (details.tabId < 0 || (details.method !== "GET" && details.method !== "HEAD")) return;
  const u = details.url;
  if (SEGMENT_NAME_RE.test(u) || SEGMENT_PATH_RE.test(u)) return;

  const headers = {};
  for (const h of details.requestHeaders || []) {
    const lower = h.name.toLowerCase();
    if (CAPTURED_REQ_HEADERS.has(lower) && h.value) {
      headers[h.name] = h.value;
    }
  }

  pendingReqHeaders.set(details.requestId, {
    headers,
    tabId: details.tabId,
    frameId: details.frameId,
    parentFrameId: details.parentFrameId,
    initiator: details.initiator || null,
    ts: Date.now(),
  });

  if (pendingReqHeaders.size > 400) {
    const cutoff = Date.now() - 60000;
    for (const [id, entry] of pendingReqHeaders) {
      if (entry.ts < cutoff) pendingReqHeaders.delete(id);
    }
  }
};
try {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    onBeforeSendHeadersListener,
    { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other", "object"] },
    ["requestHeaders", "extraHeaders"]
  );
} catch (_) {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    onBeforeSendHeadersListener,
    { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other", "object"] },
    ["requestHeaders"]
  );
}

// Inspect response headers & classify real HLS/DASH manifests and progressive MP4/WebM streams
const onHeadersReceivedListener = async (details) => {
  const reqMeta = pendingReqHeaders.get(details.requestId);
  pendingReqHeaders.delete(details.requestId);

  if (details.tabId < 0 || details.statusCode >= 400) return;
  const u = details.url;
  if (SEGMENT_NAME_RE.test(u) || SEGMENT_PATH_RE.test(u) || SEGMENT_QUERY_RE.test(u)) return;

  let contentType = "";
  let contentLength = null;
  let totalRangeBytes = null;

  for (const h of details.responseHeaders || []) {
    const name = h.name.toLowerCase();
    if (name === "content-type") contentType = (h.value || "").toLowerCase().split(";")[0].trim();
    else if (name === "content-length") contentLength = parseInt(h.value || "0", 10) || null;
    else if (name === "content-range") {
      const m = /\/(\d+)$/.exec(h.value || "");
      if (m) totalRangeBytes = parseInt(m[1], 10) || null;
    }
  }

  if (/^(text\/html|text\/css|image\/|(?:text|application)\/(?:x-)?javascript|application\/json)/.test(contentType)) {
    return;
  }
  if (contentType === "video/mp2t" || contentType === "audio/mp2t" || contentType === "video/iso.segment") {
    return;
  }

  const isHls =
    /\.m3u8($|[?#;])/i.test(u) ||
    contentType === "application/vnd.apple.mpegurl" ||
    contentType === "application/x-mpegurl" ||
    contentType === "audio/mpegurl" ||
    contentType === "video/mpegurl";

  const isDash =
    /\.mpd($|[?#;])/i.test(u) ||
    contentType === "application/dash+xml" ||
    contentType === "video/vnd.mpeg.dash.mpd";

  const isManifest = isHls || isDash;
  const effectiveSize = totalRangeBytes || contentLength;

  const isDirectMedia =
    !isManifest &&
    (contentType.startsWith("video/") ||
      contentType.startsWith("audio/") ||
      (DIRECT_MEDIA_EXT_RE.test(u) && contentType === "application/octet-stream")) &&
    (!effectiveSize || effectiveSize > 250 * 1024);

  if (!isManifest && !isDirectMedia) return;

  await ensureMediaMapHydrated();

  let priority = 70;
  if (isDash) priority = 100;
  else if (isHls) {
    if (VARIANT_M3U8_RE.test(u)) priority = 55;
    else if (MASTER_M3U8_RE.test(u)) priority = 100;
    else priority = 85;
  } else if (contentType.startsWith("audio/") || /\.(mp3|m4a|aac|ogg|opus|flac|wav)($|[?#])/i.test(u)) {
    priority = 50;
  } else {
    priority = 80;
  }

  const badge = isHls
    ? "HLS"
    : isDash
      ? "DASH"
      : (u.match(/\.(mp4|webm|m4v|mp3|m4a|mkv|mov)\b/i)?.[1] || contentType.split("/")[1] || "MP4").toUpperCase();

  const list = tabMediaMap.get(details.tabId) || [];
  const existingIdx = list.findIndex((item) => item.url === u);
  const entry = {
    url: u,
    mime: contentType || (isHls ? "application/vnd.apple.mpegurl" : "video/mp4"),
    badge,
    size: effectiveSize,
    isManifest,
    priority,
    frameId: details.frameId,
    parentFrameId: details.parentFrameId,
    requestHeaders: reqMeta?.headers || {},
    timestamp: Date.now(),
  };

  if (existingIdx >= 0) {
    list[existingIdx] = { ...list[existingIdx], ...entry, priority: Math.max(list[existingIdx].priority, priority) };
  } else {
    if (isHls && !VARIANT_M3U8_RE.test(u) && !list.some((x) => x.frameId === details.frameId && x.badge === "HLS")) {
      entry.priority = 105;
    }
    list.push(entry);
  }

  list.sort((a, b) => b.priority - a.priority || b.timestamp - a.timestamp);
  if (list.length > 20) list.length = 20;

  tabMediaMap.set(details.tabId, list);
  persistMediaMap();
};
try {
  chrome.webRequest.onHeadersReceived.addListener(
    onHeadersReceivedListener,
    { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other", "object"] },
    ["responseHeaders", "extraHeaders"]
  );
} catch (_) {
  chrome.webRequest.onHeadersReceived.addListener(
    onHeadersReceivedListener,
    { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other", "object"] },
    ["responseHeaders"]
  );
}

const cleanPending = (d) => pendingReqHeaders.delete(d.requestId);
chrome.webRequest.onCompleted.addListener(cleanPending, { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener(cleanPending, { urls: ["<all_urls>"] });

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaMap.delete(tabId);
  persistMediaMap();
});

async function sendDownloadToHogra(options) {
  const {
    url,
    pageUrl,
    referer,
    filename,
    quality,
    max_connections,
    forceVideo,
    tabId,
    extraHeaders,
    fallbackStreams,
  } = options;

  const { cookieHeader, cookiesTxt } = await exportCookiesForDownload({
    targetUrl: url,
    pageUrl: pageUrl || referer,
    tabId,
  });

  const res = await fetch(`${HOGRA_API_BASE}/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      pageUrl: pageUrl || null,
      referer: referer || pageUrl || null,
      cookies: cookieHeader,
      cookiesTxt,
      headers: extraHeaders || null,
      fallbackStreams: fallbackStreams || null,
      filename: filename || null,
      quality: quality || null,
      forceVideo: !!forceVideo,
      max_connections: max_connections || 8,
    }),
  });

  const data = await res.json();
  if (!res.ok || data.status !== "ok") {
    throw new Error(data.message || "WarpDM rejected download request");
  }
  return data;
}

// Setup Context Menus
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["autoCapture", "floatingButton"], (prefs) => {
    if (prefs.autoCapture === undefined) chrome.storage.local.set({ autoCapture: true });
    if (prefs.floatingButton === undefined) chrome.storage.local.set({ floatingButton: true });
  });

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "hogra-download-link",
      title: "Download with WarpDM",
      contexts: ["link", "video", "audio"],
    });

    chrome.contextMenus.create({
      id: "hogra-download-page-video",
      title: "Download Video on Page with WarpDM",
      contexts: ["page"],
    });

    chrome.contextMenus.create({
      id: "hogra-download-all-links",
      title: "Download All Files on Page with WarpDM",
      contexts: ["page"],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    await ensureMediaMapHydrated();
    const tabId = tab?.id;

    if (info.menuItemId === "hogra-download-all-links" && tabId) {
      chrome.tabs.sendMessage(tabId, { type: "HOGRA_EXTRACT_ALL_LINKS" }, { frameId: 0 });
      return;
    }

    if (info.menuItemId === "hogra-download-page-video" && tabId) {
      let ctx = null;
      try {
        ctx = await chrome.tabs.sendMessage(tabId, { type: "HOGRA_GET_ACTIVE_VIDEO" }, { frameId: info.frameId || 0 });
      } catch (_) {}

      const sniffed = tabMediaMap.get(tabId) || [];
      const bestUrl = ctx?.permalink || sniffed[0]?.url || tab.url;
      await sendDownloadToHogra({
        url: bestUrl,
        pageUrl: tab.url,
        referer: sniffed[0]?.requestHeaders?.Referer || tab.url,
        extraHeaders: sniffed[0]?.requestHeaders || null,
        fallbackStreams: sniffed.slice(0, 4).map((s) => s.url),
        filename: ctx?.title || tab.title || null,
        quality: "best",
        forceVideo: Boolean(ctx?.isPermalink || sniffed[0]?.isManifest || !DOWNLOADABLE_FILE_EXT_RE.test(bestUrl)),
        tabId,
      });
      return;
    }

    if (info.menuItemId === "hogra-download-link") {
      let targetUrl = info.linkUrl || info.srcUrl;
      // If right-clicked a <video> with blob: or empty src, resolve via content script or sniffer
      if ((!targetUrl || targetUrl.startsWith("blob:")) && tabId) {
        let ctx = null;
        try {
          ctx = await chrome.tabs.sendMessage(tabId, { type: "HOGRA_GET_CONTEXT_VIDEO" }, { frameId: info.frameId || 0 });
        } catch (_) {}
        const sniffed = tabMediaMap.get(tabId) || [];
        targetUrl = ctx?.permalink || sniffed[0]?.url || tab?.url;
        await sendDownloadToHogra({
          url: targetUrl,
          pageUrl: tab?.url,
          referer: tab?.url,
          fallbackStreams: sniffed.slice(0, 4).map((s) => s.url),
          filename: ctx?.title || tab?.title || null,
          quality: "best",
          forceVideo: true,
          tabId,
        });
        return;
      }

      if (targetUrl) {
        await sendDownloadToHogra({
          url: targetUrl,
          pageUrl: tab?.url,
          referer: tab?.url,
          tabId,
        });
      }
    }
  } catch (err) {
    console.warn("[WarpDM] Context menu download error:", err.message);
  }
});

// Safe Browser Download Interception
// CRITICAL: Ignores historical downloads replayed by Chrome/Brave on browser startup!
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  try {
    if (!downloadItem || downloadItem.byExtensionId) return;

    // 1. ONLY intercept brand-new active transfers — NEVER completed/interrupted historical items!
    if (downloadItem.state && downloadItem.state !== "in_progress") return;
    if (downloadItem.paused) return;

    // 2. Strict timestamp freshness check: Chrome replays old DownloadHistory items on startup.
    // Reject any download whose startTime is missing, older than 5 seconds, or predates worker boot!
    const now = Date.now();
    if (now - SW_BOOT_TIMESTAMP < 1500) return;
    const startedMs = downloadItem.startTime ? Date.parse(downloadItem.startTime) : 0;
    if (!startedMs || Number.isNaN(startedMs)) return;
    if (now - startedMs > 5000 || startedMs < SW_BOOT_TIMESTAMP) return;

    const url = downloadItem.finalUrl || downloadItem.url;
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      return;
    }
    if (url.startsWith("http://127.0.0.1:20888") || url.startsWith("http://localhost:20888")) {
      return;
    }

    // 3. Per-URL cooldown deduplication (prevents duplicate popups on redirect chains)
    const prevTs = recentAutoCapturedUrls.get(url) || 0;
    if (now - prevTs < 10000) return;
    recentAutoCapturedUrls.set(url, now);
    if (recentAutoCapturedUrls.size > 100) {
      for (const [k, ts] of recentAutoCapturedUrls) {
        if (now - ts > 30000) recentAutoCapturedUrls.delete(k);
      }
    }

    const prefs = await chrome.storage.local.get(["autoCapture"]);
    if (prefs.autoCapture === false) return;

    const status = await checkEngineOnline(700);
    if (!status.online) return;

    const engineSettings = status.settings || {};
    if (engineSettings.auto_capture === false || engineSettings.browser_capture === false) return;

    if (
      isDomainExcluded(url, engineSettings.excluded_domains) ||
      isDomainExcluded(downloadItem.referrer, engineSettings.excluded_domains)
    ) {
      return;
    }

    const leafName = downloadItem.filename ? downloadItem.filename.split(/[\\/]/).pop() : "";
    const matchesExt = matchesCapturedFileTypes(url, leafName, engineSettings.captured_file_types);

    // Skip tiny web-app exports (< 512 KB) unless matching configured file extensions
    if (!matchesExt && (downloadItem.totalBytes <= 0 || downloadItem.totalBytes < 512 * 1024)) {
      return;
    }
    if (engineSettings.captured_file_types && !matchesExt) {
      return;
    }

    await sendDownloadToHogra({
      url,
      pageUrl: downloadItem.referrer || null,
      referer: downloadItem.referrer || null,
      filename: leafName || null,
    });

    chrome.downloads.cancel(downloadItem.id, () => void chrome.runtime.lastError);
    chrome.downloads.erase({ id: downloadItem.id }, () => void chrome.runtime.lastError);
  } catch (err) {
    console.warn("[WarpDM] Auto-capture fallback to browser:", err.message);
  }
});

// Handle messages from Content Script & Popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      await ensureMediaMapHydrated();
      const tabId = msg.tabId ?? sender?.tab?.id;
      const frameId = sender?.frameId ?? 0;

      if (msg.type === "HOGRA_GET_STATUS") {
        const st = await checkEngineOnline(1200);
        const sniffed = tabId !== undefined ? tabMediaMap.get(tabId) || [] : [];
        sendResponse({ connected: st.online, capabilities: st.capabilities, sniffedMedia: sniffed });
        return;
      }

      if (msg.type === "HOGRA_PROBE_MEDIA") {
        const { cookieHeader, cookiesTxt } = await exportCookiesForDownload({
          targetUrl: msg.url,
          pageUrl: msg.pageUrl || sender?.tab?.url,
          tabId,
        });

        const res = await fetch(`${HOGRA_API_BASE}/probe-media`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: msg.url,
            pageUrl: msg.pageUrl || sender?.tab?.url || null,
            cookies: cookieHeader,
            cookiesTxt,
          }),
        });
        const json = await res.json();
        if (!res.ok || json.status !== "ok") {
          sendResponse({ success: false, error: json.message || "Probe failed" });
        } else {
          sendResponse({ success: true, data: json.data });
        }
        return;
      }

      if (msg.type === "HOGRA_START_DOWNLOAD") {
        const allSniffed = tabId !== undefined ? tabMediaMap.get(tabId) || [] : [];
        const frameSniffed = allSniffed.filter((s) => s.frameId === frameId);
        const bestSniffed = frameSniffed[0] || allSniffed[0] || null;

        let targetUrl = msg.url;
        let extraHeaders = msg.headers || null;
        let referer = msg.referer || sender?.url || sender?.tab?.url || null;
        let forceVideo = !!msg.forceVideo;

        // If generic site / iframe had blob: or non-permalink URL, prefer highest-priority sniffed stream!
        if ((!targetUrl || targetUrl.startsWith("blob:") || (!msg.isPermalink && bestSniffed)) && !msg.isPermalink) {
          if (bestSniffed) {
            targetUrl = bestSniffed.url;
            extraHeaders = bestSniffed.requestHeaders || extraHeaders;
            referer = bestSniffed.requestHeaders?.Referer || bestSniffed.requestHeaders?.referer || referer;
            if (bestSniffed.isManifest) forceVideo = true;
          }
        }

        const result = await sendDownloadToHogra({
          url: targetUrl,
          pageUrl: msg.pageUrl || sender?.tab?.url || null,
          referer,
          extraHeaders,
          fallbackStreams: allSniffed.slice(0, 5).map((s) => s.url),
          filename: msg.filename || null,
          quality: msg.quality || null,
          forceVideo,
          max_connections: msg.max_connections || 8,
          tabId,
        });

        sendResponse({
          success: true,
          downloadId: result.download_id || null,
          awaitingApproval: !!result.awaiting_approval,
        });
        return;
      }

      if (msg.type === "HOGRA_BATCH_LINKS") {
        const { cookieHeader } = await exportCookiesForDownload({
          targetUrl: sender?.tab?.url,
          pageUrl: sender?.tab?.url,
          tabId,
        });
        const res = await fetch(`${HOGRA_API_BASE}/batch-download`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            urls: msg.links || [],
            referer: sender?.tab?.url || null,
            cookies: cookieHeader,
          }),
        });
        const json = await res.json();
        sendResponse({ success: res.ok, count: json.count || 0 });
        return;
      }

      sendResponse({ success: false, error: "Unknown message type" });
    } catch (err) {
      sendResponse({
        success: false,
        error: err.message || "WarpDM Engine offline — please open WarpDM",
      });
    }
  })();

  return true;
});

/**
 * WarpDM Browser Extension - Popup Controller (v3.5.0)
 */

const statusBadge = document.getElementById("statusBadge");
const urlInput = document.getElementById("urlInput");
const downloadBtn = document.getElementById("downloadBtn");
const videoCard = document.getElementById("videoCard");
const videoTitle = document.getElementById("videoTitle");
const videoQualitySelect = document.getElementById("videoQualitySelect");
const downloadVideoBtn = document.getElementById("downloadVideoBtn");
const streamsCard = document.getElementById("streamsCard");
const streamsList = document.getElementById("streamsList");
const chkAutoCapture = document.getElementById("chkAutoCapture");
const chkFloatingBtn = document.getElementById("chkFloatingBtn");
const openUiBtn = document.getElementById("openUiBtn");

let activeTab = null;
let resolvedVideoCtx = null;

chrome.storage.local.get(["autoCapture", "floatingButton"], (prefs) => {
  chkAutoCapture.checked = prefs.autoCapture !== false;
  chkFloatingBtn.checked = prefs.floatingButton !== false;
});

chkAutoCapture.addEventListener("change", () => {
  chrome.storage.local.set({ autoCapture: chkAutoCapture.checked });
});

chkFloatingBtn.addEventListener("change", () => {
  chrome.storage.local.set({ floatingButton: chkFloatingBtn.checked });
});

openUiBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "http://127.0.0.1:20888/" });
});

function formatBytes(b) {
  if (!b || b <= 0) return "";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
}

async function initPopup() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs?.[0] || null;
  const tabUrl = activeTab?.url || "";

  if (tabUrl.match(/\.(zip|iso|exe|mp4|mkv|tar|gz|7z|rar|pdf|dmg|bin|webm|msi|apk)(\?.*)?$/i)) {
    urlInput.value = tabUrl;
  }

  // 1. Ask content script for exact visible video permalink (handles X/Twitter feeds, Reddit, TikTok, YouTube!)
  if (activeTab?.id && tabUrl.startsWith("http")) {
    try {
      const ctx = await chrome.tabs.sendMessage(activeTab.id, { type: "HOGRA_GET_ACTIVE_VIDEO" }, { frameId: 0 });
      if (ctx && ctx.permalink) {
        resolvedVideoCtx = ctx;
        videoCard.classList.remove("hidden");
        videoTitle.textContent = ctx.title || activeTab.title || ctx.permalink;
      }
    } catch (_) {}
  }

  // 2. Ask background worker for engine status + sniffed HLS/DASH/MP4 streams
  chrome.runtime.sendMessage({ type: "HOGRA_GET_STATUS", tabId: activeTab?.id }, (resp) => {
    if (resp?.connected) {
      statusBadge.textContent = "● Engine Ready";
      statusBadge.className = "status-badge connected";
    } else {
      statusBadge.textContent = "○ Engine Offline";
      statusBadge.className = "status-badge";
    }

    const sniffed = resp?.sniffedMedia || [];
    if (sniffed.length > 0) {
      streamsCard.classList.remove("hidden");
      streamsList.textContent = "";
      for (const s of sniffed.slice(0, 6)) {
        const item = document.createElement("div");
        item.className = "stream-item";

        const badge = document.createElement("span");
        badge.className = "s-badge";
        badge.textContent = s.badge || "STREAM";

        const name = document.createElement("span");
        name.className = "s-name";
        let shortPath = s.url;
        try {
          const u = new URL(s.url);
          shortPath = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
        } catch (_) {}
        name.textContent = s.size ? `${shortPath} (${formatBytes(s.size)})` : shortPath;

        item.append(badge, name);
        item.addEventListener("click", () => {
          name.textContent = "Sending to WarpDM...";
          chrome.runtime.sendMessage(
            {
              type: "HOGRA_START_DOWNLOAD",
              url: s.url,
              isPermalink: true,
              pageUrl: activeTab?.url || null,
              referer: s.requestHeaders?.Referer || activeTab?.url || null,
              headers: s.requestHeaders || null,
              forceVideo: Boolean(s.isManifest),
              filename: activeTab?.title || shortPath,
              tabId: activeTab?.id,
            },
            (r) => {
              name.textContent = r?.success ? "✔ Started in WarpDM!" : "⚠ Open WarpDM App";
            }
          );
        });
        streamsList.appendChild(item);
      }
    }
  });
}

downloadVideoBtn.addEventListener("click", () => {
  if (!activeTab) return;
  const targetUrl = resolvedVideoCtx?.permalink || activeTab.url;
  const quality = videoQualitySelect.value;

  downloadVideoBtn.textContent = "Sending to WarpDM...";
  downloadVideoBtn.disabled = true;

  chrome.runtime.sendMessage(
    {
      type: "HOGRA_START_DOWNLOAD",
      url: targetUrl,
      isPermalink: Boolean(resolvedVideoCtx?.isPermalink ?? true),
      pageUrl: activeTab.url,
      referer: activeTab.url,
      quality,
      forceVideo: true,
      filename: resolvedVideoCtx?.title || activeTab.title || "video",
      tabId: activeTab.id,
    },
    (resp) => {
      downloadVideoBtn.disabled = false;
      if (resp?.success) {
        downloadVideoBtn.textContent = "✔ Started in WarpDM!";
        downloadVideoBtn.style.background = "#10b981";
        setTimeout(() => {
          downloadVideoBtn.textContent = "Download Video with WarpDM";
          downloadVideoBtn.style.background = "";
        }, 2200);
      } else {
        downloadVideoBtn.textContent = "⚠ Launch WarpDM App First";
        downloadVideoBtn.style.background = "#ef4444";
        setTimeout(() => {
          downloadVideoBtn.textContent = "Download Video with WarpDM";
          downloadVideoBtn.style.background = "";
        }, 2500);
      }
    }
  );
});

downloadBtn.addEventListener("click", () => {
  const url = urlInput.value.trim();
  if (!url) return;

  downloadBtn.textContent = "Starting...";
  downloadBtn.disabled = true;

  let sameSiteTabUrl = null;
  try {
    if (activeTab?.url) {
      const h1 = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
      const h2 = new URL(activeTab.url).hostname.replace(/^www\./i, "").toLowerCase();
      if (h1 === h2) sameSiteTabUrl = activeTab.url;
    }
  } catch (_) {}

  chrome.runtime.sendMessage(
    {
      type: "HOGRA_START_DOWNLOAD",
      url,
      isPermalink: true,
      pageUrl: sameSiteTabUrl,
      referer: sameSiteTabUrl,
      max_connections: 8,
      tabId: activeTab?.id,
    },
    (resp) => {
      downloadBtn.disabled = false;
      if (resp?.success) {
        downloadBtn.textContent = "✔ Download Started!";
        downloadBtn.style.background = "#10b981";
        urlInput.value = "";
        setTimeout(() => {
          downloadBtn.textContent = "Start Download";
          downloadBtn.style.background = "";
        }, 2000);
      } else {
        downloadBtn.textContent = "⚠ WarpDM Offline";
        downloadBtn.style.background = "#ef4444";
        setTimeout(() => {
          downloadBtn.textContent = "Start Download";
          downloadBtn.style.background = "";
        }, 2500);
      }
    }
  );
});

initPopup();

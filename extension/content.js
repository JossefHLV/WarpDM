/**
 * WarpDM Content Script (v3.5.0)
 */

(() => {
  if (window.location.host === "127.0.0.1:20888" || window.location.host === "localhost:20888") {
    try {
      document.documentElement.setAttribute("data-warpdm-ext", "3.5.0");
      window.dispatchEvent(new CustomEvent("warpdm-extension-ready", { detail: { version: "3.5.0" } }));
    } catch (_) {}
    return;
  }

  if (window.__warpdmContentV35) return;
  window.__warpdmContentV35 = true;
  const staleHost = document.getElementById("hogra-ext-shadow-host");
  if (staleHost) staleHost.remove();

  if (window.self !== window.top) {
    if (/(doubleclick\.net|googlesyndication\.com|recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com)/i.test(window.location.hostname)) {
      return;
    }
  }

  let floatingEnabled = true;
  let hostEl = null;
  let shadow = null;
  let posSheet = null;
  let panelEl = null;
  let menuEl = null;
  let mainBtnEl = null;
  let labelEl = null;

  let currentTargetVideo = null;
  let lastContextVideo = null;
  let pointerX = -1;
  let pointerY = -1;
  let lastPointerMoveTs = Date.now();
  let fsIdleTimer = null;
  let rafScheduled = false;

  const dismissedVideos = new WeakSet();
  const dismissedPermalinks = new Set();
  const probeCache = new Map();

  const iconUrl = chrome.runtime.getURL("icons/icon32.png");
  const overlayCssUrl = chrome.runtime.getURL("overlay.css");

  const FALLBACK_CSS = `
    :host { all: initial; }
    .hogra-floating-panel {
      position: fixed !important;
      z-index: 2147483647 !important;
      display: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
      user-select: none !important;
      pointer-events: auto !important;
      transition: opacity 0.18s ease !important;
    }
    .hogra-floating-panel.hogra-fs-idle {
      opacity: 0 !important;
      pointer-events: none !important;
    }
    .hogra-pill-bar {
      display: inline-flex !important;
      align-items: stretch !important;
      background: rgba(11, 18, 33, 0.93) !important;
      backdrop-filter: blur(10px) !important;
      border: 1px solid rgba(56, 189, 248, 0.45) !important;
      border-radius: 9px !important;
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.65) !important;
      overflow: hidden !important;
    }
    .hogra-pill-bar:hover {
      border-color: rgba(56, 189, 248, 0.9) !important;
      box-shadow: 0 8px 26px rgba(2, 132, 199, 0.5) !important;
    }
    .hogra-main-btn {
      all: unset;
      display: inline-flex !important;
      align-items: center !important;
      gap: 7px !important;
      padding: 6px 11px !important;
      color: #f8fafc !important;
      font-size: 12px !important;
      font-weight: 600 !important;
      cursor: pointer !important;
      white-space: nowrap !important;
    }
    .hogra-main-btn:hover { background: rgba(2, 132, 199, 0.35) !important; }
    .hogra-main-btn.hogra-btn-success { background: rgba(16, 185, 129, 0.92) !important; color: #fff !important; }
    .hogra-main-btn.hogra-btn-error { background: rgba(239, 68, 68, 0.92) !important; color: #fff !important; }
    .hogra-brand-img { width: 17px !important; height: 17px !important; border-radius: 4px !important; display: block !important; flex-shrink: 0 !important; }
    .hogra-caret { font-size: 10px !important; color: #38bdf8 !important; }
    .hogra-dismiss-btn {
      all: unset;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 22px !important;
      color: #94a3b8 !important;
      font-size: 14px !important;
      border-left: 1px solid rgba(255, 255, 255, 0.12) !important;
      cursor: pointer !important;
    }
    .hogra-dismiss-btn:hover { background: rgba(239, 68, 68, 0.3) !important; color: #f8fafc !important; }
    .hogra-quality-menu {
      position: absolute !important;
      top: calc(100% + 6px) !important;
      right: 0 !important;
      width: 280px !important;
      background: rgba(11, 18, 33, 0.97) !important;
      backdrop-filter: blur(14px) !important;
      border: 1px solid rgba(56, 189, 248, 0.45) !important;
      border-radius: 10px !important;
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.78) !important;
      overflow: hidden !important;
    }
    .hogra-quality-menu.hogra-flip-up { top: auto !important; bottom: calc(100% + 6px) !important; }
    .hogra-hidden { display: none !important; }
    .hogra-menu-header {
      padding: 8px 12px !important;
      font-size: 10.5px !important;
      font-weight: 700 !important;
      text-transform: uppercase !important;
      letter-spacing: 0.5px !important;
      color: #38bdf8 !important;
      border-bottom: 1px solid rgba(51, 65, 85, 0.7) !important;
    }
    .hogra-menu-items { display: flex !important; flex-direction: column !important; max-height: 240px !important; overflow-y: auto !important; padding: 4px !important; }
    .hogra-quality-item {
      all: unset;
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      padding: 7px 10px !important;
      border-radius: 6px !important;
      color: #f1f5f9 !important;
      font-size: 12px !important;
      font-weight: 500 !important;
      cursor: pointer !important;
    }
    .hogra-quality-item:hover { background: rgba(2, 132, 199, 0.35) !important; }
    .hogra-q-badge {
      font-size: 10px !important;
      font-weight: 700 !important;
      padding: 2px 6px !important;
      border-radius: 4px !important;
      background: rgba(56, 189, 248, 0.18) !important;
      color: #38bdf8 !important;
      min-width: 38px !important;
      text-align: center !important;
      flex-shrink: 0 !important;
    }
    .hogra-q-badge.hogra-q-audio { background: rgba(168, 85, 247, 0.22) !important; color: #c084fc !important; }
    .hogra-q-label { flex: 1 !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
    .hogra-q-size { font-size: 11px !important; color: #94a3b8 !important; flex-shrink: 0 !important; }
    .hogra-menu-status { padding: 6px 12px !important; font-size: 11px !important; color: #94a3b8 !important; border-top: 1px solid rgba(51, 65, 85, 0.6) !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
  `;

  function isContextValid() {
    return Boolean(chrome?.runtime?.id);
  }

  function setPanelCoordinates(visible, topPx = 0, leftPx = 0) {
    if (!panelEl) return;
    if (!visible) {
      if (posSheet) {
        try {
          posSheet.replaceSync(`.hogra-floating-panel { display: none !important; }`);
        } catch (_) {}
      }
      try {
        panelEl.style.display = "none";
      } catch (_) {}
      return;
    }

    const t = Math.round(topPx);
    const l = Math.round(leftPx);
    if (posSheet) {
      try {
        posSheet.replaceSync(
          `.hogra-floating-panel { display: block !important; top: ${t}px !important; left: ${l}px !important; }`
        );
      } catch (_) {}
    }
    try {
      panelEl.style.display = "block";
      panelEl.style.top = `${t}px`;
      panelEl.style.left = `${l}px`;
    } catch (_) {}
  }

  function teardown() {
    if (hostEl) {
      hostEl.remove();
      hostEl = null;
    }
  }

  if (isContextValid()) {
    chrome.storage.local.get(["floatingButton"], (prefs) => {
      floatingEnabled = prefs.floatingButton !== false;
    });

    chrome.storage.onChanged.addListener((changes) => {
      if (changes.floatingButton) {
        floatingEnabled = changes.floatingButton.newValue !== false;
        if (!floatingEnabled) setPanelCoordinates(false);
        else scheduleScan();
      }
    });
  }

  function queryAllVideosDeep(root = document, out = []) {
    if (!root) return out;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = root.nodeType === Node.ELEMENT_NODE ? root : walker.nextNode();
    while (node) {
      if (node.tagName === "VIDEO") out.push(node);
      if (node.shadowRoot) queryAllVideosDeep(node.shadowRoot, out);
      node = walker.nextNode();
    }
    return out;
  }

  function parentAcrossShadow(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode?.();
    return root instanceof ShadowRoot ? root.host : null;
  }

  function closestAcrossShadow(node, selector) {
    let cur = node;
    while (cur && cur !== document.documentElement) {
      if (cur.nodeType === Node.ELEMENT_NODE && cur.matches?.(selector)) return cur;
      cur = parentAcrossShadow(cur);
    }
    return null;
  }

  function isValidVideoPermalink(rawUrl) {
    try {
      const u = new URL(rawUrl);
      const h = u.hostname.replace(/^www\./i, "").toLowerCase();
      const p = u.pathname;

      if (h === "x.com" || h === "twitter.com" || h === "mobile.twitter.com") {
        return /^\/(?:[^/]+|i\/web)\/status\/\d+/i.test(p) || /^\/i\/broadcasts\/[A-Za-z0-9]+/i.test(p);
      }
      if (h.endsWith("instagram.com")) {
        return /^\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+/i.test(p) || /^\/stories\/[^/]+\/\d+/i.test(p);
      }
      if (h.endsWith("tiktok.com")) {
        return /^\/@[^/]+\/(?:video|photo)\/\d+/i.test(p) || /^\/t\/[A-Za-z0-9]+/i.test(p);
      }
      if (h.endsWith("facebook.com") || h === "fb.watch") {
        if (h === "fb.watch") return p.length > 1;
        return (
          /^\/reel\/\d+/i.test(p) ||
          /^\/share\/[vr]\/[A-Za-z0-9_-]+/i.test(p) ||
          /^\/(?:[^/]+\/)?videos\/(?:[^/]+\/)?\d+/i.test(p) ||
          (/^\/watch\/?$/i.test(p) && u.searchParams.has("v")) ||
          /^\/[^/]+\/posts\/[A-Za-z0-9._-]+/i.test(p) ||
          ((p === "/permalink.php" || p === "/story.php") && u.searchParams.has("story_fbid"))
        );
      }
      if (h.endsWith("reddit.com") || h === "redd.it") {
        return /^\/r\/[^/]+\/comments\/[a-z0-9]+/i.test(p) || /^\/comments\/[a-z0-9]+/i.test(p);
      }
      if (h.endsWith("youtube.com") || h === "youtu.be" || h.endsWith("youtube-nocookie.com")) {
        if (h === "youtu.be") return p.length > 1;
        return (p === "/watch" && u.searchParams.has("v")) || /^\/(shorts|live|embed|v)\/[A-Za-z0-9_-]{6,}/i.test(p);
      }
      if (h === "kick.com" || h.endsWith(".kick.com")) {
        if (u.searchParams.has("clip")) return true;
        if (/^\/(?:[^/]+\/)?(?:clips|videos|video)\/[A-Za-z0-9_-]+/i.test(p)) return true;
        return p.length > 1 && !/^\/(search|directory|explore|browse|categories|following)\b/i.test(p);
      }
      if (/(^|\.)(twitch\.tv|vimeo\.com|dailymotion\.com|streamable\.com|rumble\.com|bilibili\.com|odysee\.com)$/i.test(h)) {
        return p.length > 1 && !/^\/(search|directory|explore|browse)\b/i.test(p);
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  function resolveVideoContext(videoEl) {
    if (!videoEl) return null;
    const host = window.location.hostname.replace(/^www\./i, "").toLowerCase();
    const locHref = window.location.href;
    const FEED_BOUNDARY = 'main, [role="feed"], [data-testid="primaryColumn"], body';

    // A. X.com / Twitter
    if (host === "x.com" || host === "twitter.com" || host.endsWith(".x.com") || host.endsWith(".twitter.com")) {
      const STATUS_RE = /\/([^/]+)\/status\/(\d+)/i;

      let cur = parentAcrossShadow(videoEl);
      const article = closestAcrossShadow(videoEl, 'article[data-testid="tweet"], article');
      while (cur && cur !== article && !cur.matches?.(FEED_BOUNDARY)) {
        if (cur.matches?.('div[role="link"], [data-testid="card.wrapper"]')) {
          const qLink = cur.querySelector('a[href*="/status/"]');
          const m = qLink && STATUS_RE.exec(qLink.getAttribute("href") || "");
          if (m) {
            return {
              permalink: `https://x.com/${m[1]}/status/${m[2]}`,
              isPermalink: true,
              title: (cur.innerText?.split("\n").slice(0, 2).join(" ").trim() || `X_${m[2]}`).slice(0, 90),
            };
          }
        }
        cur = parentAcrossShadow(cur);
      }

      if (article) {
        const candidates = [
          article.querySelector('[data-testid="User-Name"] a[href*="/status/"]'),
          article.querySelector('a[href*="/status/"] time')?.closest("a"),
          ...article.querySelectorAll('a[href*="/status/"]'),
        ].filter(Boolean);

        for (const a of candidates) {
          const href = a.getAttribute("href") || "";
          if (/\/(analytics|retweets|likes|quotes)\b/i.test(href)) continue;
          const m = STATUS_RE.exec(href);
          if (m) {
            let url = `https://x.com/${m[1]}/status/${m[2]}`;
            const ownVideos = Array.from(article.querySelectorAll("video")).filter(
              (v) => v.closest('div[role="link"]') === videoEl.closest('div[role="link"]')
            );
            if (ownVideos.length > 1) {
              const idx = ownVideos.indexOf(videoEl);
              if (idx >= 0) url += `/video/${idx + 1}`;
            }
            const tweetText = article.querySelector('[data-testid="tweetText"]')?.textContent?.trim();
            return {
              permalink: url,
              isPermalink: true,
              title: (tweetText ? `${m[1]} - ${tweetText}` : `X_${m[1]}_${m[2]}`).slice(0, 100),
            };
          }
        }
      }
    }

    // B. Kick.com (Live streams, VODs, and Clip Modals on offline/online channel pages!)
    if (host === "kick.com" || host.endsWith(".kick.com")) {
      const modal = closestAcrossShadow(videoEl, 'dialog[open], [role="dialog"], [aria-modal="true"]');
      const directSrc = videoEl.currentSrc || videoEl.src || videoEl.querySelector("source")?.src || "";

      if (modal) {
        const modalTitle =
          modal.querySelector("h1, h2, h3, [class*='title' i]")?.textContent?.trim() ||
          document.title?.replace(/\s*\|\s*Kick$/i, "").trim() ||
          "Kick_Clip";

        // 1. Check if URL bar already has ?clip= or /clips/ or /videos/
        if (/[?&]clip=/i.test(locHref) || /\/(?:clips|videos|video)\//i.test(window.location.pathname)) {
          return { permalink: locHref, isPermalink: true, title: modalTitle.slice(0, 100) };
        }

        // 2. Check for direct .mp4 / clips.kick.com download button or clip link inside modal
        const dlAnchor = modal.querySelector('a[href*="clips.kick.com"], a[href*=".mp4"], a[href*="clip="], a[href*="/clips/"]');
        if (dlAnchor?.href) {
          const isDirectMp4 = /\.mp4($|\?)/i.test(dlAnchor.href);
          return {
            permalink: dlAnchor.href,
            isPermalink: !isDirectMp4,
            title: modalTitle.slice(0, 100),
          };
        }

        // 3. If directSrc is http(s) (non-blob), use it; otherwise let background HLS/MP4 sniffer supply the exact clip stream!
        if (directSrc && /^https?:\/\//i.test(directSrc)) {
          return { permalink: directSrc, directSrc, isPermalink: false, pageUrl: locHref, title: modalTitle.slice(0, 100) };
        }
        return { permalink: locHref, directSrc, isPermalink: false, pageUrl: locHref, title: modalTitle.slice(0, 100) };
      }
    }

    // C. Facebook (Reels, Watch, Theater [role="dialog"], Feed Posts, Groups)
    if (host.endsWith("facebook.com") || host === "fb.watch") {
      // If user opened a video in Facebook's Theater / Lightbox modal or Reel viewer, check URL bar first!
      if (isValidVideoPermalink(locHref)) {
        const cleanTitle = (document.title || "Facebook_Video").replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*Facebook$/i, "").trim();
        return { permalink: locHref, isPermalink: true, title: cleanTitle || "Facebook_Video" };
      }

      let cur = parentAcrossShadow(videoEl);
      for (let depth = 0; cur && depth < 18 && !cur.matches?.(FEED_BOUNDARY); depth++) {
        const anchors = Array.from(
          cur.querySelectorAll(
            'a[href*="/reel/"], a[href*="/videos/"], a[href*="/watch"], a[href*="/share/v/"], a[href*="/share/r/"], a[href*="/posts/"], a[href*="story_fbid="]'
          )
        );
        const found = new Set();
        for (const a of anchors) {
          try {
            const u = new URL(a.href, window.location.origin);
            u.searchParams.delete("__cft__[0]");
            u.searchParams.delete("__tn__");
            u.searchParams.delete("fbclid");
            if (isValidVideoPermalink(u.href)) found.add(u.href);
          } catch (_) {}
        }
        if (found.size === 1) {
          const cleanTitle = (document.title || "Facebook_Video").replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*Facebook$/i, "").trim();
          return { permalink: [...found][0], isPermalink: true, title: cleanTitle || "Facebook_Video" };
        }
        if (found.size > 1) break;
        cur = parentAcrossShadow(cur);
      }
    }

    // D. Reddit (<shreddit-post> + Classic)
    if (host.endsWith("reddit.com")) {
      const shPost = closestAcrossShadow(videoEl, "shreddit-post");
      if (shPost) {
        const rawPerm = shPost.getAttribute("permalink") || shPost.getAttribute("content-href");
        if (rawPerm) {
          return {
            permalink: new URL(rawPerm, window.location.origin).href,
            isPermalink: true,
            title: (shPost.getAttribute("post-title") || document.title || "reddit_video").slice(0, 100),
          };
        }
      }
      let cur = parentAcrossShadow(videoEl);
      for (let depth = 0; cur && depth < 14 && !cur.matches?.(FEED_BOUNDARY); depth++) {
        const links = Array.from(cur.querySelectorAll('a[href*="/comments/"]'))
          .map((a) => a.href)
          .filter((h) => /\/r\/[^/]+\/comments\/[a-z0-9]+/i.test(h));
        const uniqueIds = new Set(links.map((h) => h.match(/\/comments\/([a-z0-9]+)/i)?.[1]).filter(Boolean));
        if (uniqueIds.size === 1) {
          return { permalink: links[0].split("?")[0], isPermalink: true, title: document.title };
        }
        if (uniqueIds.size > 1) break;
        cur = parentAcrossShadow(cur);
      }
    }

    // E. Instagram
    if (host.endsWith("instagram.com")) {
      const IG_RE = /\/(?:[^/?#]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;
      let cur = parentAcrossShadow(videoEl);
      for (let depth = 0; cur && depth < 15 && !cur.matches?.(FEED_BOUNDARY); depth++) {
        const anchors = Array.from(cur.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"], a[href*="/tv/"]'));
        const codes = new Map();
        for (const a of anchors) {
          const m = IG_RE.exec(a.getAttribute("href") || "");
          if (m) {
            const kind = m[1].toLowerCase() === "reels" ? "reel" : m[1].toLowerCase();
            codes.set(m[2], `https://www.instagram.com/${kind}/${m[2]}/`);
          }
        }
        if (codes.size === 1) {
          const [code, url] = codes.entries().next().value;
          return { permalink: url, isPermalink: true, title: `Instagram_${code}` };
        }
        if (codes.size > 1) break;
        cur = parentAcrossShadow(cur);
      }
    }

    // F. TikTok
    if (host.endsWith("tiktok.com")) {
      const TT_RE = /\/@([^/?#]+)\/(?:video|photo)\/(\d{15,22})/;
      let cur = parentAcrossShadow(videoEl);
      let videoIdFromWrapper = null;

      for (let depth = 0; cur && depth < 14 && !cur.matches?.(FEED_BOUNDARY); depth++) {
        if (!videoIdFromWrapper && cur.id) {
          const wm = /^xgwrapper-\d+-(\d{15,22})$/.exec(cur.id);
          if (wm) videoIdFromWrapper = wm[1];
        }
        const anchors = Array.from(cur.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]'));
        const matches = new Map();
        for (const a of anchors) {
          const m = TT_RE.exec(a.href || "");
          if (m) matches.set(m[2], `https://www.tiktok.com/@${m[1]}/video/${m[2]}`);
        }
        if (matches.size === 1) {
          const [id, url] = matches.entries().next().value;
          return { permalink: url, isPermalink: true, title: `TikTok_${id}` };
        }
        if (matches.size > 1) break;

        if (videoIdFromWrapper) {
          const authorEl = cur.querySelector('a[href^="/@"]');
          const handle = authorEl?.getAttribute("href")?.match(/^\/@([^/?#]+)/)?.[1];
          if (handle) {
            return {
              permalink: `https://www.tiktok.com/@${handle}/video/${videoIdFromWrapper}`,
              isPermalink: true,
              title: `TikTok_${handle}_${videoIdFromWrapper}`,
            };
          }
        }
        cur = parentAcrossShadow(cur);
      }
      if (videoIdFromWrapper) {
        return {
          permalink: `https://www.tiktok.com/@_/video/${videoIdFromWrapper}`,
          isPermalink: true,
          title: `TikTok_${videoIdFromWrapper}`,
        };
      }
    }

    // G. YouTube (Watch, Shorts, Inline Previews, Cards)
    if (host.endsWith("youtube.com")) {
      const cleanDocTitle = (document.title || "video").replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/i, "").trim();
      const reel = closestAcrossShadow(videoEl, "ytd-reel-video-renderer");
      if (reel) {
        const sLink = reel.querySelector('a[href*="/shorts/"]');
        if (sLink) return { permalink: sLink.href.split("?")[0], isPermalink: true, title: cleanDocTitle };
      }
      if (closestAcrossShadow(videoEl, "ytd-video-preview, ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer")) {
        const card =
          closestAcrossShadow(videoEl, "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer") ||
          document.querySelector("ytd-rich-item-renderer:hover, ytd-video-renderer:hover, ytd-compact-video-renderer:hover");
        const wLink = card?.querySelector('a#thumbnail[href*="/watch?v="], a#video-title-link[href*="/watch?v="], a[href*="/shorts/"]');
        if (wLink) {
          const u = new URL(wLink.href, window.location.origin);
          const clean = u.pathname === "/watch" ? `https://www.youtube.com/watch?v=${u.searchParams.get("v")}` : u.origin + u.pathname;
          const t = card?.querySelector("#video-title")?.textContent?.trim();
          return { permalink: clean, isPermalink: true, title: t || cleanDocTitle };
        }
      }
    }

    // H. Valid single-video page URL
    if (isValidVideoPermalink(locHref)) {
      return {
        permalink: locHref,
        isPermalink: true,
        title: (document.title || "video").replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/i, "").trim(),
      };
    }

    // I. Generic HTML5 / Embedded Iframe / Sniffer Fallback
    const directSrc = videoEl.currentSrc || videoEl.src || videoEl.querySelector("source")?.src || "";
    return {
      permalink: directSrc || locHref,
      directSrc,
      isPermalink: false,
      pageUrl: locHref,
      title: (document.title || "video").replace(/^\(\d+\)\s*/, "").trim(),
    };
  }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
  }

  /**
   * Determines the proper DOM container for hostEl so it ALWAYS stays in the active Browser Top Layer
   * (works inside Fullscreen containers AND HTML5 <dialog open> modals on Kick/Facebook!).
   */
  function getDesiredMountRoot(videoEl) {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      if (fsEl.tagName === "VIDEO") return fsEl.parentElement || document.body || document.documentElement;
      return fsEl;
    }
    if (videoEl) {
      const topDialog = closestAcrossShadow(videoEl, "dialog[open]");
      if (topDialog) return topDialog;
    }
    return document.body || document.documentElement;
  }

  function ensureShadowUi(targetVideo = null) {
    const desiredRoot = getDesiredMountRoot(targetVideo);

    if (hostEl && shadow) {
      if (hostEl.parentElement !== desiredRoot && desiredRoot) {
        try {
          desiredRoot.appendChild(hostEl);
        } catch (_) {}
      }
      return;
    }

    hostEl = document.createElement("div");
    hostEl.id = "hogra-ext-shadow-host";
    shadow = hostEl.attachShadow({ mode: "open" });

    // 1. CSP-Immune adoptedStyleSheets (primary) + <link rel="stylesheet" href="chrome-extension://.../overlay.css">
    try {
      const baseSheet = new CSSStyleSheet();
      baseSheet.replaceSync(FALLBACK_CSS);
      posSheet = new CSSStyleSheet();
      posSheet.replaceSync(`.hogra-floating-panel { display: none !important; }`);
      shadow.adoptedStyleSheets = [baseSheet, posSheet];
    } catch (_) {}

    const linkEl = document.createElement("link");
    linkEl.rel = "stylesheet";
    linkEl.href = overlayCssUrl;
    shadow.appendChild(linkEl);

    panelEl = document.createElement("div");
    panelEl.className = "hogra-floating-panel";

    const pillBar = document.createElement("div");
    pillBar.className = "hogra-pill-bar";

    mainBtnEl = document.createElement("button");
    mainBtnEl.type = "button";
    mainBtnEl.className = "hogra-main-btn";
    mainBtnEl.title = "Download video with WarpDM";

    const img = document.createElement("img");
    img.src = iconUrl;
    img.className = "hogra-brand-img";
    img.alt = "W";

    labelEl = document.createElement("span");
    labelEl.textContent = "Download with WarpDM";

    const caret = document.createElement("span");
    caret.className = "hogra-caret";
    caret.textContent = "▾";

    mainBtnEl.append(img, labelEl, caret);

    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "hogra-dismiss-btn";
    dismissBtn.title = "Hide on this video";
    dismissBtn.textContent = "×";

    pillBar.append(mainBtnEl, dismissBtn);

    menuEl = document.createElement("div");
    menuEl.className = "hogra-quality-menu hogra-hidden";

    const header = document.createElement("div");
    header.className = "hogra-menu-header";
    header.textContent = "Select Download Quality";

    const items = document.createElement("div");
    items.className = "hogra-menu-items";

    const status = document.createElement("div");
    status.className = "hogra-menu-status";

    menuEl.append(header, items, status);
    panelEl.append(pillBar, menuEl);
    shadow.appendChild(panelEl);

    // Prevent clicks on Hogra pill from pausing/closing underlying Kick/Facebook modal players!
    for (const evtName of ["pointerdown", "mousedown", "mouseup", "dblclick"]) {
      panelEl.addEventListener(evtName, (e) => e.stopPropagation());
    }

    mainBtnEl.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (menuEl.classList.contains("hogra-hidden")) {
        openQualityMenu();
      } else {
        menuEl.classList.add("hogra-hidden");
      }
    });

    dismissBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (currentTargetVideo) {
        dismissedVideos.add(currentTargetVideo);
        const ctx = resolveVideoContext(currentTargetVideo);
        if (ctx?.isPermalink && ctx.permalink) dismissedPermalinks.add(ctx.permalink);
      }
      setPanelCoordinates(false);
      menuEl.classList.add("hogra-hidden");
    });

    document.addEventListener("click", (e) => {
      if (hostEl && e.composedPath && !e.composedPath().includes(hostEl)) {
        menuEl.classList.add("hogra-hidden");
      }
    });

    if (desiredRoot) desiredRoot.appendChild(hostEl);
  }

  function renderMenuOptions(options, statusText, ctx) {
    const itemsEl = menuEl.querySelector(".hogra-menu-items");
    const statusEl = menuEl.querySelector(".hogra-menu-status");
    itemsEl.textContent = "";

    for (const opt of options) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "hogra-quality-item";

      const badgeSpan = document.createElement("span");
      badgeSpan.className = "hogra-q-badge" + (opt.badge === "MP3" || opt.badge === "M4A" ? " hogra-q-audio" : "");
      badgeSpan.textContent = opt.badge || "MP4";

      const lblSpan = document.createElement("span");
      lblSpan.className = "hogra-q-label";
      lblSpan.textContent = opt.label;

      row.append(badgeSpan, lblSpan);

      if (opt.approxBytes) {
        const szSpan = document.createElement("span");
        szSpan.className = "hogra-q-size";
        szSpan.textContent = `~${formatSize(opt.approxBytes)}`;
        row.appendChild(szSpan);
      }

      row.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        triggerDownload(opt, ctx);
      });

      itemsEl.appendChild(row);
    }

    statusEl.textContent = statusText || "";
    statusEl.style.display = statusText ? "block" : "none";
  }

  function openQualityMenu() {
    if (!currentTargetVideo || !isContextValid()) return;
    const ctx = resolveVideoContext(currentTargetVideo);
    if (!ctx) return;

    const pillRect = panelEl.getBoundingClientRect();
    if (window.innerHeight - pillRect.bottom < 270 && pillRect.top > 270) {
      menuEl.classList.add("hogra-flip-up");
    } else {
      menuEl.classList.remove("hogra-flip-up");
    }

    menuEl.classList.remove("hogra-hidden");

    if (!ctx.isPermalink) {
      const genericOpts = [
        { id: "best", label: "Download Video (Best Stream / HD)", badge: "HD", forceVideo: false },
        { id: "1080p", label: "1080p Full HD Stream (MP4)", badge: "1080p", forceVideo: true },
        { id: "720p", label: "720p HD Stream (MP4)", badge: "720p", forceVideo: true },
        { id: "audio-mp3", label: "Extract Audio Only (MP3)", badge: "MP3", forceVideo: true },
      ];
      renderMenuOptions(genericOpts, "Stream sniffer & MP4 muxer ready", ctx);
      return;
    }

    const cacheKey = ctx.permalink;
    if (probeCache.has(cacheKey)) {
      const cached = probeCache.get(cacheKey);
      renderMenuOptions(
        cached.qualities.map((q) => ({ ...q, forceVideo: true })),
        `✔ ${cached.title.slice(0, 42)}`,
        { ...ctx, title: cached.title || ctx.title }
      );
      return;
    }

    const instantPresets = [
      { id: "best", label: "Best Quality (Auto MP4)", badge: "AUTO", forceVideo: true },
      { id: "1080p", label: "1080p Full HD (MP4)", badge: "1080p", forceVideo: true },
      { id: "720p", label: "720p HD (MP4)", badge: "720p", forceVideo: true },
      { id: "480p", label: "480p Standard (MP4)", badge: "480p", forceVideo: true },
      { id: "audio-mp3", label: "Audio Only — MP3", badge: "MP3", forceVideo: true },
    ];

    renderMenuOptions(instantPresets, "⚡ Checking available resolutions...", ctx);

    chrome.runtime.sendMessage(
      { type: "HOGRA_PROBE_MEDIA", url: ctx.permalink, pageUrl: window.location.href },
      (resp) => {
        if (chrome.runtime.lastError || !resp?.success || !resp.data?.qualities) {
          const statusEl = menuEl.querySelector(".hogra-menu-status");
          if (statusEl) statusEl.textContent = "Select any quality above to download";
          return;
        }
        probeCache.set(cacheKey, resp.data);
        if (!menuEl.classList.contains("hogra-hidden")) {
          renderMenuOptions(
            resp.data.qualities.map((q) => ({ ...q, forceVideo: true })),
            `✔ ${resp.data.title.slice(0, 42)}`,
            { ...ctx, title: resp.data.title || ctx.title }
          );
        }
      }
    );
  }

  function triggerDownload(opt, ctx) {
    if (!isContextValid()) return;
    menuEl.classList.add("hogra-hidden");
    labelEl.textContent = "Starting...";

    chrome.runtime.sendMessage(
      {
        type: "HOGRA_START_DOWNLOAD",
        url: ctx.permalink,
        isPermalink: ctx.isPermalink,
        pageUrl: window.location.href,
        referer: window.location.href,
        quality: opt.id === "direct" ? null : opt.id,
        forceVideo: Boolean(ctx.isPermalink || opt.forceVideo),
        filename: ctx.title || "video",
      },
      (resp) => {
        if (chrome.runtime.lastError || !resp?.success) {
          mainBtnEl.classList.add("hogra-btn-error");
          labelEl.textContent = "Open WarpDM App First!";
          setTimeout(() => {
            mainBtnEl.classList.remove("hogra-btn-error");
            labelEl.textContent = "Download with WarpDM";
          }, 3000);
          return;
        }

        mainBtnEl.classList.add("hogra-btn-success");
        labelEl.textContent = `✔ Sent (${opt.badge || "MP4"})`;
        setTimeout(() => {
          mainBtnEl.classList.remove("hogra-btn-success");
          labelEl.textContent = "Download with WarpDM";
        }, 2600);
      }
    );
  }

  function getStickyHeaderBottom(sampleX) {
    if (document.fullscreenElement || document.webkitFullscreenElement) return 0;
    try {
      const x = Math.min(window.innerWidth - 10, Math.max(10, sampleX));
      const els = document.elementsFromPoint(x, 6);
      let maxBottom = 0;
      for (const el of els) {
        if (el === hostEl) continue;
        let cur = el;
        while (cur && cur !== document.body) {
          const cs = window.getComputedStyle(cur);
          if ((cs.position === "fixed" || cs.position === "sticky") && parseFloat(cs.opacity) > 0.2) {
            const rect = cur.getBoundingClientRect();
            if (rect.top <= 6 && rect.bottom > maxBottom && rect.height < 105 && rect.width > window.innerWidth * 0.45) {
              maxBottom = rect.bottom;
            }
          }
          cur = cur.parentElement;
        }
      }
      return maxBottom;
    } catch (_) {
      return 0;
    }
  }

  function selectTargetVideo(isMenuOpen) {
    if (isMenuOpen && currentTargetVideo && currentTargetVideo.isConnected) {
      return currentTargetVideo;
    }

    if (panelEl && currentTargetVideo?.isConnected) {
      const pr = panelEl.getBoundingClientRect();
      if (pr.width > 0 && pointerX >= pr.left - 14 && pointerX <= pr.right + 14 && pointerY >= pr.top - 14 && pointerY <= pr.bottom + 14) {
        return currentTargetVideo;
      }
    }

    // If a video or player container is in Fullscreen, prioritize videos inside the fullscreen root!
    const fsRoot = document.fullscreenElement || document.webkitFullscreenElement;
    const videos = fsRoot
      ? fsRoot.tagName === "VIDEO"
        ? [fsRoot]
        : queryAllVideosDeep(fsRoot)
      : queryAllVideosDeep();

    let bestHovered = null;
    let bestHoveredScore = 0;
    let bestOverall = null;
    let bestOverallScore = 0;

    for (const v of videos) {
      // Skip only real WebRTC camera/call MediaStreams (never skip MSE MediaSourceHandle!)
      if ((typeof MediaStream !== "undefined" && v.srcObject instanceof MediaStream) || dismissedVideos.has(v)) {
        continue;
      }

      const r = v.getBoundingClientRect();
      if (r.width < 120 || r.height < 85 || r.width * r.height < 14000) continue;
      if (r.bottom < 50 || r.top > window.innerHeight - 50 || r.right < 50 || r.left > window.innerWidth - 50) continue;

      const cs = window.getComputedStyle(v);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) <= 0.02) continue;

      const inModal = Boolean(closestAcrossShadow(v, 'dialog[open], [role="dialog"], [aria-modal="true"]'));
      const modalBoost = inModal ? 8.0 : 1.0;
      const playingBoost = !v.paused && !v.ended && v.readyState >= 1 ? 2.2 : v.readyState >= 1 ? 1.3 : 1.0;
      const centerDist = Math.abs((r.top + r.bottom) / 2 - window.innerHeight / 2);
      const centerWeight = 1 - Math.min(0.45, centerDist / Math.max(1, window.innerHeight));
      const score = r.width * r.height * centerWeight * playingBoost * modalBoost;

      if (pointerX >= r.left && pointerX <= r.right && pointerY >= r.top && pointerY <= r.bottom) {
        if (score > bestHoveredScore) {
          bestHoveredScore = score;
          bestHovered = v;
        }
      }

      if (score > bestOverallScore) {
        bestOverallScore = score;
        bestOverall = v;
      }
    }

    return bestHovered || bestOverall;
  }

  function updatePanelPosition() {
    rafScheduled = false;
    if (!isContextValid()) return teardown();
    if (!floatingEnabled) {
      setPanelCoordinates(false);
      return;
    }

    const isMenuOpen = Boolean(panelEl && menuEl && !menuEl.classList.contains("hogra-hidden"));
    const video = selectTargetVideo(isMenuOpen);
    currentTargetVideo = video;

    if (!video) {
      setPanelCoordinates(false);
      return;
    }

    const ctx = resolveVideoContext(video);
    if (ctx?.isPermalink && dismissedPermalinks.has(ctx.permalink)) {
      setPanelCoordinates(false);
      return;
    }

    ensureShadowUi(video);

    // Fullscreen idle auto-hide: fade out gently after 2.8s of no mouse movement unless quality menu is open
    const inFullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    if (inFullscreen && !isMenuOpen && Date.now() - lastPointerMoveTs > 2800) {
      panelEl.classList.add("hogra-fs-idle");
    } else {
      panelEl.classList.remove("hogra-fs-idle");
    }

    const r = video.getBoundingClientRect();
    const inModal = Boolean(closestAcrossShadow(video, 'dialog[open], [role="dialog"], [aria-modal="true"]'));
    const headerBottom = inModal ? 0 : getStickyHeaderBottom(r.right - 30);
    const visibleTop = Math.max(r.top, headerBottom, 8);
    const visibleBottom = Math.min(r.bottom, window.innerHeight - 8);

    if (visibleBottom - visibleTop < 70) {
      setPanelCoordinates(false);
      return;
    }

    setPanelCoordinates(true, visibleTop + 10, 8);
    const pillWidth = panelEl.offsetWidth || 185;
    const isShorts = Boolean(closestAcrossShadow(video, "ytd-reel-video-renderer"));
    const topOffset = isShorts ? visibleTop + 54 : visibleTop + 12;
    const leftPos = Math.min(window.innerWidth - pillWidth - 10, Math.max(10, r.right - pillWidth - 12));

    setPanelCoordinates(true, topOffset, leftPos);
  }

  function scheduleScan() {
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(updatePanelPosition);
    }
  }

  window.addEventListener(
    "pointermove",
    (e) => {
      pointerX = e.clientX;
      pointerY = e.clientY;
      lastPointerMoveTs = Date.now();
      if (panelEl) panelEl.classList.remove("hogra-fs-idle");
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        clearTimeout(fsIdleTimer);
        fsIdleTimer = setTimeout(scheduleScan, 2900);
      }
      scheduleScan();
    },
    { passive: true }
  );

  window.addEventListener(
    "contextmenu",
    (e) => {
      const v = e.target?.tagName === "VIDEO" ? e.target : closestAcrossShadow(e.target, "video");
      if (v) lastContextVideo = v;
      else if (currentTargetVideo) lastContextVideo = currentTargetVideo;
    },
    { capture: true, passive: true }
  );

  for (const mediaEvt of ["play", "playing", "loadedmetadata", "loadeddata"]) {
    document.addEventListener(mediaEvt, scheduleScan, { capture: true, passive: true });
  }

  document.addEventListener("scroll", scheduleScan, { capture: true, passive: true });
  window.addEventListener("resize", scheduleScan, { passive: true });
  document.addEventListener("fullscreenchange", () => {
    lastPointerMoveTs = Date.now();
    scheduleScan();
    setTimeout(scheduleScan, 180);
  });
  document.addEventListener("webkitfullscreenchange", scheduleScan);
  window.addEventListener("yt-navigate-finish", () => {
    if (menuEl) menuEl.classList.add("hogra-hidden");
    setTimeout(scheduleScan, 300);
  });

  // React immediately when SPAs (Facebook, Kick, X, Instagram) mount modals or <video> nodes
  let mutDebounce = null;
  const domObserver = new MutationObserver(() => {
    if (mutDebounce) return;
    mutDebounce = setTimeout(() => {
      mutDebounce = null;
      scheduleScan();
    }, 220);
  });
  if (document.documentElement) {
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  setInterval(scheduleScan, 1000);
  scheduleScan();

  if (isContextValid()) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === "HOGRA_GET_ACTIVE_VIDEO") {
        const v = currentTargetVideo || selectTargetVideo(false);
        sendResponse(v ? resolveVideoContext(v) : null);
        return false;
      }

      if (msg.type === "HOGRA_GET_CONTEXT_VIDEO") {
        const v = lastContextVideo || currentTargetVideo || selectTargetVideo(false);
        sendResponse(v ? resolveVideoContext(v) : null);
        return false;
      }

      if (msg.type === "HOGRA_EXTRACT_ALL_LINKS") {
        const fileRegex = /\.(zip|rar|7z|tar|gz|iso|exe|msi|bin|mp4|mkv|webm|mp3|m4a|flac|pdf|apk|dmg)(\?.*)?$/i;
        const links = Array.from(document.querySelectorAll("a[href]"))
          .map((a) => a.href)
          .filter((href) => (href.startsWith("http://") || href.startsWith("https://")) && fileRegex.test(href));
        const uniqueLinks = Array.from(new Set(links));
        if (uniqueLinks.length > 0) {
          chrome.runtime.sendMessage({ type: "HOGRA_BATCH_LINKS", links: uniqueLinks });
        }
        sendResponse({ count: uniqueLinks.length });
        return false;
      }
    });
  }
})();

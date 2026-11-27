/**
 * Hogra Site Grabber Engine
 * Asynchronous recursive web crawler and asset extractor using resilient ProtocolHandler.
 */

import { ProtocolHandler } from "../core/protocol.mjs";

export class SiteGrabber {
  constructor(options = {}) {
    this.maxDepth = options.maxDepth || 2;
    this.sameDomainOnly = options.sameDomainOnly ?? false;
    this.allowedExtensions = options.allowedExtensions || null;
    this.forbiddenPatterns = options.forbiddenPatterns || ["logout", "signout"];
    this.protocol = new ProtocolHandler();
  }

  async crawl(startUrl) {
    const root = new URL(startUrl);
    const rootHost = root.host;

    const visited = new Set();
    const queue = [{ url: root.toString(), depth: 0 }];
    visited.add(root.toString());

    const discovered = [];
    const hrefRegex = /(?:href|src)=["']([^"']+)["']/gi;

    while (queue.length > 0 && visited.size <= 30) {
      const { url: currentUrlStr, depth } = queue.shift();

      if (this.forbiddenPatterns.some((pat) => currentUrlStr.toLowerCase().includes(pat))) {
        continue;
      }

      let res;
      try {
        res = await this.protocol.rawRequest(currentUrlStr, { method: "GET", timeoutMs: 12000 });
        if (res.statusCode < 200 || res.statusCode >= 400) {
          res.destroy();
          continue;
        }
      } catch (_) {
        continue;
      }

      const contentType = String(res.headers["content-type"] || "").toLowerCase();

      if (!contentType.includes("text/html")) {
        res.destroy();
        discovered.push({
          url: res.finalUrl || currentUrlStr,
          sourceUrl: currentUrlStr,
          depth,
          isFile: true,
        });
        continue;
      }

      let htmlText = "";
      try {
        const chunks = [];
        let total = 0;
        for await (const chunk of res) {
          chunks.push(chunk);
          total += chunk.length;
          if (total > 2 * 1024 * 1024) {
            res.destroy();
            break;
          }
        }
        htmlText = Buffer.concat(chunks).toString("utf8");
      } catch (_) {
        continue;
      }

      let match;
      hrefRegex.lastIndex = 0;
      while ((match = hrefRegex.exec(htmlText)) !== null) {
        const rawLink = match[1].trim();
        if (
          !rawLink ||
          rawLink.startsWith("#") ||
          rawLink.startsWith("javascript:") ||
          rawLink.startsWith("mailto:") ||
          rawLink.startsWith("data:")
        ) {
          continue;
        }

        try {
          const resolved = new URL(rawLink, res.finalUrl || currentUrlStr);
          const resolvedStr = resolved.toString();

          if (this.sameDomainOnly && resolved.host !== rootHost) {
            continue;
          }

          const isFile = this.matchesFileExtension(resolved.pathname);

          discovered.push({
            url: resolvedStr,
            sourceUrl: currentUrlStr,
            depth: depth + 1,
            isFile,
          });

          if (!isFile && depth + 1 < this.maxDepth && !visited.has(resolvedStr) && resolved.host === rootHost) {
            visited.add(resolvedStr);
            queue.push({ url: resolvedStr, depth: depth + 1 });
          }
        } catch (_) {}
      }
    }

    return discovered;
  }

  matchesFileExtension(pathname) {
    if (this.allowedExtensions && Array.isArray(this.allowedExtensions)) {
      return this.allowedExtensions.some((ext) =>
        pathname.toLowerCase().endsWith(`.${ext.toLowerCase()}`)
      );
    }
    const mediaExts = [
      "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "exe", "msi", "apk", "dmg",
      "mp4", "mkv", "avi", "mov", "webm", "mp3", "m4a", "wav", "flac", "ogg",
      "pdf", "docx", "xlsx", "pptx", "iso", "bin", "dat", "img",
    ];
    return mediaExts.some((ext) => pathname.toLowerCase().endsWith(`.${ext}`));
  }
}

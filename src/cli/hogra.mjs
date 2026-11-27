#!/usr/bin/env node
/**
 * WarpDM - Command Line Interface (v3.5.0)
 */

import { DownloadEngine } from "../core/engine.mjs";
import { ProtocolHandler } from "../core/protocol.mjs";
import { BridgeServer } from "../bridge/server.mjs";
import { SiteGrabber } from "../grabber/spider.mjs";

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  console.log(`
\x1b[36m\x1b[1m🚀 WarpDM CLI v3.5.0 — Warp Download Manager\x1b[0m
High-Performance Dynamic Multi-Segment Work-Stealing Download Engine

\x1b[1mCOMMANDS:\x1b[0m
  \x1b[32mdownload <url>\x1b[0m       Download file with dynamic work-stealing
      \x1b[33m--connections, -c\x1b[0m  Max concurrent connections (default: 8)
      \x1b[33m--output, -o\x1b[0m       Destination directory or file path
      \x1b[33m--limit, -l\x1b[0m        Speed limit in bytes/sec (default: 0 = unlimited)

  \x1b[32mprobe <url>\x1b[0m          Inspect remote URL metadata, Range support & size
  \x1b[32mzip-preview <url>\x1b[0m    Inspect remote ZIP central directory before download
  \x1b[32mgrab <url>\x1b[0m           Run recursive Site Grabber web crawler
  \x1b[32mserver\x1b[0m              Start Bridge WebSocket & Desktop Web UI server
      \x1b[33m--port, -p\x1b[0m         Port to bind server (default: 20888)
`);
}

async function main() {
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const engine = new DownloadEngine("./data");

  if (command === "download") {
    const url = args[1];
    if (!url) {
      console.error("\x1b[31mError: Missing download URL\x1b[0m");
      return;
    }

    let conns = 8;
    let out = "./downloads";
    let limit = 0;

    for (let i = 2; i < args.length; i++) {
      if ((args[i] === "-c" || args[i] === "--connections") && args[i + 1]) {
        conns = parseInt(args[++i], 10);
      } else if ((args[i] === "-o" || args[i] === "--output") && args[i + 1]) {
        out = args[++i];
      } else if ((args[i] === "-l" || args[i] === "--limit") && args[i + 1]) {
        limit = parseInt(args[++i], 10);
      }
    }

    console.log(`\x1b[36mTarget URL:\x1b[0m ${url}`);
    console.log(`\x1b[36mConnections:\x1b[0m ${conns}`);
    if (limit > 0) {
      engine.setGlobalSpeedLimit(limit);
      console.log(`\x1b[36mSpeed Limit:\x1b[0m ${formatBytes(limit)}/s`);
    }

    const session = await engine.startDownload(url, out, conns);

    let lastBytes = 0;
    let lastTime = Date.now();

    session.on("progress", (p) => {
      const now = Date.now();
      const elapsed = (now - lastTime) / 1000;
      const speed = elapsed > 0 ? (p.downloadedBytes - lastBytes) / elapsed : 0;
      lastBytes = p.downloadedBytes;
      lastTime = now;

      const totalStr = p.totalBytes ? formatBytes(p.totalBytes) : "Unknown";
      const pct = p.totalBytes ? ((p.downloadedBytes / p.totalBytes) * 100).toFixed(1) : "?";

      process.stdout.write(
        `\r\x1b[K[WarpDM] ${pct}% | ${formatBytes(p.downloadedBytes)} / ${totalStr} | ${formatBytes(speed)}/s | ${p.activeConnections} conns`
      );
    });

    session.on("completed", (res) => {
      console.log(`\n\x1b[32m\x1b[1m✔ Download completed successfully!\x1b[0m`);
      console.log(`Saved to: ${res.destination}`);
    });

    session.on("error", (err) => {
      console.log(`\n\x1b[31m✖ Download failed: ${err.message}\x1b[0m`);
    });
  } else if (command === "probe") {
    const url = args[1];
    if (!url) {
      console.error("\x1b[31mError: Missing URL to probe\x1b[0m");
      return;
    }

    const protocol = new ProtocolHandler();
    console.log(`\x1b[36mProbing remote URL...\x1b[0m`);
    const meta = await protocol.probe(url);

    console.log(`\n\x1b[1mRemote File Metadata:\x1b[0m`);
    console.log(`  Filename:        \x1b[32m${meta.filename}\x1b[0m`);
    console.log(
      `  Size:            ${meta.contentLength ? formatBytes(meta.contentLength) + ` (${meta.contentLength} bytes)` : "Unknown / Chunked"}`
    );
    console.log(
      `  Range Requests:  ${meta.acceptsRanges ? "\x1b[32mSupported (Multi-segment enabled)\x1b[0m" : "\x1b[31mNot Supported\x1b[0m"}`
    );
    console.log(`  Content-Type:    ${meta.contentType || "N/A"}`);
    console.log(`  ETag:            ${meta.etag || "N/A"}`);
    console.log(`  Last-Modified:   ${meta.lastModified || "N/A"}`);
  } else if (command === "zip-preview") {
    const url = args[1];
    if (!url) {
      console.error("\x1b[31mError: Missing ZIP URL\x1b[0m");
      return;
    }

    console.log(`\x1b[36mReading remote ZIP Central Directory...\x1b[0m`);
    const entries = await engine.previewRemoteZip(url);

    console.log(`\n\x1b[1mDiscovered ${entries.length} files inside remote archive:\x1b[0m\n`);
    console.log(
      `${"Filename".padEnd(50)} ${"Uncompressed".padStart(15)} ${"Compressed".padStart(15)}`
    );
    console.log("-".repeat(82));
    for (const e of entries) {
      console.log(
        `${e.filename.slice(0, 48).padEnd(50)} ${formatBytes(e.uncompressedSize).padStart(15)} ${formatBytes(e.compressedSize).padStart(15)}`
      );
    }
  } else if (command === "grab") {
    const url = args[1];
    if (!url) {
      console.error("\x1b[31mError: Missing URL to crawl\x1b[0m");
      return;
    }

    let depth = 2;
    for (let i = 2; i < args.length; i++) {
      if ((args[i] === "-d" || args[i] === "--depth") && args[i + 1]) {
        depth = parseInt(args[++i], 10);
      }
    }

    console.log(`\x1b[36mRunning Site Grabber at:\x1b[0m ${url} (depth ${depth})`);
    const grabber = new SiteGrabber({ maxDepth: depth });
    const links = await grabber.crawl(url);

    console.log(`\n\x1b[1mDiscovered ${links.length} links:\x1b[0m`);
    for (const l of links) {
      console.log(`  [${l.isFile ? "FILE" : "PAGE"}] (d=${l.depth}) ${l.url}`);
    }
  } else if (command === "server") {
    let port = 20888;
    for (let i = 1; i < args.length; i++) {
      if ((args[i] === "-p" || args[i] === "--port") && args[i + 1]) {
        port = parseInt(args[++i], 10);
      }
    }

    const bridge = new BridgeServer(engine, port);
    await bridge.start();
  } else {
    console.error(`Unknown command: ${command}`);
    printHelp();
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

main().catch((err) => {
  console.error("\x1b[31mFatal error:\x1b[0m", err);
});

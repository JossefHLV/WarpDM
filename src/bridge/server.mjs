/**
 * Hogra Bridge & Web Server (v3.0 IDM-Grade Edition)
 * - Instant <50ms Zero-Zombie Explorer Selector (ShellExecuteExW + In-Proc Shell.Application, content-hashed exe!)
 * - IDM-Style "Download File Info" Approval Dialog & Standalone Popup Launcher (Start Download / Download Later / Cancel)
 * - Native Windows Folder Picker (/api/browse-folder), Extension Folder opener, and Clean /api/shutdown
 */

import http from "node:http";
import crypto, { randomUUID } from "node:crypto";
import { spawn, execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFileCategory } from "../core/engine.mjs";
import { extractFilename, sanitizeFilename } from "../core/protocol.mjs";
import { resolveAndClassifyUrl } from "../media/ytdlp.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIR = path.resolve(__dirname, "../ui");
const ASSETS_DIR = path.resolve(__dirname, "../../assets");
const EXT_DIR = path.resolve(__dirname, "../../extension");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Private-Network": "true",
};

const WEB_APP_MANIFEST = JSON.stringify({
  name: "WarpDM — Warp Download Manager",
  short_name: "WarpDM",
  start_url: "/",
  display: "standalone",
  background_color: "#111820",
  theme_color: "#161f2a",
  icons: [
    { src: "/assets/logo128.png?v=3.5", sizes: "128x128", type: "image/png" },
    { src: "/assets/logo256.png?v=3.5", sizes: "256x256", type: "image/png" },
    { src: "/assets/logo512.png?v=3.5", sizes: "512x512", type: "image/png" },
  ],
});

/**
 * Native C# Win32 Shell Helper (Zero SHOpenFolderAndSelectItems DCOM surrogates!):
 * - "folder" : Opens folder via ShellExecuteExW("open", folder) -> delegates to Desktop Explorer.EXE in <50ms!
 * - "select" : Opens folder via ShellExecuteExW("open", folder) + selects item via in-proc Shell.Application!
 * - "browse" : Opens native Windows FolderBrowserDialog and writes chosen path to stdout!
 */
const SHELL_HELPER_CS = `
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

class HograShellHelper {
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);
    [DllImport("user32.dll")]
    static extern bool AllowSetForegroundWindow(int dwProcessId);
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")]
    static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_SHOWWINDOW = 0x0040;

    static void UnlockForeground() {
        try {
            AllowSetForegroundWindow(-1);
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
        } catch { }
    }

    static void FocusHwnd(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return;
        try {
            uint fgPid;
            IntPtr fg = GetForegroundWindow();
            uint fgTid = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out fgPid) : 0;
            uint curTid = GetCurrentThreadId();
            if (fgTid != 0 && fgTid != curTid) AttachThreadInput(curTid, fgTid, true);

            if (IsIconic(hwnd)) ShowWindow(hwnd, 9); // SW_RESTORE
            else ShowWindow(hwnd, 5);                // SW_SHOW

            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);

            if (fgTid != 0 && fgTid != curTid) AttachThreadInput(curTid, fgTid, false);
        } catch { }
    }

    static IntPtr FindLiveCabinetWindowForFolder(string normFolder) {
        string leaf = Path.GetFileName(normFolder);
        IntPtr exactMatch = IntPtr.Zero;
        IntPtr leafMatch = IntPtr.Zero;

        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            int cloaked = 0;
            try { DwmGetWindowAttribute(hWnd, 14, out cloaked, 4); } catch { }
            if (cloaked != 0) return true;

            StringBuilder sbClass = new StringBuilder(64);
            GetClassName(hWnd, sbClass, sbClass.Capacity);
            string cls = sbClass.ToString();
            if (cls != "CabinetWClass" && cls != "ExploreWClass") return true;

            StringBuilder sbTitle = new StringBuilder(512);
            GetWindowText(hWnd, sbTitle, sbTitle.Capacity);
            string title = sbTitle.ToString();
            if (string.IsNullOrEmpty(title)) return true;

            if (title.Equals(normFolder, StringComparison.OrdinalIgnoreCase) ||
                title.StartsWith(normFolder + " - ", StringComparison.OrdinalIgnoreCase) ||
                title.StartsWith(normFolder + " \\u2013 ", StringComparison.OrdinalIgnoreCase)) {
                exactMatch = hWnd;
                return false;
            }

            if (!string.IsNullOrEmpty(leaf) &&
                (title.Equals(leaf, StringComparison.OrdinalIgnoreCase) ||
                 title.StartsWith(leaf + " - ", StringComparison.OrdinalIgnoreCase) ||
                 title.StartsWith(leaf + " \\u2013 ", StringComparison.OrdinalIgnoreCase))) {
                if (leafMatch == IntPtr.Zero) leafMatch = hWnd;
            }
            return true;
        }, IntPtr.Zero);

        return exactMatch != IntPtr.Zero ? exactMatch : leafMatch;
    }

    static void TryHighlightItemIfRegistered(IntPtr liveHwnd, string fileName) {
        if (liveHwnd == IntPtr.Zero || string.IsNullOrEmpty(fileName)) return;
        try {
            Type shellType = Type.GetTypeFromProgID("Shell.Application");
            if (shellType == null) return;
            dynamic shell = Activator.CreateInstance(shellType);
            dynamic windows = shell.Windows();
            int count = (int)windows.Count;
            for (int i = count - 1; i >= 0; i--) {
                try {
                    dynamic win = windows.Item(i);
                    if (win == null) continue;
                    if (new IntPtr((long)win.HWND) != liveHwnd) continue;
                    dynamic doc = win.Document;
                    if (doc == null || doc.Folder == null) continue;
                    dynamic item = doc.Folder.ParseName(fileName);
                    if (item != null) doc.SelectItem(item, 29);
                    return;
                } catch { }
            }
        } catch { }
    }

    static void OpenSingleExplorerWindow(string folderPath, string fileName) {
        string normFolder = Path.GetFullPath(folderPath).TrimEnd('\\\\', '/');
        if (!Directory.Exists(normFolder)) return;

        // 1. Check real Win32 visible CabinetWClass windows FIRST — if already open, focus it and NEVER open a 2nd window!
        IntPtr existing = FindLiveCabinetWindowForFolder(normFolder);
        if (existing != IntPtr.Zero) {
            FocusHwnd(existing);
            TryHighlightItemIfRegistered(existing, fileName);
            return;
        }

        // 2. Launch via explorer.exe /root,"<folder>" — bypasses Windows 11 DelegateExecute DCOM 15s stall (<500ms!)
        try {
            Process.Start(new ProcessStartInfo {
                FileName = "explorer.exe",
                Arguments = "/root,\\"" + normFolder + "\\"",
                UseShellExecute = false
            });
        } catch { }

        // 3. Wait (~450ms) for the new CabinetWClass window to appear, bring straight to front, and exit cleanly
        for (int pass = 0; pass < 35; pass++) {
            Application.DoEvents();
            Thread.Sleep(45);
            IntPtr opened = FindLiveCabinetWindowForFolder(normFolder);
            if (opened != IntPtr.Zero) {
                FocusHwnd(opened);
                TryHighlightItemIfRegistered(opened, fileName);
                break;
            }
        }
    }

    [STAThread]
    static int Main(string[] args) {
        if (args.Length < 2) return 1;
        string mode = args[0];
        string target = Encoding.UTF8.GetString(Convert.FromBase64String(args[1]));

        if (mode == "browse") {
            UnlockForeground();
            Application.EnableVisualStyles();
            using (FolderBrowserDialog fbd = new FolderBrowserDialog()) {
                fbd.Description = "Select Download Destination Folder";
                fbd.ShowNewFolderButton = true;
                if (Directory.Exists(target)) fbd.SelectedPath = target;
                using (Form topDummy = new Form { TopMost = true, ShowInTaskbar = false, Opacity = 0, Size = new System.Drawing.Size(1, 1), StartPosition = FormStartPosition.CenterScreen }) {
                    topDummy.Show();
                    FocusHwnd(topDummy.Handle);
                    if (fbd.ShowDialog(topDummy) == DialogResult.OK) {
                        Console.OutputEncoding = Encoding.UTF8;
                        Console.WriteLine(fbd.SelectedPath);
                        return 0;
                    }
                }
            }
            return 2;
        }

        using (new System.Threading.Timer(_ => Environment.Exit(0), null, 2500, Timeout.Infinite)) {
            UnlockForeground();
            if (mode == "select" && (File.Exists(target) || Directory.Exists(target))) {
                string full = Path.GetFullPath(target).TrimEnd('\\\\', '/');
                string folder = Path.GetDirectoryName(full);
                string fileName = Path.GetFileName(full);
                OpenSingleExplorerWindow(folder, fileName);
                return 0;
            }

            string dirTarget = Directory.Exists(target) ? target : (Path.GetDirectoryName(target) ?? target);
            OpenSingleExplorerWindow(dirTarget, null);
            return 0;
        }
    }
}
`;

let cachedShellHelperExe = undefined;
let lastExplorerOpenTs = 0;
let lastExplorerOpenTarget = "";

function ensureShellHelper(dataDir) {
  if (cachedShellHelperExe !== undefined) return cachedShellHelperExe;
  if (process.platform !== "win32") return (cachedShellHelperExe = null);

  const hash = crypto.createHash("sha1").update(SHELL_HELPER_CS).digest("hex").slice(0, 8);
  const exeName = `hogra-shell-open-${hash}.exe`;
  const exePath = path.join(dataDir, exeName);

  // Clean any outdated helper binaries from previous versions
  try {
    for (const f of fs.readdirSync(dataDir)) {
      if (f.startsWith("hogra-shell-open") && f.endsWith(".exe") && f !== exeName) {
        try {
          fs.unlinkSync(path.join(dataDir, f));
        } catch (_) {}
      }
    }
  } catch (_) {}

  if (fs.existsSync(exePath)) return (cachedShellHelperExe = exePath);

  const cscCandidates = [
    path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  const csc = cscCandidates.find((p) => fs.existsSync(p));
  if (!csc) return (cachedShellHelperExe = null);

  try {
    const csPath = path.join(dataDir, `hogra-shell-open-${hash}.cs`);
    fs.writeFileSync(csPath, SHELL_HELPER_CS, "utf8");
    execFileSync(
      csc,
      [
        "/nologo",
        "/codepage:65001",
        "/target:winexe",
        "/optimize+",
        "/r:System.Core.dll",
        "/r:Microsoft.CSharp.dll",
        "/r:System.Windows.Forms.dll",
        "/r:System.Drawing.dll",
        `/out:${exePath}`,
        csPath,
      ],
      { windowsHide: true, stdio: "ignore" }
    );
    try {
      fs.unlinkSync(csPath);
    } catch (_) {}
    if (fs.existsSync(exePath)) return (cachedShellHelperExe = exePath);
  } catch (_) {}
  return (cachedShellHelperExe = null);
}

function resolveDownloadTarget(engine, rec) {
  const defaultDir = engine.storage.getDefaultDownloadDir();
  if (!rec) return { path: defaultDir, foundFile: false, missingFile: false };

  const candidates = [];
  if (rec.destination) {
    candidates.push(rec.destination);
    if (rec.filename) candidates.push(path.join(rec.destination, rec.filename));
  }
  if (rec.filename) {
    candidates.push(path.join(defaultDir, rec.filename));
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      const st = fs.statSync(c);
      if (st.isFile()) {
        return { path: path.resolve(c), foundFile: true, missingFile: false };
      }
    }
  }

  const parent = rec.destination ? path.dirname(rec.destination) : null;
  if (parent && fs.existsSync(parent) && fs.statSync(parent).isDirectory()) {
    return { path: path.resolve(parent), foundFile: false, missingFile: true };
  }
  return { path: defaultDir, foundFile: false, missingFile: true };
}

function openInExplorer(engine, downloadId, explicitFolderPath = null) {
  const now = Date.now();

  if (explicitFolderPath && fs.existsSync(explicitFolderPath)) {
    if (now - lastExplorerOpenTs < 650 && lastExplorerOpenTarget === explicitFolderPath) {
      return { path: explicitFolderPath, foundFile: false, missingFile: false };
    }
    lastExplorerOpenTs = now;
    lastExplorerOpenTarget = explicitFolderPath;

    const helper = ensureShellHelper(engine.storage.baseDataDir);
    if (helper) {
      const b64 = Buffer.from(explicitFolderPath, "utf8").toString("base64");
      execFile(helper, ["folder", b64], { windowsHide: false }, () => {});
      return { path: explicitFolderPath, foundFile: false, missingFile: false };
    }
  }

  const rec = downloadId ? engine.storage.getDownload(downloadId) : null;
  const resolved = resolveDownloadTarget(engine, rec);
  const mode = downloadId && resolved.foundFile ? "select" : "folder";

  if (now - lastExplorerOpenTs < 650 && lastExplorerOpenTarget === resolved.path) {
    return resolved;
  }
  lastExplorerOpenTs = now;
  lastExplorerOpenTarget = resolved.path;

  const helper = ensureShellHelper(engine.storage.baseDataDir);
  if (helper) {
    const b64 = Buffer.from(resolved.path, "utf8").toString("base64");
    execFile(helper, [mode, b64], { windowsHide: false }, () => {});
    return resolved;
  }

  const winTarget = path.win32.resolve(resolved.path);
  const dirOnly = mode === "select" ? path.dirname(winTarget) : winTarget;
  spawn("explorer.exe", [`"${dirOnly}"`], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    windowsVerbatimArguments: true,
  }).unref();

  return resolved;
}

function launchStandalonePopup(url, width = 590, height = 540) {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  const browserExe = candidates.find((p) => fs.existsSync(p));
  if (!browserExe) return;

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const profileDir = path.join(localAppData, "WarpDM", "UiProfile");
  fs.mkdirSync(profileDir, { recursive: true });

  spawn(
    browserExe,
    [
      `--app=${url}`,
      `--user-data-dir=${profileDir}`,
      `--window-size=${width},${height}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { detached: true, stdio: "ignore", windowsHide: false }
  ).unref();
}

export class BridgeServer {
  constructor(engine, port = 20888) {
    this.engine = engine;
    this.port = port;
    this.clients = new Set();
    this.pendingApprovals = new Map();
    this.server = null;

    ensureShellHelper(this.engine.storage.baseDataDir);

    this.engine.on("download_progress", (prog) => {
      this.broadcast({ type: "download_progress", data: prog });
    });

    this.engine.on("download_removed", (info) => {
      this.broadcast({ type: "download_removed", data: info });
    });

    this.engine.on("downloads_cleared", () => {
      this.broadcast({ type: "downloads_list", data: this.engine.listHistory() });
    });

    this.engine.on("speed_limit_updated", (data) => {
      this.broadcast({ type: "speed_limit_updated", data });
    });
  }

  /**
   * Creates an IDM-style Download File Info pending approval item, probes metadata asynchronously,
   * and launches a dedicated approval popup window right over the browser!
   */
  createApprovalRequest(body) {
    const { url, isStreaming } = resolveAndClassifyUrl(body.url, body.pageUrl || body.referer);
    const now = Date.now();

    // Expire stale unanswered approval entries older than 10 minutes
    for (const [oldId, oldItem] of this.pendingApprovals) {
      if (now - oldItem.createdAt > 10 * 60 * 1000) this.pendingApprovals.delete(oldId);
    }

    // Deduplicate: if an approval dialog is already open for this exact URL, reuse it without spawning another window!
    for (const existing of this.pendingApprovals.values()) {
      if (existing.url === url && now - existing.createdAt < 60000) {
        return existing;
      }
    }

    const id = randomUUID();
    const isVideo = Boolean(isStreaming || body.forceVideo || body.quality);
    const initialQuality = body.quality || "best";
    const extGuess = initialQuality === "audio-mp3" ? ".mp3" : initialQuality === "audio-m4a" ? ".m4a" : ".mp4";

    let guessName = body.filename
      ? sanitizeFilename(String(body.filename).replace(/^\(\d+\)\s*/, ""))
      : extractFilename({}, url);
    if (isVideo && !/\.(mp4|mkv|webm|mp3|m4a)$/i.test(guessName)) {
      guessName = sanitizeFilename(`${guessName}${extGuess}`);
    }

    const category = classifyFileCategory(guessName, isVideo, isVideo ? initialQuality : null);
    const folder = body.destination || this.engine.getSuggestedFolderForCategory(category);

    const item = {
      id,
      url,
      rawRequest: body,
      isVideo,
      probing: true,
      filename: guessName,
      folder,
      category,
      totalBytes: null,
      acceptsRanges: null,
      quality: initialQuality,
      maxConnections: body.max_connections || body.connections || this.engine.getSettings().max_connections || 8,
      qualities: [],
      probeError: null,
      createdAt: Date.now(),
    };

    this.pendingApprovals.set(id, item);

    // Probe exact size, filename, Range capability, or video qualities in background
    this.engine
      .probeDownloadInfo(url, {
        pageUrl: body.pageUrl || null,
        referer: body.referer || null,
        cookies: body.cookies || null,
        cookiesTxt: body.cookiesTxt || null,
        headers: body.headers || null,
        filename: body.filename || null,
        quality: initialQuality,
        forceVideo: isVideo,
      })
      .then((probed) => {
        const cur = this.pendingApprovals.get(id);
        if (!cur) return;
        cur.probing = false;
        cur.url = probed.url || cur.url;
        cur.filename = probed.filename || cur.filename;
        cur.totalBytes = probed.totalBytes;
        cur.acceptsRanges = probed.acceptsRanges;
        cur.category = probed.category || cur.category;
        cur.folder = body.destination || this.engine.getSuggestedFolderForCategory(cur.category);
        if (Array.isArray(probed.qualities) && probed.qualities.length > 0) {
          cur.qualities = probed.qualities;
        }
        this.broadcast({ type: "approval_updated", data: this._publicApprovalView(cur) });
      })
      .catch((err) => {
        const cur = this.pendingApprovals.get(id);
        if (!cur) return;
        cur.probing = false;
        cur.probeError = err.message || "Metadata probe unavailable";
        this.broadcast({ type: "approval_updated", data: this._publicApprovalView(cur) });
      });

    // Pop up standalone IDM-style Download File Info dialog right over the browser (strictly rate-limited against bursts!)
    const sinceLastPopup = Date.now() - (this.lastApprovalPopupTs || 0);
    if (
      !body.suppressPopup &&
      sinceLastPopup > 900 &&
      this.pendingApprovals.size <= 3 &&
      process.env.HOGRA_HEADLESS_TEST !== "1" &&
      process.env.WARPDM_HEADLESS_TEST !== "1"
    ) {
      this.lastApprovalPopupTs = Date.now();
      launchStandalonePopup(`http://127.0.0.1:${this.port}/approval.html?id=${id}`, 615, 565);
    }

    return item;
  }

  _publicApprovalView(item) {
    return {
      id: item.id,
      url: item.url,
      isVideo: item.isVideo,
      probing: item.probing,
      filename: item.filename,
      folder: item.folder,
      category: item.category,
      totalBytes: item.totalBytes,
      acceptsRanges: item.acceptsRanges,
      quality: item.quality,
      maxConnections: item.maxConnections,
      qualities: item.qualities,
      probeError: item.probeError,
      baseDownloadDir: this.engine.storage.getDefaultDownloadDir(),
    };
  }

  start() {
    this.server = http.createServer(async (req, res) => {
      const parsedUrl = new URL(req.url, `http://127.0.0.1:${this.port}`);
      const pathname = parsedUrl.pathname;

      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      if (pathname.startsWith("/api/")) {
        await this.handleHttpApi(req, res, pathname, parsedUrl);
        return;
      }

      if (pathname === "/favicon.ico") {
        const icoPath = path.join(ASSETS_DIR, "app.ico");
        if (fs.existsSync(icoPath)) {
          res.writeHead(200, { "Content-Type": "image/x-icon", "Cache-Control": "no-cache" });
          fs.createReadStream(icoPath).pipe(res);
          return;
        }
      }

      if (pathname === "/manifest.webmanifest") {
        res.writeHead(200, {
          "Content-Type": "application/manifest+json; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(WEB_APP_MANIFEST);
        return;
      }

      if (pathname.startsWith("/assets/")) {
        const assetRel = path.basename(pathname);
        const assetPath = path.join(ASSETS_DIR, assetRel);
        if (fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
          const ext = path.extname(assetPath).toLowerCase();
          res.writeHead(200, {
            ...CORS_HEADERS,
            "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
            "Cache-Control": "no-cache",
          });
          fs.createReadStream(assetPath).pipe(res);
          return;
        }
        res.writeHead(404);
        res.end("Asset Not Found");
        return;
      }

      const safeRel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      let filePath = path.join(UI_DIR, safeRel);

      if (!filePath.startsWith(UI_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        if (path.extname(pathname) && pathname !== "/approval.html" && pathname !== "/progress.html") {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }
        filePath = path.join(UI_DIR, "index.html");
      }

      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      });
      fs.createReadStream(filePath).pipe(res);
    });

    this.server.on("upgrade", (req, socket) => {
      const key = req.headers["sec-websocket-key"];
      if (!key) {
        socket.destroy();
        return;
      }

      const hash = crypto
        .createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");

      const responseHeaders = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${hash}`,
      ];

      socket.write(responseHeaders.join("\r\n") + "\r\n\r\n");

      const isAuxClient = (req.url || "").includes("role=approval") || (req.url || "").includes("role=progress");
      const client = {
        socket,
        role: isAuxClient ? "aux" : "main",
        send: (obj) => {
          try {
            if (!socket.destroyed && socket.writable) {
              sendWsFrame(socket, 0x81, Buffer.from(JSON.stringify(obj), "utf8"));
            }
          } catch (_) {}
        },
      };

      this.clients.add(client);

      handleWsConnection(client, this, () => {
        this.clients.delete(client);
      });
    });

    return new Promise((resolve, reject) => {
      this.server.listen(this.port, "127.0.0.1", () => {
        console.log(`[Bridge] WarpDM Server running at http://127.0.0.1:${this.port}/`);
        resolve(this.port);
      });
      this.server.on("error", reject);
    });
  }

  async handleHttpApi(req, res, pathname, parsedUrl) {
    const sendJson = (code, obj) => {
      res.writeHead(code, {
        ...CORS_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(obj));
    };

    try {
      if (pathname === "/api/status" && req.method === "GET") {
        if (parsedUrl.searchParams.get("client") === "extension") {
          const prevConnected = Boolean(this.lastExtensionPingAt);
          this.lastExtensionPingAt = Date.now();
          if (!prevConnected) {
            this.broadcast({ type: "extension_connected", data: { connected: true } });
          }
        }
        sendJson(200, {
          status: "ok",
          server: "WarpDM",
          version: "3.5.0",
          extensionDir: EXT_DIR,
          extensionConnected: Boolean(this.lastExtensionPingAt),
          capabilities: this.engine.getCapabilities(),
          settings: this.engine.getSettings(),
        });
        return;
      }

      if (pathname === "/api/browsers" && req.method === "GET") {
        const pf = process.env.ProgramFiles || "C:\\Program Files";
        const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
        const lad = process.env.LOCALAPPDATA || "";
        const browserDefs = [
          { id: "chrome", name: "Google Chrome", extUrl: "chrome://extensions", paths: [path.join(pf, "Google\\Chrome\\Application\\chrome.exe"), path.join(pf86, "Google\\Chrome\\Application\\chrome.exe"), path.join(lad, "Google\\Chrome\\Application\\chrome.exe")] },
          { id: "brave", name: "Brave", extUrl: "brave://extensions", paths: [path.join(pf, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"), path.join(pf86, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"), path.join(lad, "BraveSoftware\\Brave-Browser\\Application\\brave.exe")] },
          { id: "edge", name: "Microsoft Edge", extUrl: "edge://extensions", paths: [path.join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"), path.join(pf, "Microsoft\\Edge\\Application\\msedge.exe")] },
          { id: "opera", name: "Opera / GX", extUrl: "opera://extensions", paths: [path.join(lad, "Programs\\Opera\\opera.exe"), path.join(lad, "Programs\\Opera GX\\opera.exe"), path.join(pf, "Opera\\opera.exe")] },
          { id: "vivaldi", name: "Vivaldi", extUrl: "vivaldi://extensions", paths: [path.join(lad, "Vivaldi\\Application\\vivaldi.exe"), path.join(pf, "Vivaldi\\Application\\vivaldi.exe")] },
          { id: "firefox", name: "Mozilla Firefox", extUrl: "about:debugging#/runtime/this-firefox", paths: [path.join(pf, "Mozilla Firefox\\firefox.exe"), path.join(pf86, "Mozilla Firefox\\firefox.exe")] },
        ];
        const browsers = browserDefs.map((b) => {
          const exe = b.paths.find((p) => p && fs.existsSync(p)) || null;
          return { id: b.id, name: b.name, extUrl: b.extUrl, installed: Boolean(exe) };
        });
        const ffManifest = path.resolve(__dirname, "../../extension-firefox", "manifest.json");
        const ffXpi = path.resolve(__dirname, "../../WarpDM-Firefox.xpi");
        sendJson(200, {
          status: "ok",
          extensionDir: EXT_DIR,
          firefoxManifestPath: fs.existsSync(ffManifest) ? ffManifest : path.join(EXT_DIR, "manifest.json"),
          firefoxXpiPath: fs.existsSync(ffXpi) ? ffXpi : null,
          extensionConnected: Boolean(this.lastExtensionPingAt),
          browsers,
        });
        return;
      }

      if (pathname === "/api/downloads" && req.method === "GET") {
        sendJson(200, { status: "ok", data: this.engine.listHistory() });
        return;
      }

      if (pathname === "/api/download-item" && req.method === "GET") {
        const id = parsedUrl.searchParams.get("id");
        if (!id) return sendJson(400, { status: "error", message: "Missing id" });

        const live = this.engine.getSession(id);
        if (live) {
          const snaps = live.chunksList ? live.chunksList.snapshots() : (live._buildSyntheticChunks ? live._buildSyntheticChunks() : []);
          const dl = live.chunksList ? live.chunksList.totalDownloaded : (live.downloadedBytes ?? live.totalDownloaded ?? 0);
          const tot = live.metadata ? live.metadata.contentLength : (live.totalBytes ?? null);
          const pct =
            live.state === "completed"
              ? 100
              : live.progressPercent > 0
                ? live.progressPercent
                : tot && tot > 0
                  ? Math.min(99.9, (dl / tot) * 100)
                  : 0;
          sendJson(200, {
            status: "ok",
            speedLimitBytesPerSec: this.engine.globalLimiter.bytesPerSecond,
            settings: this.engine.getSettings(),
            data: {
              downloadId: live.id,
              url: live.url,
              filename: live.filename,
              destination: live.destination,
              state: live.state,
              statusText: live.statusText || null,
              totalBytes: tot,
              downloadedBytes: dl,
              progressPercent: pct,
              bytesPerSec: Math.round(live.bytesPerSec || 0),
              etaSeconds: live.etaSeconds ?? null,
              errorMessage: live.errorMessage || null,
              chunks: snaps,
            },
          });
          return;
        }

        const rec = this.engine.storage.getDownload(id);
        if (!rec) return sendJson(404, { status: "error", message: "Download not found" });
        const savedChunks = this.engine.storage.getChunks(id).map((r) => ({
          id: r.chunk_id,
          startByte: r.start_byte,
          currentByte: r.current_byte,
          endByte: r.end_byte,
          status: r.status,
        }));
        const dlBytes = rec.status === "completed" && rec.total_size ? rec.total_size : rec.downloaded_size || 0;
        const pct =
          rec.status === "completed"
            ? 100
            : rec.total_size && rec.total_size > 0
              ? Math.min(99.9, (dlBytes / rec.total_size) * 100)
              : 0;

        sendJson(200, {
          status: "ok",
          speedLimitBytesPerSec: this.engine.globalLimiter.bytesPerSecond,
          settings: this.engine.getSettings(),
          data: {
            downloadId: rec.id,
            url: rec.url,
            filename: rec.filename,
            destination: rec.destination,
            state: rec.status,
            statusText: rec.status === "completed" ? "Complete" : rec.status,
            totalBytes: rec.total_size,
            downloadedBytes: dlBytes,
            progressPercent: pct,
            bytesPerSec: 0,
            etaSeconds: null,
            errorMessage: rec.error_message || null,
            chunks: savedChunks,
          },
        });
        return;
      }

      if (pathname === "/api/approval" && req.method === "GET") {
        const id = parsedUrl.searchParams.get("id");
        const item = id ? this.pendingApprovals.get(id) : null;
        if (!item) return sendJson(404, { status: "error", message: "Approval session expired or already handled" });
        sendJson(200, { status: "ok", data: this._publicApprovalView(item) });
        return;
      }

      const body = req.method === "POST" ? await readJsonBody(req) : {};

      if (pathname === "/api/probe-media" && req.method === "POST") {
        if (!body.url) return sendJson(400, { status: "error", message: "Missing url" });
        const info = await this.engine.probeMedia(body.url, body.pageUrl || null, {
          cookies: body.cookies || null,
          cookiesTxt: body.cookiesTxt || null,
          userAgent: body.userAgent || null,
        });
        sendJson(200, { status: "ok", data: info });
        return;
      }

      if (pathname === "/api/probe-info" && req.method === "POST") {
        if (!body.url) return sendJson(400, { status: "error", message: "Missing url" });
        const info = await this.engine.probeDownloadInfo(body.url, body);
        sendJson(200, { status: "ok", data: info });
        return;
      }

      if (pathname === "/api/download" && req.method === "POST") {
        if (!body.url) return sendJson(400, { status: "error", message: "Missing download url" });

        // IDM-Style Approval Check: If captured from Browser Extension (not pre-approved) and ask_confirmation is enabled,
        // pop up the Download File Info dialog so the user approves Start Download / Download Later / Cancel!
        const askConf = this.engine.getSettings().ask_confirmation !== false;
        if (!body.approved && body.skipApproval !== true && askConf) {
          const pending = this.createApprovalRequest(body);
          sendJson(200, { status: "ok", pending_approval_id: pending.id, awaiting_approval: true });
          return;
        }

        const session = await this.engine.startDownload(
          body.url,
          body.destination || null,
          body.max_connections || body.connections || null,
          {
            referer: body.referer || null,
            pageUrl: body.pageUrl || null,
            cookies: body.cookies || null,
            cookiesTxt: body.cookiesTxt || null,
            headers: body.headers || null,
            fallbackStreams: body.fallbackStreams || null,
            filename: body.filename || null,
            quality: body.quality || null,
            forceVideo: !!body.forceVideo,
          }
        );

        const showProgPopup = this.engine.getSettings().show_progress_popup !== false;
        if (
          showProgPopup &&
          !body.suppressPopup &&
          !body.fromMainUi &&
          process.env.HOGRA_HEADLESS_TEST !== "1" &&
          process.env.WARPDM_HEADLESS_TEST !== "1"
        ) {
          launchStandalonePopup(`http://127.0.0.1:${this.port}/progress.html?id=${encodeURIComponent(session.id)}`, 625, 565);
        }

        sendJson(200, { status: "ok", download_id: session.id });
        return;
      }

      if (pathname === "/api/approve-download" && req.method === "POST") {
        const { id, mode, filename, folder, quality, total_bytes, max_connections, disable_future_prompts } = body;
        const item = this.pendingApprovals.get(id);
        if (!item) return sendJson(404, { status: "error", message: "Approval item no longer active" });

        this.pendingApprovals.delete(id);

        if (disable_future_prompts) {
          this.engine.updateSettings({ ask_confirmation: false });
        }

        if (mode === "cancel") {
          this.broadcast({ type: "approval_resolved", data: { id, mode } });
          sendJson(200, { status: "ok", action: "cancelled" });
          return;
        }

        const raw = item.rawRequest || {};
        const cleanFolder = this.engine.storage.ensureDirectorySafe(folder || item.folder);
        const cleanFilename = sanitizeFilename(filename || item.filename);
        const fullDest = item.isVideo ? cleanFolder : path.join(cleanFolder, cleanFilename);
        const knownTotal = total_bytes || item.totalBytes || null;

        if (mode === "later") {
          const dlId = this.engine.saveDownloadLater(item.url, cleanFolder, {
            filename: cleanFilename,
            totalBytes: knownTotal,
            quality: item.isVideo ? quality || item.quality : null,
            forceVideo: item.isVideo,
            referer: raw.referer || null,
            pageUrl: raw.pageUrl || null,
            cookies: raw.cookies || null,
            cookiesTxt: raw.cookiesTxt || null,
          });
          this.broadcast({ type: "approval_resolved", data: { id, mode, download_id: dlId } });
          sendJson(200, { status: "ok", action: "saved_later", download_id: dlId });
          return;
        }

        const session = await this.engine.startDownload(
          item.url,
          fullDest,
          max_connections || item.maxConnections || 8,
          {
            filename: cleanFilename,
            customFilenameApproved: true,
            initialTotalBytes: knownTotal,
            quality: item.isVideo ? quality || item.quality : null,
            forceVideo: item.isVideo,
            referer: raw.referer || null,
            pageUrl: raw.pageUrl || null,
            cookies: raw.cookies || null,
            cookiesTxt: raw.cookiesTxt || null,
            headers: raw.headers || null,
            fallbackStreams: raw.fallbackStreams || null,
          }
        );

        this.broadcast({ type: "approval_resolved", data: { id, mode, download_id: session.id } });
        sendJson(200, { status: "ok", action: "started", download_id: session.id });
        return;
      }

      if (pathname === "/api/open-progress-window" && req.method === "POST") {
        if (body.download_id && process.env.HOGRA_HEADLESS_TEST !== "1" && process.env.WARPDM_HEADLESS_TEST !== "1") {
          launchStandalonePopup(
            `http://127.0.0.1:${this.port}/progress.html?id=${encodeURIComponent(body.download_id)}`,
            625,
            565
          );
        }
        sendJson(200, { status: "ok" });
        return;
      }

      if (pathname === "/api/browse-folder" && req.method === "POST") {
        const helper = ensureShellHelper(this.engine.storage.baseDataDir);
        const startDir = body.initialDir || this.engine.storage.getDefaultDownloadDir();
        if (!helper) return sendJson(200, { status: "ok", folder: null });

        const chosen = await new Promise((resolve) => {
          const b64 = Buffer.from(startDir, "utf8").toString("base64");
          const p = spawn(helper, ["browse", b64], { windowsHide: false });
          let out = "";
          p.stdout.on("data", (d) => (out += d.toString("utf8")));
          p.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
          p.on("error", () => resolve(null));
        });
        sendJson(200, { status: "ok", folder: chosen });
        return;
      }

      if (pathname === "/api/open-extension-folder" && req.method === "POST") {
        if (body.highlightParent) {
          const helper = ensureShellHelper(this.engine.storage.baseDataDir);
          if (helper && fs.existsSync(EXT_DIR)) {
            const b64 = Buffer.from(EXT_DIR, "utf8").toString("base64");
            execFile(helper, ["select", b64], { windowsHide: false }, () => {});
            sendJson(200, { status: "ok", path: EXT_DIR });
            return;
          }
        }
        openInExplorer(this.engine, null, EXT_DIR);
        sendJson(200, { status: "ok", path: EXT_DIR });
        return;
      }

      if (pathname === "/api/batch-download" && req.method === "POST") {
        const urls = Array.isArray(body.urls) ? body.urls : [];
        const started = [];
        for (const u of urls.slice(0, 50)) {
          const s = await this.engine.startDownload(u, body.destination || null, null, {
            referer: body.referer || null,
            cookies: body.cookies || null,
          });
          started.push(s.id);
        }
        sendJson(200, { status: "ok", count: started.length, ids: started });
        return;
      }

      if (pathname === "/api/open-folder" && req.method === "POST") {
        const result = openInExplorer(this.engine, body.download_id || null);
        sendJson(200, { status: "ok", data: result });
        return;
      }

      if (pathname === "/api/speed-limit" && req.method === "POST") {
        const bps = Math.max(0, Number(body.bytes_per_sec) || 0);
        this.engine.setGlobalSpeedLimit(bps);
        const patch = {};
        if (body.save_kbps !== undefined && body.save_kbps > 0) patch.speed_limit_kbps = Number(body.save_kbps);
        if (body.startup_enabled !== undefined) patch.speed_limit_startup = !!body.startup_enabled;
        if (Object.keys(patch).length > 0) this.engine.updateSettings(patch);
        sendJson(200, { status: "ok", bytes_per_sec: bps });
        return;
      }

      if (pathname === "/api/autostart" && req.method === "POST") {
        const enable = !!body.enable;
        this.engine.updateSettings({ launch_on_startup: enable });
        if (process.platform === "win32") {
          try {
            const exeCandidate = path.resolve(__dirname, "../../WarpDM.exe");
            if (enable && fs.existsSync(exeCandidate)) {
              execFileSync(
                "reg.exe",
                [
                  "add",
                  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
                  "/v",
                  "WarpDM",
                  "/t",
                  "REG_SZ",
                  "/d",
                  `"${exeCandidate}"`,
                  "/f",
                ],
                { windowsHide: true, stdio: "ignore" }
              );
            } else if (!enable) {
              execFileSync(
                "reg.exe",
                ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "WarpDM", "/f"],
                { windowsHide: true, stdio: "ignore" }
              );
            }
          } catch (_) {}
        }
        sendJson(200, { status: "ok", launch_on_startup: enable });
        return;
      }

      if (pathname === "/api/ui-command" && req.method === "POST") {
        const mainClients = [...this.clients].filter((c) => c.role === "main");
        const delivered = mainClients.length > 0;
        if (delivered) {
          this.broadcast({ type: "ui_command", data: { modal: body.modal || "focus" } });
        }
        sendJson(200, { status: "ok", delivered });
        return;
      }

      if (pathname === "/api/shutdown" && req.method === "POST") {
        this.broadcast({ type: "app_shutdown" });
        this.engine.shutdown();
        sendJson(200, { status: "ok" });
        setTimeout(() => process.exit(0), 150);
        return;
      }

      sendJson(404, { status: "error", message: `Unknown endpoint: ${pathname}` });
    } catch (err) {
      sendJson(500, { status: "error", message: err.message || "Internal server error" });
    }
  }

  broadcast(obj) {
    for (const client of this.clients) {
      client.send(obj);
    }
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.length > 4 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function handleWsConnection(client, bridge, onDisconnect) {
  const engine = bridge.engine;
  let buffer = Buffer.alloc(0);

  client.socket.on("data", async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const framesToProcess = [];

    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;

      let offset = 2;
      if (payloadLen === 126) {
        if (buffer.length < 4) break;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) break;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      let maskKey = null;
      if (isMasked) {
        if (buffer.length < offset + 4) break;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (buffer.length < offset + payloadLen) break;

      const payload = Buffer.from(buffer.subarray(offset, offset + payloadLen));
      buffer = buffer.subarray(offset + payloadLen);

      if (isMasked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      framesToProcess.push({ opcode, payload });
    }

    for (const frame of framesToProcess) {
      if (frame.opcode === 0x8) {
        client.socket.end();
        onDisconnect();
        return;
      }
      if (frame.opcode === 0x9) {
        try {
          sendWsFrame(client.socket, 0x8a, frame.payload);
        } catch (_) {}
        continue;
      }
      if (frame.opcode === 0x1) {
        const text = frame.payload.toString("utf8");
        let parsedMsg = null;
        try {
          parsedMsg = JSON.parse(text);
          await processMessage(client, bridge, engine, parsedMsg);
        } catch (e) {
          client.send({
            type: "error",
            requestId: parsedMsg?.requestId,
            status: "error",
            message: e.message,
          });
        }
      }
    }
  });

  client.socket.on("close", onDisconnect);
  client.socket.on("error", onDisconnect);
}

async function processMessage(client, bridge, engine, msg) {
  const { action, payload = {}, requestId } = msg;

  switch (action) {
    case "ping":
      client.send({ type: "pong", requestId, status: "ok", data: { pong: true } });
      break;

    case "handshake":
      client.send({
        type: "handshake_ack",
        requestId,
        status: "ok",
        data: {
          server: "WarpDM",
          version: "3.2.0",
          status: "ready",
          extensionDir: EXT_DIR,
          capabilities: engine.getCapabilities(),
        },
      });
      break;

    case "list_downloads":
      client.send({ type: "downloads_list", requestId, status: "ok", data: engine.listHistory() });
      break;

    case "get_settings":
      client.send({
        type: "settings",
        requestId,
        status: "ok",
        data: { ...engine.getCapabilities(), extensionDir: EXT_DIR },
      });
      break;

    case "update_settings": {
      const updated = engine.updateSettings(payload);
      client.send({ type: "settings_updated", requestId, status: "ok", data: updated });
      break;
    }

    case "start_download":
    case "add_download": {
      const {
        url,
        destination,
        max_connections,
        connections,
        referer,
        pageUrl,
        cookies,
        cookiesTxt,
        headers,
        fallbackStreams,
        filename,
        quality,
        forceVideo,
        customFilenameApproved,
      } = payload;

      const session = await engine.startDownload(
        url,
        destination || null,
        max_connections || connections || null,
        {
          referer: referer || null,
          pageUrl: pageUrl || null,
          cookies: cookies || null,
          cookiesTxt: cookiesTxt || null,
          headers: headers || null,
          fallbackStreams: fallbackStreams || null,
          filename: filename || null,
          customFilenameApproved: !!customFilenameApproved,
          initialTotalBytes: payload.total_bytes || null,
          authUser: payload.authUser || null,
          authPass: payload.authPass || null,
          quality: quality || null,
          forceVideo: !!forceVideo,
        }
      );

      client.send({
        type: "download_started",
        requestId,
        status: "ok",
        data: { download_id: session.id, status: "started" },
      });
      break;
    }

    case "download_later": {
      const id = engine.saveDownloadLater(payload.url, payload.folder || null, payload);
      client.send({ type: "action_ack", requestId, status: "ok", data: { download_id: id } });
      break;
    }

    case "start_queue": {
      const count = await engine.startQueue(payload.queue_name || null);
      client.send({ type: "action_ack", requestId, status: "ok", data: { started: count } });
      break;
    }

    case "move_to_queue": {
      const ok = engine.moveToQueue(payload.download_id, payload.queue_name || "main");
      client.send({ type: "downloads_list", requestId, status: ok ? "ok" : "error", data: engine.listHistory() });
      break;
    }

    case "stop_all": {
      const count = engine.stopAll();
      client.send({ type: "action_ack", requestId, status: "ok", data: { stopped: count } });
      break;
    }

    case "batch_download": {
      const urls = Array.isArray(payload.urls) ? payload.urls : [];
      const ids = [];
      for (const u of urls.slice(0, 50)) {
        const s = await engine.startDownload(u, payload.destination || null, null, {
          referer: payload.referer || null,
          cookies: payload.cookies || null,
        });
        ids.push(s.id);
      }
      client.send({ type: "batch_started", requestId, status: "ok", data: { count: ids.length, ids } });
      break;
    }

    case "pause_download": {
      const ok = engine.pauseDownload(payload.download_id);
      client.send({ type: "action_ack", requestId, status: ok ? "ok" : "error", data: { paused: ok } });
      break;
    }

    case "resume_download": {
      const ok = await engine.resumeDownload(payload.download_id);
      client.send({ type: "action_ack", requestId, status: ok ? "ok" : "error", data: { resumed: ok } });
      break;
    }

    case "retry_download": {
      const ok = await engine.retryDownload(payload.download_id);
      client.send({ type: "action_ack", requestId, status: ok ? "ok" : "error", data: { retried: ok } });
      break;
    }

    case "cancel_download": {
      const ok = engine.cancelDownload(payload.download_id);
      client.send({ type: "action_ack", requestId, status: ok ? "ok" : "error", data: { cancelled: ok } });
      break;
    }

    case "delete_download": {
      const ok = engine.deleteDownload(payload.download_id, !!payload.delete_file);
      client.send({ type: "action_ack", requestId, status: ok ? "ok" : "error", data: { deleted: ok } });
      break;
    }

    case "clear_downloads": {
      const count = engine.clearDownloads(payload.mode || "failed");
      client.send({ type: "action_ack", requestId, status: "ok", data: { cleared: count } });
      break;
    }

    case "open_folder": {
      const result = openInExplorer(engine, payload.download_id || null);
      client.send({ type: "open_folder_result", requestId, status: "ok", data: result });
      break;
    }

    case "open_extension_folder": {
      openInExplorer(engine, null, EXT_DIR);
      client.send({ type: "action_ack", requestId, status: "ok", data: { path: EXT_DIR } });
      break;
    }

    case "probe_info": {
      try {
        const info = await engine.probeDownloadInfo(payload.url, payload);
        client.send({ type: "probe_info_result", requestId, status: "ok", data: info });
      } catch (err) {
        client.send({ type: "probe_info_result", requestId, status: "error", message: err.message });
      }
      break;
    }

    case "preview_zip": {
      try {
        const entries = await engine.previewRemoteZip(payload.url);
        client.send({ type: "zip_preview_result", requestId, status: "ok", data: entries });
      } catch (err) {
        client.send({ type: "zip_preview_result", requestId, status: "error", message: err.message });
      }
      break;
    }

    case "crawl_site": {
      try {
        const links = await engine.crawlSite(payload.url, payload.max_depth || 1);
        client.send({ type: "crawl_result", requestId, status: "ok", data: links });
      } catch (err) {
        client.send({ type: "crawl_result", requestId, status: "error", message: err.message });
      }
      break;
    }

    case "probe_media": {
      try {
        const info = await engine.probeMedia(payload.url, payload.pageUrl || null, {
          cookies: payload.cookies || null,
          cookiesTxt: payload.cookiesTxt || null,
        });
        client.send({ type: "media_probe_result", requestId, status: "ok", data: info });
      } catch (err) {
        client.send({ type: "media_probe_result", requestId, status: "error", message: err.message });
      }
      break;
    }

    case "set_speed_limit": {
      engine.setGlobalSpeedLimit(payload.bytes_per_sec || 0);
      client.send({ type: "action_ack", requestId, status: "ok", data: { speed_limit: payload.bytes_per_sec } });
      break;
    }

    default:
      client.send({ type: "error", requestId, status: "error", message: `Unknown action: ${action}` });
  }
}

function sendWsFrame(socket, firstByte, payloadBuffer) {
  const len = payloadBuffer.length;
  let header;
  if (len < 126) {
    header = Buffer.from([firstByte, len]);
  } else if (len <= 65535) {
    header = Buffer.alloc(4);
    header[0] = firstByte;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = firstByte;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payloadBuffer]));
}

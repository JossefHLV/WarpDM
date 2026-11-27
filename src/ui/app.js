/**
 * WarpDM v3.5.0 — Power-User Desktop Controller
 * - IDM-style 4-Zone Layout: Top Menu Bar, Graphic Neon/Glass Toolbar, Expandable TreeView, & Grid Data Table
 * - High-frequency 80ms smooth in-place progress & speed rendering (never freezes at 0%!)
 * - Custom KB/s & MB/s Speed Limiter, 6-Tab Configuration, Queue Scheduler, HTTP Basic Auth, Right-Click Context Menu, & 10-Language i18n
 */

let socket = null;
let isShuttingDown = false;
const downloads = new Map();
const selectedIds = new Set();
let lastClickedRowId = null;
let contextTargetId = null;
let currentHudDownloadId = null;

let activeTreeState = "all";   // 'all' | 'unfinished' | 'finished' | 'queue'
let activeTreeCategory = "all"; // 'all' | 'compressed' | 'documents' | 'music' | 'programs' | 'video'
let activeQueueFilter = "all";  // 'all' | 'main' | 'scheduled'
let searchQuery = "";
let sortField = "createdAt";
let sortDir = "desc";
let currentSpeedLimitBps = 0;
let pendingAuthCreds = { user: "", pass: "" };
let probedModalBytes = null;
let lastClipboardUrl = "";

const DEFAULT_FILE_TYPES =
  "3GP 7Z AAC APK AVI BIN BZ2 DMG EXE FLAC GZ IMG ISO M4A M4V MKV MOV MP3 MP4 MSI OGG PDF PPTX RAR TAR WAV WEBM XLSX XZ ZIP";

let appSettings = {
  default_download_dir: "",
  category_dirs: {},
  temp_parts_dir: "",
  max_connections: 8,
  max_concurrent_downloads: 4,
  quiet_mode: true,
  auto_capture: true,
  ask_confirmation: true,
  show_progress_popup: true,
  category_subfolders: false,
  duplicate_action: "rename",
  custom_user_agent: "",
  captured_file_types: DEFAULT_FILE_TYPES,
  excluded_domains: "*.update.microsoft.com download.windowsupdate.com",
  speed_limit_kbps: 0,
  speed_limit_startup: false,
  proxy_host: "",
  proxy_port: "",
  sound_complete: false,
  sound_failed: false,
  sound_queue_done: false,
  scheduler_enabled: false,
  scheduler_start_time: "02:00",
  scheduler_stop_enabled: false,
  scheduler_stop_time: "07:00",
  scheduler_max_concurrent: 2,
  launch_on_startup: false,
  clipboard_monitor: false,
  ui_theme: "warp-dark",
  toolbar_size: "large",
  toolbar_style: "neon",
  ui_language: "en",
};

const I18N = {
  en: {
    menu_tasks: "Tasks", menu_file: "File", menu_downloads: "Downloads", menu_view: "View", menu_help: "Help",
    tb_add_url: "Add URL", tb_resume: "Resume", tb_stop: "Stop", tb_stop_all: "Stop All", tb_delete: "Delete",
    tb_del_comp: "Delete Comp.", tb_options: "Options", tb_scheduler: "Scheduler", tb_start_q: "Start Queue",
    tb_stop_q: "Stop Queue", tb_grabber: "Grabber", cat_header: "Categories", cat_all: "All Downloads",
    cat_comp: "Compressed", cat_docs: "Documents", cat_music: "Music", cat_prog: "Programs", cat_video: "Video",
    cat_unfinished: "Unfinished", cat_finished: "Finished", col_fname: "File Name", col_size: "Size",
    col_status: "Status", col_eta: "Time left", col_rate: "Transfer rate", col_date: "Last Try Date", col_desc: "Description / Source",
  },
  ar: {
    menu_tasks: "المهام", menu_file: "ملف", menu_downloads: "التحميلات", menu_view: "عرض", menu_help: "مساعدة",
    tb_add_url: "إضافة رابط", tb_resume: "استئناف", tb_stop: "إيقاف", tb_stop_all: "إيقاف الكل", tb_delete: "حذف",
    tb_del_comp: "حذف المكتمل", tb_options: "الخيارات", tb_scheduler: "الجدولة", tb_start_q: "بدء القائمة",
    tb_stop_q: "إيقاف القائمة", tb_grabber: "ملتقط المواقع", cat_header: "التصنيفات", cat_all: "كل التحميلات",
    cat_comp: "مضغوطة", cat_docs: "مستندات", cat_music: "موسيقى", cat_prog: "برامج", cat_video: "فيديو",
    cat_unfinished: "غير مكتملة", cat_finished: "مكتملة", col_fname: "اسم الملف", col_size: "الحجم",
    col_status: "الحالة", col_eta: "الوقت المتبقي", col_rate: "سرعة النقل", col_date: "آخر محاولة", col_desc: "المصدر",
  },
  fr: {
    menu_tasks: "Tâches", menu_file: "Fichier", menu_downloads: "Téléchargements", menu_view: "Affichage", menu_help: "Aide",
    tb_add_url: "Ajouter URL", tb_resume: "Reprendre", tb_stop: "Arrêter", tb_stop_all: "Tout arrêter", tb_delete: "Supprimer",
    tb_del_comp: "Purger finis", tb_options: "Options", tb_scheduler: "Planificateur", tb_start_q: "Démarrer file",
    tb_stop_q: "Arrêter file", tb_grabber: "Aspirateur", cat_header: "Catégories", cat_all: "Tous",
    cat_comp: "Compressés", cat_docs: "Documents", cat_music: "Musique", cat_prog: "Programmes", cat_video: "Vidéos",
    cat_unfinished: "Non terminés", cat_finished: "Terminés", col_fname: "Nom du fichier", col_size: "Taille",
    col_status: "État", col_eta: "Temps restant", col_rate: "Vitesse", col_date: "Date", col_desc: "Source",
  },
  es: {
    menu_tasks: "Tareas", menu_file: "Archivo", menu_downloads: "Descargas", menu_view: "Ver", menu_help: "Ayuda",
    tb_add_url: "Añadir URL", tb_resume: "Reanudar", tb_stop: "Detener", tb_stop_all: "Detener todo", tb_delete: "Eliminar",
    tb_del_comp: "Borrar comp.", tb_options: "Opciones", tb_scheduler: "Programador", tb_start_q: "Iniciar cola",
    tb_stop_q: "Parar cola", tb_grabber: "Capturador", cat_header: "Categorías", cat_all: "Todas las descargas",
    cat_comp: "Comprimidos", cat_docs: "Documentos", cat_music: "Música", cat_prog: "Programas", cat_video: "Vídeo",
    cat_unfinished: "Incompletas", cat_finished: "Completadas", col_fname: "Nombre", col_size: "Tamaño",
    col_status: "Estado", col_eta: "Tiempo rest.", col_rate: "Velocidad", col_date: "Fecha", col_desc: "Origen",
  },
  de: {
    menu_tasks: "Aufgaben", menu_file: "Datei", menu_downloads: "Downloads", menu_view: "Ansicht", menu_help: "Hilfe",
    tb_add_url: "URL hinzuf.", tb_resume: "Fortsetzen", tb_stop: "Stopp", tb_stop_all: "Alle stoppen", tb_delete: "Löschen",
    tb_del_comp: "Fertige lösch.", tb_options: "Optionen", tb_scheduler: "Zeitplaner", tb_start_q: "Warteschl. an",
    tb_stop_q: "Warteschl. aus", tb_grabber: "Grabber", cat_header: "Kategorien", cat_all: "Alle Downloads",
    cat_comp: "Archive", cat_docs: "Dokumente", cat_music: "Musik", cat_prog: "Programme", cat_video: "Video",
    cat_unfinished: "Unvollständig", cat_finished: "Fertiggestellt", col_fname: "Dateiname", col_size: "Größe",
    col_status: "Status", col_eta: "Restzeit", col_rate: "Rate", col_date: "Datum", col_desc: "Quelle",
  },
  tr: {
    menu_tasks: "Görevler", menu_file: "Dosya", menu_downloads: "İndirmeler", menu_view: "Görünüm", menu_help: "Yardım",
    tb_add_url: "URL Ekle", tb_resume: "Devam Et", tb_stop: "Durdur", tb_stop_all: "Tümünü Durdur", tb_delete: "Sil",
    tb_del_comp: "Bitenleri Sil", tb_options: "Seçenekler", tb_scheduler: "Zamanlayıcı", tb_start_q: "Kuyruğu Başlat",
    tb_stop_q: "Kuyruğu Durdur", tb_grabber: "Site Kazıyıcı", cat_header: "Kategoriler", cat_all: "Tüm İndirmeler",
    cat_comp: "Sıkıştırılmış", cat_docs: "Belgeler", cat_music: "Müzik", cat_prog: "Programlar", cat_video: "Video",
    cat_unfinished: "Tamamlanmamış", cat_finished: "Tamamlanmış", col_fname: "Dosya Adı", col_size: "Boyut",
    col_status: "Durum", col_eta: "Kalan Süre", col_rate: "Aktarım Hızı", col_date: "Son Deneme", col_desc: "Kaynak",
  },
  ru: {
    menu_tasks: "Задачи", menu_file: "Файл", menu_downloads: "Загрузки", menu_view: "Вид", menu_help: "Справка",
    tb_add_url: "Добавить URL", tb_resume: "Продолжить", tb_stop: "Стоп", tb_stop_all: "Остановить все", tb_delete: "Удалить",
    tb_del_comp: "Очистить гот.", tb_options: "Настройки", tb_scheduler: "Планировщик", tb_start_q: "Старт очереди",
    tb_stop_q: "Стоп очереди", tb_grabber: "Граббер", cat_header: "Категории", cat_all: "Все загрузки",
    cat_comp: "Архивы", cat_docs: "Документы", cat_music: "Музыка", cat_prog: "Программы", cat_video: "Видео",
    cat_unfinished: "Незавершенные", cat_finished: "Завершенные", col_fname: "Имя файла", col_size: "Размер",
    col_status: "Статус", col_eta: "Осталось", col_rate: "Скорость", col_date: "Дата", col_desc: "Источник",
  },
  pt: {
    menu_tasks: "Tarefas", menu_file: "Arquivo", menu_downloads: "Downloads", menu_view: "Exibir", menu_help: "Ajuda",
    tb_add_url: "Adicionar URL", tb_resume: "Retomar", tb_stop: "Parar", tb_stop_all: "Parar Tudo", tb_delete: "Excluir",
    tb_del_comp: "Limpar Concl.", tb_options: "Opções", tb_scheduler: "Agendador", tb_start_q: "Iniciar Fila",
    tb_stop_q: "Parar Fila", tb_grabber: "Grabber", cat_header: "Categorias", cat_all: "Todos os Downloads",
    cat_comp: "Compactados", cat_docs: "Documentos", cat_music: "Música", cat_prog: "Programas", cat_video: "Vídeo",
    cat_unfinished: "Inacabados", cat_finished: "Concluídos", col_fname: "Nome do Arquivo", col_size: "Tamanho",
    col_status: "Status", col_eta: "Tempo Rest.", col_rate: "Taxa", col_date: "Data", col_desc: "Origem",
  },
  zh: {
    menu_tasks: "任务", menu_file: "文件", menu_downloads: "下载", menu_view: "视图", menu_help: "帮助",
    tb_add_url: "新建任务", tb_resume: "继续", tb_stop: "暂停", tb_stop_all: "全部暂停", tb_delete: "删除",
    tb_del_comp: "清除已完成", tb_options: "选项设置", tb_scheduler: "计划任务", tb_start_q: "开始队列",
    tb_stop_q: "停止队列", tb_grabber: "站点抓取", cat_header: "分类目录", cat_all: "全部下载",
    cat_comp: "压缩包", cat_docs: "文档", cat_music: "音乐", cat_prog: "程序", cat_video: "视频",
    cat_unfinished: "未完成", cat_finished: "已完成", col_fname: "文件名", col_size: "大小",
    col_status: "状态", col_eta: "剩余时间", col_rate: "传输速度", col_date: "最后尝试", col_desc: "来源",
  },
  ja: {
    menu_tasks: "タスク", menu_file: "ファイル", menu_downloads: "ダウンロード", menu_view: "表示", menu_help: "ヘルプ",
    tb_add_url: "URL追加", tb_resume: "再開", tb_stop: "停止", tb_stop_all: "すべて停止", tb_delete: "削除",
    tb_del_comp: "完了分削除", tb_options: "設定", tb_scheduler: "スケジューラ", tb_start_q: "キュー開始",
    tb_stop_q: "キュー停止", tb_grabber: "グラバー", cat_header: "カテゴリ", cat_all: "すべて",
    cat_comp: "圧縮", cat_docs: "書類", cat_music: "音楽", cat_prog: "プログラム", cat_video: "動画",
    cat_unfinished: "未完了", cat_finished: "完了済み", col_fname: "ファイル名", col_size: "サイズ",
    col_status: "状態", col_eta: "残り時間", col_rate: "転送速度", col_date: "日時", col_desc: "ソース",
  },
};

const STREAMING_URL_REGEX =
  /(youtube\.com\/|youtu\.be\/|tiktok\.com\/|x\.com\/|twitter\.com\/|instagram\.com\/|twitch\.tv\/|vimeo\.com\/|facebook\.com\/|fb\.watch\/|reddit\.com\/|v\.redd\.it\/|dailymotion\.com\/|kick\.com\/|streamable\.com\/|\.m3u8($|[?#;])|\.mpd($|[?#;]))/i;

const DEFAULT_VIDEO_QUALITIES = [
  { id: "best", label: "Best Quality (Auto 4K / 1080p MP4)" },
  { id: "2160p", label: "2160p 4K Ultra HD (MP4)" },
  { id: "1440p", label: "1440p 2K QHD (MP4)" },
  { id: "1080p", label: "1080p Full HD (MP4)" },
  { id: "720p", label: "720p HD (MP4)" },
  { id: "480p", label: "480p SD (MP4)" },
  { id: "audio-mp3", label: "Audio Only — MP3" },
  { id: "audio-m4a", label: "Audio Only — M4A" },
];

// Synthesized WebAudio Notification Chimes (Zero external WAV dependencies!)
window.playEventChime = function (kind = "complete") {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const notes =
      kind === "failed"
        ? [330, 240]
        : kind === "queue"
          ? [523.25, 659.25, 783.99, 1046.5]
          : [587.33, 880];

    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = kind === "failed" ? "sawtooth" : "sine";
      osc.frequency.setValueAtTime(freq, now + idx * 0.11);
      gain.gain.setValueAtTime(0.09, now + idx * 0.11);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.11 + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.11);
      osc.stop(now + idx * 0.11 + 0.24);
    });
  } catch (_) {}
};

function initWebSocket() {
  if (isShuttingDown) return;
  socket = new WebSocket(`ws://${window.location.host}`);

  socket.onopen = () => {
    const badge = document.getElementById("engineStatus");
    badge.textContent = "● Ready";
    badge.className = "meta-chip chip-online";

    sendWs({ action: "list_downloads" });
    sendWs({ action: "get_settings" });
    checkInitialUrlModal();
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === "app_shutdown") {
        isShuttingDown = true;
        window.close();
        return;
      }

      if (msg.type === "downloads_list" || (msg.status === "ok" && !msg.type && Array.isArray(msg.data))) {
        downloads.clear();
        for (const item of msg.data) {
          const dlBytes = item.status === "completed" && item.total_size ? item.total_size : item.downloaded_size || 0;
          downloads.set(item.id, {
            downloadId: item.id,
            url: item.url,
            filename: item.filename,
            destination: item.destination,
            totalBytes: item.total_size,
            downloadedBytes: dlBytes,
            progressPercent:
              item.status === "completed"
                ? 100
                : item.total_size > 0
                  ? Math.min(99.9, (dlBytes / item.total_size) * 100)
                  : 0,
            state: item.status,
            statusText: item.status === "completed" ? "Complete" : item.status,
            bytesPerSec: 0,
            etaSeconds: null,
            activeConnections: 0,
            mediaFormat: item.media_format || null,
            queueName: item.queue_name || "main",
            errorMessage: item.error_message || null,
            createdAt: item.created_at ? Date.parse(item.created_at) : Date.now(),
            chunks: [],
          });
        }
        for (const id of [...selectedIds]) {
          if (!downloads.has(id)) selectedIds.delete(id);
        }
        renderTable();
      } else if (msg.type === "download_progress") {
        const prog = msg.data;
        const prev = downloads.get(prog.downloadId);
        prog.createdAt = prev?.createdAt ?? Date.now();
        prog.queueName = prev?.queueName || prog.queueName || "main";
        downloads.set(prog.downloadId, prog);

        if (!prev || prev.state !== prog.state) {
          renderTable();
          if (prev && prev.state !== "completed" && prog.state === "completed") {
            if (appSettings.sound_complete) window.playEventChime("complete");
            if (!appSettings.quiet_mode) showToast(`✔ Completed: ${prog.filename}`);
          } else if (prev && prev.state !== "failed" && prog.state === "failed") {
            if (appSettings.sound_failed) window.playEventChime("failed");
          }
        } else {
          renderRow(prog, true);
          updateTreeCounts();
          updateGlobalTelemetry();
        }

        if (currentHudDownloadId === prog.downloadId) {
          renderHud(prog);
        }
      } else if (msg.type === "download_removed") {
        downloads.delete(msg.data.downloadId);
        selectedIds.delete(msg.data.downloadId);
        if (currentHudDownloadId === msg.data.downloadId) closeHud();
        renderTable();
      } else if (msg.type === "open_folder_result") {
        if (msg.data?.missingFile) {
          showToast("File was moved or deleted — opened download folder instead", "warn");
        }
      } else if (msg.type === "speed_limit_updated") {
        syncSpeedLimitPill(msg.data?.bytes_per_sec || 0);
      } else if (msg.type === "ui_command") {
        window.focus();
        openRequestedModal(msg.data?.modal);
      } else if (msg.type === "probe_info_result") {
        handleProbeInfoResult(msg);
      } else if (msg.type === "zip_preview_result") {
        handleZipPreviewResult(msg);
      } else if (msg.type === "crawl_result") {
        handleCrawlResult(msg);
      } else if (msg.type === "media_probe_result") {
        handleMediaProbeResult(msg);
      } else if (msg.type === "settings") {
        if (msg.data?.settings) {
          appSettings = { ...appSettings, ...msg.data.settings };
          applyVisualPreferences();
          populateSettingsModal(msg.data);
          syncSpeedLimitPill(msg.data.speedLimitBytesPerSec || 0);
        }
      } else if (msg.type === "settings_updated") {
        appSettings = { ...appSettings, ...msg.data };
        applyVisualPreferences();
        showToast("WarpDM configuration saved");
      } else if (msg.type === "error" || msg.status === "error") {
        if (msg.message) showToast(msg.message, "err");
      }
    } catch (e) {
      console.error("WS parse error:", e);
    }
  };

  socket.onclose = () => {
    if (isShuttingDown) return;
    const badge = document.getElementById("engineStatus");
    badge.textContent = "○ Reconnecting...";
    badge.className = "meta-chip";
    setTimeout(initWebSocket, 1600);
  };
}

window.sendWs = function (obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
};

// Top Menu Bar Interaction
document.querySelectorAll(".menu-root").forEach((root) => {
  root.querySelector(".menu-trigger").addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = root.classList.contains("open");
    document.querySelectorAll(".menu-root").forEach((r) => r.classList.remove("open"));
    if (!wasOpen) root.classList.add("open");
  });
  root.addEventListener("mouseenter", () => {
    const anyOpen = document.querySelector(".menu-root.open");
    if (anyOpen && anyOpen !== root) {
      document.querySelectorAll(".menu-root").forEach((r) => r.classList.remove("open"));
      root.classList.add("open");
    }
  });
});

document.addEventListener("click", () => {
  document.querySelectorAll(".menu-root").forEach((r) => r.classList.remove("open"));
  document.getElementById("rowContextMenu").classList.add("hidden");
});

window.closeModal = function (id) {
  document.getElementById(id)?.classList.add("hidden");
  if (id === "hudModal") currentHudDownloadId = null;
};

// Visual Preferences (Theme, Toolbar Size/Style, Language)
function applyVisualPreferences() {
  document.documentElement.setAttribute("data-theme", appSettings.ui_theme || "warp-dark");
  const tb = document.getElementById("actionToolbar");
  tb.classList.toggle("size-small", appSettings.toolbar_size === "small");
  tb.classList.toggle("style-glass", appSettings.toolbar_style === "glass");
  applyLanguageDict(appSettings.ui_language || "en");
}

window.setTheme = function (theme) {
  appSettings.ui_theme = theme;
  applyVisualPreferences();
  sendWs({ action: "update_settings", payload: { ui_theme: theme } });
};

window.setToolbarMode = function (size, style) {
  appSettings.toolbar_size = size;
  appSettings.toolbar_style = style;
  applyVisualPreferences();
  sendWs({ action: "update_settings", payload: { toolbar_size: size, toolbar_style: style } });
};

window.setLanguage = function (lang) {
  appSettings.ui_language = lang;
  applyLanguageDict(lang);
  sendWs({ action: "update_settings", payload: { ui_language: lang } });
};

function applyLanguageDict(lang) {
  const dict = I18N[lang] || I18N.en;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const k = el.getAttribute("data-i18n");
    if (dict[k]) el.textContent = dict[k];
  });
}

window.toggleCategoriesSidebar = function () {
  const sb = document.getElementById("treeSidebar");
  const hidden = sb.classList.toggle("hidden");
  document.getElementById("lblToggleCatTree").textContent = hidden ? "Show Categories Tree" : "✓ Show Categories Tree";
};

window.toggleBranch = function (e, subId) {
  e.stopPropagation();
  const sub = document.getElementById(subId);
  if (!sub) return;
  const hidden = sub.classList.toggle("hidden");
  e.target.textContent = hidden ? "▸" : "▾";
};

window.selectTreeNode = function (nodeEl) {
  document.querySelectorAll(".tree-node").forEach((n) => n.classList.remove("active"));
  nodeEl.classList.add("active");
  activeTreeState = nodeEl.dataset.state || "all";
  activeTreeCategory = nodeEl.dataset.cat || "all";
  activeQueueFilter = nodeEl.dataset.queue || "all";
  renderTable();
};

function getItemCategory(item) {
  const fname = item.filename || "";
  if (item.mediaFormat) {
    if (String(item.mediaFormat).startsWith("audio-")) return "music";
    return "video";
  }
  const dotIdx = fname.lastIndexOf(".");
  const ext = dotIdx > 0 ? fname.slice(dotIdx + 1).toLowerCase() : "";
  if (["zip", "rar", "7z", "iso", "tar", "gz", "bz2", "xz"].includes(ext)) return "compressed";
  if (["pdf", "doc", "docx", "txt", "xlsx", "pptx", "csv", "md", "epub"].includes(ext)) return "documents";
  if (["mp3", "wav", "flac", "aac", "ogg", "m4a", "opus"].includes(ext)) return "music";
  if (["exe", "msi", "apk", "bat", "dmg", "deb", "rpm"].includes(ext)) return "programs";
  if (["mp4", "mkv", "avi", "mov", "webm", "ts", "flv"].includes(ext)) return "video";
  if (STREAMING_URL_REGEX.test(item.url || "")) return "video";
  return "other";
}

function getFileTypeBadge(item) {
  const cat = getItemCategory(item);
  if (cat === "video") return { cls: "ft-video", ico: "🎬" };
  if (cat === "music") return { cls: "ft-music", ico: "🎵" };
  if (cat === "compressed") return { cls: "ft-arch", ico: "🗜" };
  if (cat === "programs") return { cls: "ft-exe", ico: "⚙" };
  if (cat === "documents") return { cls: "ft-doc", ico: "📄" };
  return { cls: "ft-gen", ico: "📦" };
}

function matchesCurrentFilter(item) {
  if (activeTreeState === "finished" && item.state !== "completed") return false;
  if (activeTreeState === "unfinished" && item.state === "completed") return false;
  if (activeTreeState === "queue") {
    if (item.state === "completed") return false;
    if (activeQueueFilter !== "all" && (item.queueName || "main") !== activeQueueFilter) return false;
  }
  if (activeTreeCategory !== "all" && getItemCategory(item) !== activeTreeCategory) return false;

  if (searchQuery) {
    const hay = `${item.filename || ""} ${item.url || ""}`.toLowerCase();
    if (!hay.includes(searchQuery)) return false;
  }
  return true;
}

window.setSort = function (field, dir) {
  sortField = field;
  sortDir = dir;
  renderTable();
};

function getSortedFilteredItems() {
  const list = [...downloads.values()].filter(matchesCurrentFilter);
  const mult = sortDir === "asc" ? 1 : -1;

  list.sort((a, b) => {
    if (sortField === "filename") return mult * String(a.filename || "").localeCompare(String(b.filename || ""));
    if (sortField === "size") return mult * ((a.totalBytes || a.downloadedBytes || 0) - (b.totalBytes || b.downloadedBytes || 0));
    if (sortField === "progress") return mult * (parseFloat(computeProgressPct(a)) - parseFloat(computeProgressPct(b)));
    if (sortField === "speed") return mult * ((a.bytesPerSec || 0) - (b.bytesPerSec || 0));
    if (sortField === "eta") return mult * ((a.etaSeconds ?? 999999) - (b.etaSeconds ?? 999999));
    if (sortField === "domain") {
      const da = safeHost(a.url);
      const db = safeHost(b.url);
      return mult * da.localeCompare(db);
    }
    return mult * ((a.createdAt || 0) - (b.createdAt || 0));
  });
  return list;
}

function safeHost(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

function computeProgressPct(item) {
  if (item.state === "completed") return "100.0";
  if (typeof item.progressPercent === "number" && item.progressPercent > 0) {
    return Math.min(99.9, item.progressPercent).toFixed(1);
  }
  if (item.totalBytes && item.totalBytes > 0) {
    return Math.min(99.9, (item.downloadedBytes / item.totalBytes) * 100).toFixed(1);
  }
  return "0.0";
}

function formatSizeColumn(item) {
  if (item.totalBytes && item.totalBytes > 0) return formatBytes(item.totalBytes);
  if (item.downloadedBytes && item.downloadedBytes > 0) return formatBytes(item.downloadedBytes);
  if (item.state === "probing") return "Probing...";
  return "--";
}

function formatShortDate(ts) {
  if (!ts) return "--";
  const d = new Date(ts);
  const mon = d.toLocaleString("en-US", { month: "short" });
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${mon} ${d.getDate()} ${hh}:${mm}`;
}

function renderStatusHtml(item, pct) {
  if (item.state === "completed") {
    return `<span class="st-complete">Complete</span>`;
  }
  if (item.state === "failed") {
    return `<span class="st-failed" title="${escapeHtml(item.errorMessage || "Failed")}">Error</span>`;
  }
  if (item.state === "paused") {
    return `<span class="st-paused">Paused (${pct}%)</span>`;
  }
  return `
    <div class="status-cell-wrap">
      <div class="mini-prog-track"><div class="mini-prog-fill" style="width:${pct}%"></div></div>
      <span class="st-active">${pct}%</span>
    </div>
  `;
}

function renderTable() {
  const tbody = document.getElementById("transferTableBody");
  const emptyState = document.getElementById("emptyState");
  tbody.innerHTML = "";

  const visibleItems = getSortedFilteredItems();
  for (const item of visibleItems) {
    renderRow(item, false);
  }

  emptyState.classList.toggle("hidden", visibleItems.length > 0);
  applyColumnVisibility();
  updateTreeCounts();
  updateGlobalTelemetry();
  updateSortIndicators();
}

function renderRow(item, inPlaceOnly = false) {
  if (!matchesCurrentFilter(item)) return;

  const tbody = document.getElementById("transferTableBody");
  let tr = document.getElementById(`row-${item.downloadId}`);

  const total = formatSizeColumn(item);
  const pct = computeProgressPct(item);
  const speed = item.bytesPerSec && item.bytesPerSec > 0 ? `${formatBytes(item.bytesPerSec)}/s` : "";
  const eta = formatEta(item.etaSeconds, item.state);

  // High-frequency 80ms DOM-safe in-place cell updates
  if (inPlaceOnly && tr && tr.dataset.state === item.state) {
    const fnEl = tr.querySelector(".fname-primary");
    if (fnEl && fnEl.textContent !== item.filename) {
      fnEl.textContent = item.filename;
      fnEl.title = item.filename;
    }
    const szEl = tr.querySelector(".cell-size");
    if (szEl) szEl.textContent = total;
    const fillEl = tr.querySelector(".mini-prog-fill");
    if (fillEl) fillEl.style.width = `${pct}%`;
    const actPct = tr.querySelector(".st-active");
    if (actPct) actPct.textContent = `${pct}%`;
    const etaEl = tr.querySelector(".cell-eta");
    if (etaEl) etaEl.textContent = eta;
    const spdEl = tr.querySelector(".cell-speed");
    if (spdEl) spdEl.textContent = speed;
    return;
  }

  if (inPlaceOnly && !tr) {
    renderTable();
    return;
  }

  const isSelected = selectedIds.has(item.downloadId);
  const ft = getFileTypeBadge(item);
  const qBadge = (item.queueName || "main") === "scheduled" ? "S" : "M";
  const host = safeHost(item.url);
  const desc = item.state === "failed" && item.errorMessage
    ? `⚠ ${item.errorMessage}`
    : `${host}${item.mediaFormat ? ` [${item.mediaFormat.toUpperCase()}]` : ""}`;

  let actionBtns = "";
  if (item.state === "downloading" || item.state === "probing" || item.state === "queued" || item.state === "merging") {
    actionBtns = `
      <button class="btn btn-secondary btn-icon-sm" onclick="pauseDl('${item.downloadId}')" title="Pause">⏸</button>
      <button class="btn btn-secondary btn-icon-sm" onclick="openHud('${item.downloadId}')" title="Details">HUD</button>
      <button class="btn btn-danger-sm btn-icon-sm" onclick="deleteDl('${item.downloadId}')" title="Cancel">✕</button>
    `;
  } else if (item.state === "paused") {
    actionBtns = `
      <button class="btn btn-primary btn-icon-sm" onclick="resumeDl('${item.downloadId}')" title="Resume">▶</button>
      <button class="btn btn-secondary btn-icon-sm" onclick="openHud('${item.downloadId}')" title="Details">HUD</button>
      <button class="btn btn-danger-sm btn-icon-sm" onclick="deleteDl('${item.downloadId}')" title="Remove">🗑</button>
    `;
  } else if (item.state === "failed") {
    actionBtns = `
      <button class="btn btn-primary btn-icon-sm" onclick="retryDl('${item.downloadId}')" title="Retry / Continue">↻</button>
      <button class="btn btn-secondary btn-icon-sm" onclick="openHud('${item.downloadId}')" title="Error Info">HUD</button>
      <button class="btn btn-danger-sm btn-icon-sm" onclick="deleteDl('${item.downloadId}')" title="Remove">🗑</button>
    `;
  } else {
    actionBtns = `
      <button class="btn btn-secondary btn-icon-sm" onclick="openFolder('${item.downloadId}')" title="Show in Windows Explorer">📂 Folder</button>
      <button class="btn btn-danger-sm btn-icon-sm" onclick="deleteDl('${item.downloadId}')" title="Remove from list">🗑</button>
    `;
  }

  const innerHtml = `
    <td><input type="checkbox" class="row-chk" data-id="${item.downloadId}" ${isSelected ? "checked" : ""}></td>
    <td>
      <div class="fname-wrap">
        <span class="ftype-badge ${ft.cls}">${ft.ico}</span>
        <span class="fname-primary" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</span>
      </div>
    </td>
    <td data-col="q" style="color:#94a3b8;text-align:center;">${qBadge}</td>
    <td data-col="size" class="cell-size">${total}</td>
    <td data-col="status">${renderStatusHtml(item, pct)}</td>
    <td data-col="eta" class="cell-eta">${eta}</td>
    <td data-col="speed" class="text-accent cell-speed">${speed}</td>
    <td data-col="date" style="color:#94a3b8;">${formatShortDate(item.createdAt)}</td>
    <td data-col="desc" title="${escapeHtml(desc)}" style="color:#94a3b8;">${escapeHtml(desc)}</td>
    <td><div class="row-actions">${actionBtns}</div></td>
  `;

  if (!tr) {
    tr = document.createElement("tr");
    tr.id = `row-${item.downloadId}`;

    tr.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      if (e.target.classList.contains("row-chk")) {
        if (e.target.checked) selectedIds.add(item.downloadId);
        else selectedIds.delete(item.downloadId);
      } else if (e.ctrlKey || e.metaKey) {
        if (selectedIds.has(item.downloadId)) selectedIds.delete(item.downloadId);
        else selectedIds.add(item.downloadId);
      } else if (e.shiftKey && lastClickedRowId) {
        const visible = getSortedFilteredItems().map((x) => x.downloadId);
        const a = visible.indexOf(lastClickedRowId);
        const b = visible.indexOf(item.downloadId);
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selectedIds.add(visible[i]);
        }
      } else {
        selectedIds.clear();
        selectedIds.add(item.downloadId);
      }
      lastClickedRowId = item.downloadId;
      syncRowSelectionUI();
    });

    tr.addEventListener("dblclick", (e) => {
      if (e.target.closest("button") || e.target.closest("input")) return;
      const cur = downloads.get(item.downloadId);
      if (cur?.state === "completed") window.openFolder(item.downloadId);
      else window.openHud(item.downloadId);
    });

    tr.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      contextTargetId = item.downloadId;
      if (!selectedIds.has(item.downloadId)) {
        selectedIds.clear();
        selectedIds.add(item.downloadId);
        syncRowSelectionUI();
      }
      const menu = document.getElementById("rowContextMenu");
      menu.classList.remove("hidden");
      const mw = 220, mh = 310;
      menu.style.left = `${Math.min(window.innerWidth - mw - 8, e.clientX)}px`;
      menu.style.top = `${Math.min(window.innerHeight - mh - 8, e.clientY)}px`;
    });

    tbody.appendChild(tr);
  }

  tr.dataset.state = item.state;
  tr.className = `transfer-row${isSelected ? " row-selected" : ""}`;
  tr.innerHTML = innerHtml;
}

function syncRowSelectionUI() {
  document.querySelectorAll("#transferTableBody tr.transfer-row").forEach((tr) => {
    const id = tr.id.replace(/^row-/, "");
    const sel = selectedIds.has(id);
    tr.classList.toggle("row-selected", sel);
    const chk = tr.querySelector(".row-chk");
    if (chk) chk.checked = sel;
  });
  const visible = getSortedFilteredItems();
  document.getElementById("selectAllRows").checked =
    visible.length > 0 && visible.every((x) => selectedIds.has(x.downloadId));
  updateGlobalTelemetry();
}

document.getElementById("selectAllRows").addEventListener("change", (e) => {
  const visible = getSortedFilteredItems();
  if (e.target.checked) visible.forEach((x) => selectedIds.add(x.downloadId));
  else visible.forEach((x) => selectedIds.delete(x.downloadId));
  syncRowSelectionUI();
});

// Toolbar & Menu Selection Actions
window.actSelected = function (act) {
  const targets = selectedIds.size > 0 ? [...selectedIds] : contextTargetId ? [contextTargetId] : [];
  if (targets.length === 0) {
    showToast("Select one or more transfers in the list first", "warn");
    return;
  }
  for (const id of targets) {
    const item = downloads.get(id);
    if (!item) continue;
    if (act === "resume") {
      if (item.state === "failed") window.retryDl(id);
      else window.resumeDl(id);
    } else if (act === "pause") window.pauseDl(id);
    else if (act === "retry") window.retryDl(id);
    else if (act === "folder") window.openFolder(id);
    else if (act === "hud") { window.openHud(id); break; }
    else if (act === "remove") window.deleteDl(id, false);
    else if (act === "delete_disk") window.deleteDl(id, true);
  }
};

window.ctxAct = function (act) {
  document.getElementById("rowContextMenu").classList.add("hidden");
  const id = contextTargetId || [...selectedIds][0];
  if (!id) return;
  const item = downloads.get(id);

  if (act === "copy" && item?.url) {
    navigator.clipboard?.writeText(item.url);
    showToast("Copied download URL to clipboard");
  } else if (act === "mini") {
    fetch("/api/open-progress-window", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ download_id: id }),
    });
  } else if (act === "q_main") {
    for (const tid of selectedIds.size ? selectedIds : [id]) {
      sendWs({ action: "move_to_queue", payload: { download_id: tid, queue_name: "main" } });
    }
    showToast("Moved to Main Download Queue");
  } else if (act === "q_sched") {
    for (const tid of selectedIds.size ? selectedIds : [id]) {
      sendWs({ action: "move_to_queue", payload: { download_id: tid, queue_name: "scheduled" } });
    }
    showToast("Moved to Scheduled Queue");
  } else {
    window.actSelected(act);
  }
};

window.pauseDl = (id) => sendWs({ action: "pause_download", payload: { download_id: id } });
window.resumeDl = (id) => sendWs({ action: "resume_download", payload: { download_id: id } });
window.retryDl = (id) => sendWs({ action: "retry_download", payload: { download_id: id } });
window.deleteDl = (id, delDisk = false) => sendWs({ action: "delete_download", payload: { download_id: id, delete_file: !!delDisk } });
window.openFolder = (id) => sendWs({ action: "open_folder", payload: { download_id: id } });

// Column Sorting, Interactive Drag-to-Resize Columns, Sidebar Splitter & Visibility
let lastColResizeEndTs = 0;

const DEFAULT_COL_WIDTHS = {
  chk: 30,
  fname: 225,
  q: 34,
  size: 84,
  status: 136,
  eta: 78,
  speed: 92,
  date: 98,
  desc: 120,
  act: 106,
};

const MIN_COL_WIDTHS = {
  chk: 28,
  fname: 110,
  q: 30,
  size: 60,
  status: 105,
  eta: 58,
  speed: 68,
  date: 72,
  desc: 75,
  act: 96,
};

let activeColWidthsState = { ...DEFAULT_COL_WIDTHS };
let hasCustomSavedCols = false;

function fitDefaultColumnsToViewport(colGroup, widthsObj) {
  const scrollWrap = document.getElementById("gridScroll");
  const availW = scrollWrap ? scrollWrap.clientWidth : 0;
  if (availW > 520) {
    const otherSum = Object.entries(widthsObj)
      .filter(([k]) => k !== "fname")
      .reduce((acc, [, v]) => acc + v, 0);
    widthsObj.fname = Math.max(150, availW - otherSum - 2);
  }
  for (const [k, px] of Object.entries(widthsObj)) {
    const colEl = colGroup.querySelector(`col[data-col-key="${k}"]`);
    if (colEl) colEl.style.width = `${px}px`;
  }
}

window.resetAllColumnWidths = function () {
  try { localStorage.removeItem("warpdm_col_widths_v36"); } catch (_) {}
  hasCustomSavedCols = false;
  activeColWidthsState = { ...DEFAULT_COL_WIDTHS };
  const colGroup = document.getElementById("transferColGroup");
  if (colGroup) fitDefaultColumnsToViewport(colGroup, activeColWidthsState);
  showToast("Column widths reset to default");
};

function initColumnAndSidebarResizers() {
  // 1. Sidebar Splitter (#sidebarResizer)
  const sidebar = document.getElementById("treeSidebar");
  const sbResizer = document.getElementById("sidebarResizer");
  const colGroup = document.getElementById("transferColGroup");
  const savedSbW = parseInt(localStorage.getItem("warpdm_sidebar_width") || "0", 10);
  if (sidebar && savedSbW >= 140 && savedSbW <= 440) {
    sidebar.style.width = `${savedSbW}px`;
  }

  if (sidebar && sbResizer) {
    sbResizer.addEventListener("dblclick", () => {
      sidebar.style.width = "214px";
      try { localStorage.removeItem("warpdm_sidebar_width"); } catch (_) {}
      if (!hasCustomSavedCols && colGroup) fitDefaultColumnsToViewport(colGroup, activeColWidthsState);
    });

    sbResizer.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      sbResizer.setPointerCapture(e.pointerId);
      sbResizer.classList.add("dragging");
      document.body.classList.add("col-resizing");
      const startX = e.clientX;
      const startW = sidebar.getBoundingClientRect().width;

      const onMove = (ev) => {
        const isRtl = document.documentElement.dir === "rtl";
        const delta = isRtl ? startX - ev.clientX : ev.clientX - startX;
        const nextW = Math.max(140, Math.min(440, Math.round(startW + delta)));
        sidebar.style.width = `${nextW}px`;
        if (!hasCustomSavedCols && colGroup) fitDefaultColumnsToViewport(colGroup, activeColWidthsState);
      };

      const onUp = (ev) => {
        sbResizer.classList.remove("dragging");
        document.body.classList.remove("col-resizing");
        try { sbResizer.releasePointerCapture(ev.pointerId); } catch (_) {}
        sbResizer.removeEventListener("pointermove", onMove);
        sbResizer.removeEventListener("pointerup", onUp);
        sbResizer.removeEventListener("pointercancel", onUp);
        localStorage.setItem("warpdm_sidebar_width", String(Math.round(sidebar.getBoundingClientRect().width)));
      };

      sbResizer.addEventListener("pointermove", onMove);
      sbResizer.addEventListener("pointerup", onUp);
      sbResizer.addEventListener("pointercancel", onUp);
    });
  }

  // 2. Table Column Resizers (.col-resizer -> <col data-col-key="...">)
  if (!colGroup) return;

  let savedCols = null;
  try {
    savedCols = JSON.parse(localStorage.getItem("warpdm_col_widths_v36") || "null");
  } catch (_) {}

  hasCustomSavedCols = Boolean(savedCols);
  activeColWidthsState = { ...DEFAULT_COL_WIDTHS, ...(savedCols || {}) };

  const applyColWidth = (key, px) => {
    const colEl = colGroup.querySelector(`col[data-col-key="${key}"]`);
    if (colEl) colEl.style.width = `${px}px`;
  };

  if (!hasCustomSavedCols) {
    fitDefaultColumnsToViewport(colGroup, activeColWidthsState);
  } else {
    for (const [k, px] of Object.entries(activeColWidthsState)) {
      applyColWidth(k, px);
    }
  }

  window.addEventListener("resize", () => {
    if (!hasCustomSavedCols) {
      fitDefaultColumnsToViewport(colGroup, activeColWidthsState);
    }
  });

  const persistCols = () => {
    hasCustomSavedCols = true;
    try {
      localStorage.setItem("warpdm_col_widths_v36", JSON.stringify(activeColWidthsState));
    } catch (_) {}
  };

  document.querySelectorAll(".col-resizer").forEach((handle) => {
    const colKey = handle.dataset.resizeCol;
    if (!colKey) return;

    handle.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    handle.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const defW = DEFAULT_COL_WIDTHS[colKey] || 110;
      activeColWidthsState[colKey] = defW;
      applyColWidth(colKey, defW);
      persistCols();
    });

    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("dragging");
      document.body.classList.add("col-resizing");

      const colEl = colGroup.querySelector(`col[data-col-key="${colKey}"]`);
      const startX = e.clientX;
      const startW = colEl ? parseFloat(colEl.style.width) || activeColWidthsState[colKey] || 110 : 110;
      const minW = MIN_COL_WIDTHS[colKey] || 55;

      const onMove = (ev) => {
        const isRtl = document.documentElement.dir === "rtl";
        const delta = isRtl ? startX - ev.clientX : ev.clientX - startX;
        const nextW = Math.max(minW, Math.round(startW + delta));
        activeColWidthsState[colKey] = nextW;
        applyColWidth(colKey, nextW);
      };

      const onUp = (ev) => {
        lastColResizeEndTs = Date.now();
        handle.classList.remove("dragging");
        document.body.classList.remove("col-resizing");
        try { handle.releasePointerCapture(ev.pointerId); } catch (_) {}
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        persistCols();
      };

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });
  });
}

document.querySelectorAll("th.sortable").forEach((th) => {
  th.addEventListener("click", (e) => {
    if (Date.now() - lastColResizeEndTs < 250 || e.target.closest(".col-resizer")) return;
    const f = th.dataset.sort;
    if (sortField === f) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortField = f; sortDir = f === "filename" ? "asc" : "desc"; }
    renderTable();
  });
});

initColumnAndSidebarResizers();

function updateSortIndicators() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    const ind = th.querySelector(".sort-ind");
    if (ind) ind.textContent = th.dataset.sort === sortField ? (sortDir === "asc" ? "▲" : "▼") : "";
  });
}

window.openColumnsModal = () => document.getElementById("columnsModal").classList.remove("hidden");

window.applyColumnVisibility = function () {
  document.querySelectorAll(".col-vis-chk").forEach((chk) => {
    const col = chk.value;
    document.querySelectorAll(`[data-col="${col}"]`).forEach((el) => {
      el.style.display = chk.checked ? "" : "none";
    });
  });
};

function updateTreeCounts() {
  const cnt = { all: 0, compressed: 0, documents: 0, music: 0, programs: 0, video: 0, unf: 0, fin: 0 };
  for (const [_, item] of downloads) {
    cnt.all++;
    const cat = getItemCategory(item);
    if (cnt[cat] !== undefined) cnt[cat]++;
    if (item.state === "completed") cnt.fin++;
    else cnt.unf++;
  }
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt("cnt-all-all", cnt.all);
  setTxt("cnt-all-compressed", cnt.compressed);
  setTxt("cnt-all-documents", cnt.documents);
  setTxt("cnt-all-music", cnt.music);
  setTxt("cnt-all-programs", cnt.programs);
  setTxt("cnt-all-video", cnt.video);
  setTxt("cnt-unf-all", cnt.unf);
  setTxt("cnt-fin-all", cnt.fin);
}

function updateGlobalTelemetry() {
  let totalBps = 0;
  let activeCount = 0;
  for (const [_, item] of downloads) {
    if (item.state === "downloading") {
      activeCount++;
      totalBps += item.bytesPerSec || 0;
    }
  }
  document.getElementById("globalSpeedPill").textContent =
    totalBps > 0 ? `${formatBytes(totalBps)}/s` : "0.00 MB/s";
  const actTxt = activeCount > 0 ? ` • ${activeCount} active` : "";
  const selTxt = selectedIds.size > 0 ? ` • ${selectedIds.size} selected` : "";
  document.getElementById("statusSummaryLeft").textContent = `${downloads.size} downloads${actTxt}${selTxt}`;
}

document.getElementById("searchInput").addEventListener("input", (e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  renderTable();
});

// Speed Limiter (Custom Exact KB/sec or MB/sec!)
function syncSpeedLimitPill(bps) {
  currentSpeedLimitBps = Number(bps) || 0;
  const pill = document.getElementById("speedCapPill");
  pill.textContent = currentSpeedLimitBps <= 0 ? "⚡ Limit: Off" : `⚡ Limit: ${formatBytes(currentSpeedLimitBps)}/s`;
}

window.openSpeedLimiterModal = function () {
  const kbps = currentSpeedLimitBps > 0
    ? Math.round(currentSpeedLimitBps / 1024)
    : appSettings.speed_limit_kbps || 512;
  if (kbps >= 1024 && kbps % 1024 === 0) {
    document.getElementById("modalSpeedValue").value = String(kbps / 1024);
    document.getElementById("modalSpeedUnit").value = "mbps";
  } else {
    document.getElementById("modalSpeedValue").value = String(kbps);
    document.getElementById("modalSpeedUnit").value = "kbps";
  }
  document.getElementById("chkModalSpeedStartup").checked = !!appSettings.speed_limit_startup;
  document.getElementById("speedLimiterModal").classList.remove("hidden");
  document.getElementById("modalSpeedValue").focus();
};

window.toggleQuickSpeedLimiter = function (turnOn) {
  if (!turnOn) {
    fetch("/api/speed-limit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bytes_per_sec: 0 }),
    });
    showToast("Speed Limiter turned OFF (Unlimited)");
  } else {
    const savedKbps = appSettings.speed_limit_kbps > 0 ? appSettings.speed_limit_kbps : 1024;
    fetch("/api/speed-limit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bytes_per_sec: savedKbps * 1024, save_kbps: savedKbps }),
    });
    showToast(`Speed Limiter ON (${formatBytes(savedKbps * 1024)}/s)`);
  }
};

document.getElementById("btnSaveSpeedModal").onclick = () => {
  const val = Math.max(1, parseFloat(document.getElementById("modalSpeedValue").value) || 512);
  const unit = document.getElementById("modalSpeedUnit").value;
  const bps = Math.round(unit === "mbps" ? val * 1048576 : val * 1024);
  const startup = document.getElementById("chkModalSpeedStartup").checked;
  appSettings.speed_limit_kbps = Math.round(bps / 1024);
  appSettings.speed_limit_startup = startup;

  fetch("/api/speed-limit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bytes_per_sec: bps, save_kbps: appSettings.speed_limit_kbps, startup_enabled: startup }),
  });
  closeModal("speedLimiterModal");
  showToast(`Speed limit set to ${formatBytes(bps)}/s`);
};

document.getElementById("btnTurnOffSpeedModal").onclick = () => {
  window.toggleQuickSpeedLimiter(false);
  closeModal("speedLimiterModal");
};

// Quick "Enter new address" + Full "Download File Info" Flow
const inputUrl = document.getElementById("inputUrl");
const inputFilename = document.getElementById("inputFilename");
const inputDestFolder = document.getElementById("inputDestFolder");
const probedMetaBadge = document.getElementById("probedMetaBadge");
const videoOptionsGroup = document.getElementById("videoOptionsGroup");
const inputVideoQuality = document.getElementById("inputVideoQuality");
const detectedVideoTitle = document.getElementById("detectedVideoTitle");

function resetDefaultVideoQualities() {
  inputVideoQuality.innerHTML = "";
  for (const q of DEFAULT_VIDEO_QUALITIES) {
    const opt = document.createElement("option");
    opt.value = q.id;
    opt.textContent = q.label;
    inputVideoQuality.appendChild(opt);
  }
}
resetDefaultVideoQualities();

function normalizeUserUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u) && /^[\w.-]+\.[a-z]{2,}\//i.test(u)) u = "https://" + u;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch (_) {
    return null;
  }
}

function saveRecentUrl(url) {
  try {
    const prev = JSON.parse(localStorage.getItem("warpdm_recent_urls") || "[]");
    const next = [url, ...prev.filter((x) => x !== url)].slice(0, 12);
    localStorage.setItem("warpdm_recent_urls", JSON.stringify(next));
  } catch (_) {}
}

function populateRecentUrlsDatalist() {
  try {
    const list = JSON.parse(localStorage.getItem("warpdm_recent_urls") || "[]");
    const dl = document.getElementById("recentUrlsList");
    dl.innerHTML = list.map((u) => `<option value="${escapeHtml(u)}"></option>`).join("");
  } catch (_) {}
}

window.openQuickUrlModal = async function () {
  populateRecentUrlsDatalist();
  const qInput = document.getElementById("quickUrlInput");
  document.getElementById("chkQuickAuth").checked = false;
  document.getElementById("quickAuthFields").classList.add("hidden");
  document.getElementById("quickUrlModal").classList.remove("hidden");
  qInput.focus();

  if (!qInput.value.trim() && navigator.clipboard?.readText) {
    try {
      const clip = (await navigator.clipboard.readText()).trim();
      if (clip.startsWith("http://") || clip.startsWith("https://")) {
        qInput.value = clip;
        qInput.select();
      }
    } catch (_) {}
  }
};

document.getElementById("chkQuickAuth").onchange = (e) => {
  document.getElementById("quickAuthFields").classList.toggle("hidden", !e.target.checked);
};

document.getElementById("btnQuickUrlOk").onclick = () => {
  const url = normalizeUserUrl(document.getElementById("quickUrlInput").value);
  if (!url) {
    showToast("Please enter a valid http:// or https:// address", "warn");
    return;
  }
  saveRecentUrl(url);
  if (document.getElementById("chkQuickAuth").checked) {
    pendingAuthCreds = {
      user: document.getElementById("quickAuthUser").value.trim(),
      pass: document.getElementById("quickAuthPass").value,
    };
  } else {
    pendingAuthCreds = { user: "", pass: "" };
  }
  document.getElementById("quickUrlInput").value = "";
  closeModal("quickUrlModal");
  window.openFullAddModal(url);
};

document.getElementById("quickUrlInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btnQuickUrlOk").click();
});

window.openFullAddModal = function (prefillUrl = "") {
  resetDefaultVideoQualities();
  probedMetaBadge.textContent = "";
  probedModalBytes = null;
  inputFilename.value = "";
  inputDestFolder.value = appSettings.default_download_dir || "";
  document.getElementById("inputConns").value = String(appSettings.max_connections || 8);
  inputUrl.value = prefillUrl;
  document.getElementById("newDownloadModal").classList.remove("hidden");

  if (prefillUrl) {
    inputUrl.dispatchEvent(new Event("input"));
    probedMetaBadge.textContent = "Probing...";
    sendWs({ action: "probe_info", payload: { url: prefillUrl } });
  } else {
    inputUrl.focus();
  }
};

inputUrl.addEventListener("input", () => {
  const val = inputUrl.value.trim();
  probedMetaBadge.textContent = "";
  resetDefaultVideoQualities();
  if (STREAMING_URL_REGEX.test(val)) {
    videoOptionsGroup.classList.remove("hidden");
    detectedVideoTitle.textContent = "Streaming Video Detected";
  } else {
    videoOptionsGroup.classList.add("hidden");
  }
});

document.getElementById("btnProbeUrl").onclick = () => {
  const url = normalizeUserUrl(inputUrl.value);
  if (!url) return showToast("Enter a valid URL", "warn");
  inputUrl.value = url;
  probedMetaBadge.textContent = "Probing...";
  sendWs({ action: "probe_info", payload: { url } });
};

function handleProbeInfoResult(msg) {
  if (msg.status !== "ok" || !msg.data) {
    probedMetaBadge.textContent = "Ready to download";
    return;
  }
  const d = msg.data;
  probedModalBytes = d.totalBytes || null;
  if (d.filename && !inputFilename.value.trim()) inputFilename.value = d.filename;
  if (d.folder && !inputDestFolder.value.trim()) inputDestFolder.value = d.folder;

  const szStr = d.totalBytes ? formatBytes(d.totalBytes) : d.isVideo ? "Stream" : "Unknown size";
  const rangeStr = d.isVideo || d.acceptsRanges ? "Resume: Yes" : "Single Stream";
  probedMetaBadge.textContent = `• ${szStr} (${rangeStr})`;

  if (d.isVideo) {
    videoOptionsGroup.classList.remove("hidden");
    detectedVideoTitle.textContent = d.title || d.filename || "Video Ready";
    if (Array.isArray(d.qualities) && d.qualities.length > 0) {
      inputVideoQuality.innerHTML = "";
      for (const q of d.qualities) {
        const opt = document.createElement("option");
        opt.value = q.id;
        opt.dataset.bytes = q.approxBytes || "";
        opt.textContent = q.approxBytes ? `${q.label} (~${formatBytes(q.approxBytes)})` : q.label;
        inputVideoQuality.appendChild(opt);
      }
    }
  }
}

inputVideoQuality.addEventListener("change", () => {
  const selOpt = inputVideoQuality.selectedOptions?.[0];
  if (selOpt?.dataset?.bytes) probedModalBytes = Number(selOpt.dataset.bytes) || null;
  if (inputFilename.value) {
    const q = inputVideoQuality.value;
    const ext = q === "audio-mp3" ? ".mp3" : q === "audio-m4a" ? ".m4a" : ".mp4";
    inputFilename.value = inputFilename.value.replace(/\.(mp4|mkv|webm|mp3|m4a)$/i, "") + ext;
  }
});

function handleMediaProbeResult(msg) {
  if (msg.status === "ok" && msg.data) handleProbeInfoResult(msg);
}

async function browseNativeFolder(initialDir) {
  try {
    const res = await fetch("/api/browse-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initialDir }),
    });
    const json = await res.json();
    return json.folder || null;
  } catch (_) {
    return null;
  }
}

document.getElementById("btnBrowseModalFolder").onclick = async () => {
  const chosen = await browseNativeFolder(inputDestFolder.value.trim() || appSettings.default_download_dir);
  if (chosen) inputDestFolder.value = chosen;
};

document.getElementById("btnCloseDownloadModal").onclick = () => closeModal("newDownloadModal");

function submitAddModal(startImmediately) {
  const url = normalizeUserUrl(inputUrl.value);
  if (!url) return showToast("Please enter a valid URL", "err");
  saveRecentUrl(url);

  const conns = parseInt(document.getElementById("inputConns").value, 10);
  const isVideo = !videoOptionsGroup.classList.contains("hidden") || STREAMING_URL_REGEX.test(url);
  const customName = inputFilename.value.trim() || null;
  const folder = inputDestFolder.value.trim() || null;

  if (startImmediately) {
    sendWs({
      action: "start_download",
      payload: {
        url,
        destination: folder,
        filename: customName,
        customFilenameApproved: !!customName,
        total_bytes: probedModalBytes || null,
        authUser: pendingAuthCreds.user || null,
        authPass: pendingAuthCreds.pass || null,
        max_connections: conns,
        quality: isVideo ? inputVideoQuality.value : null,
        forceVideo: isVideo,
      },
    });
  } else {
    sendWs({
      action: "download_later",
      payload: {
        url,
        folder,
        filename: customName,
        totalBytes: probedModalBytes || null,
        quality: isVideo ? inputVideoQuality.value : null,
        forceVideo: isVideo,
      },
    });
    showToast("Added to Unfinished queue (Download Later)");
  }

  pendingAuthCreds = { user: "", pass: "" };
  closeModal("newDownloadModal");
  inputUrl.value = "";
  inputFilename.value = "";
  videoOptionsGroup.classList.add("hidden");
}

document.getElementById("btnConfirmDownload").onclick = () => submitAddModal(true);
document.getElementById("btnDownloadLater").onclick = () => submitAddModal(false);

// Batch URLs & Import / Export List
window.openBatchUrlsModal = () => {
  document.getElementById("batchUrlsTextarea").value = "";
  document.getElementById("batchUrlsModal").classList.remove("hidden");
  document.getElementById("batchUrlsTextarea").focus();
};

document.getElementById("btnStartBatchUrls").onclick = () => {
  const lines = document.getElementById("batchUrlsTextarea").value
    .split(/\r?\n/)
    .map((l) => normalizeUserUrl(l))
    .filter(Boolean);
  if (lines.length === 0) return showToast("Paste at least one valid URL", "warn");
  sendWs({ action: "batch_download", payload: { urls: lines } });
  closeModal("batchUrlsModal");
  showToast(`Queued ${lines.length} batch downloads`);
};

window.exportUrlList = function () {
  const urls = [...downloads.values()].map((d) => d.url).filter(Boolean);
  if (urls.length === 0) return showToast("No URLs in list to export", "warn");
  const blob = new Blob([urls.join("\r\n") + "\r\n"], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `WarpDM_Downloads_${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
};

window.triggerImportUrlList = () => document.getElementById("importUrlFileInput").click();
document.getElementById("importUrlFileInput").onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const urls = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//i.test(l));
  e.target.value = "";
  if (urls.length === 0) return showToast("No http/https URLs found in file", "warn");
  sendWs({ action: "batch_download", payload: { urls } });
  showToast(`Imported ${urls.length} URLs`);
};

// Multi-Tab Configuration / Options Modal
document.querySelectorAll(".cfg-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".cfg-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".cfg-pane").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.cfgtab).classList.add("active");
  });
});

window.openOptionsModal = function (tabId = "general") {
  sendWs({ action: "get_settings" });
  document.getElementById("settingsModal").classList.remove("hidden");
  const map = { general: "cfgGeneral", filetypes: "cfgFileTypes", saveto: "cfgSaveTo", downloads: "cfgDownloads", connection: "cfgConnection", sounds: "cfgSounds" };
  const targetPane = map[tabId] || "cfgGeneral";
  document.querySelector(`.cfg-tab[data-cfgtab="${targetPane}"]`)?.click();
};

document.getElementById("btnCloseSettingsModal").onclick = () => closeModal("settingsModal");

let tempCatDirs = {};

function populateSettingsModal(caps) {
  const s = caps.settings || {};
  tempCatDirs = { ...(s.category_dirs || {}) };

  document.getElementById("settingLaunchStartup").checked = !!s.launch_on_startup;
  document.getElementById("settingClipboardMonitor").checked = !!s.clipboard_monitor;
  document.getElementById("settingAutoCapture").checked = s.auto_capture !== false;
  document.getElementById("extensionDirDisplay").value = caps.extensionDir || "";

  document.getElementById("settingFileTypes").value = s.captured_file_types || DEFAULT_FILE_TYPES;
  document.getElementById("settingExcludedDomains").value = s.excluded_domains || "";

  document.getElementById("settingDownloadDir").value = s.default_download_dir || "";
  document.getElementById("settingCategorySubfolders").checked = !!s.category_subfolders;
  const curCat = document.getElementById("cfgCatSelector").value;
  document.getElementById("cfgCatFolderInput").value = tempCatDirs[curCat] || "";
  document.getElementById("settingTempDir").value = s.temp_parts_dir || "";

  document.getElementById("settingAskConfirmation").checked = s.ask_confirmation !== false;
  document.getElementById("settingShowProgressPopup").checked = s.show_progress_popup !== false;
  document.getElementById("settingQuietMode").checked = s.quiet_mode !== false;
  document.getElementById("settingDuplicateAction").value = s.duplicate_action || "rename";
  document.getElementById("settingCustomUa").value = s.custom_user_agent || "";

  document.getElementById("settingMaxConns").value = String(s.max_connections || 8);
  document.getElementById("settingMaxConcurrent").value = String(s.max_concurrent_downloads || 4);
  document.getElementById("settingProxyHost").value = s.proxy_host || "";
  document.getElementById("settingProxyPort").value = s.proxy_port || "";

  document.getElementById("settingSoundComplete").checked = !!s.sound_complete;
  document.getElementById("settingSoundFailed").checked = !!s.sound_failed;
  document.getElementById("settingSoundQueue").checked = !!s.sound_queue_done;

  document.getElementById("mediaToolsBadgeArea").innerHTML = `
    <span>Video Engine: <strong style="color:${caps.ytDlpAvailable ? "#34d399" : "#f87171"}">${caps.ytDlpAvailable ? "Ready" : "Missing"}</strong></span>
    <span>FFmpeg: <strong style="color:${caps.ffmpegAvailable ? "#34d399" : "#f87171"}">${caps.ffmpegAvailable ? "Ready" : "Missing"}</strong></span>
  `;
}

document.getElementById("cfgCatSelector").onchange = (e) => {
  document.getElementById("cfgCatFolderInput").value = tempCatDirs[e.target.value] || "";
};
document.getElementById("cfgCatFolderInput").oninput = (e) => {
  tempCatDirs[document.getElementById("cfgCatSelector").value] = e.target.value.trim();
};

document.getElementById("btnResetFileTypes").onclick = () => {
  document.getElementById("settingFileTypes").value = DEFAULT_FILE_TYPES;
};

document.getElementById("btnBrowseSettingDir").onclick = async () => {
  const c = await browseNativeFolder(document.getElementById("settingDownloadDir").value.trim());
  if (c) document.getElementById("settingDownloadDir").value = c;
};
document.getElementById("btnBrowseCatFolder").onclick = async () => {
  const c = await browseNativeFolder(document.getElementById("cfgCatFolderInput").value.trim() || appSettings.default_download_dir);
  if (c) {
    document.getElementById("cfgCatFolderInput").value = c;
    tempCatDirs[document.getElementById("cfgCatSelector").value] = c;
  }
};
document.getElementById("btnBrowseTempDir").onclick = async () => {
  const c = await browseNativeFolder(document.getElementById("settingTempDir").value.trim());
  if (c) document.getElementById("settingTempDir").value = c;
};

document.getElementById("btnOpenExtFolder").onclick = () => sendWs({ action: "open_extension_folder" });

document.getElementById("btnSaveSettings").onclick = () => {
  const launchStartup = document.getElementById("settingLaunchStartup").checked;
  fetch("/api/autostart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enable: launchStartup }),
  });

  sendWs({
    action: "update_settings",
    payload: {
      default_download_dir: document.getElementById("settingDownloadDir").value.trim(),
      category_dirs: tempCatDirs,
      temp_parts_dir: document.getElementById("settingTempDir").value.trim(),
      max_connections: parseInt(document.getElementById("settingMaxConns").value, 10),
      max_concurrent_downloads: parseInt(document.getElementById("settingMaxConcurrent").value, 10),
      auto_capture: document.getElementById("settingAutoCapture").checked,
      clipboard_monitor: document.getElementById("settingClipboardMonitor").checked,
      ask_confirmation: document.getElementById("settingAskConfirmation").checked,
      show_progress_popup: document.getElementById("settingShowProgressPopup").checked,
      category_subfolders: document.getElementById("settingCategorySubfolders").checked,
      quiet_mode: document.getElementById("settingQuietMode").checked,
      duplicate_action: document.getElementById("settingDuplicateAction").value,
      custom_user_agent: document.getElementById("settingCustomUa").value.trim(),
      captured_file_types: document.getElementById("settingFileTypes").value.trim(),
      excluded_domains: document.getElementById("settingExcludedDomains").value.trim(),
      proxy_host: document.getElementById("settingProxyHost").value.trim(),
      proxy_port: document.getElementById("settingProxyPort").value.trim(),
      sound_complete: document.getElementById("settingSoundComplete").checked,
      sound_failed: document.getElementById("settingSoundFailed").checked,
      sound_queue_done: document.getElementById("settingSoundQueue").checked,
    },
  });
  closeModal("settingsModal");
};

// Scheduler Modal
window.openSchedulerModal = function () {
  document.getElementById("schedEnableStart").checked = !!appSettings.scheduler_enabled;
  document.getElementById("schedStartTime").value = appSettings.scheduler_start_time || "02:00";
  document.getElementById("schedEnableStop").checked = !!appSettings.scheduler_stop_enabled;
  document.getElementById("schedStopTime").value = appSettings.scheduler_stop_time || "07:00";
  document.getElementById("schedMaxConc").value = String(appSettings.scheduler_max_concurrent || 2);
  document.getElementById("schedulerModal").classList.remove("hidden");
};

document.getElementById("btnSaveScheduler").onclick = () => {
  sendWs({
    action: "update_settings",
    payload: {
      scheduler_enabled: document.getElementById("schedEnableStart").checked,
      scheduler_start_time: document.getElementById("schedStartTime").value,
      scheduler_stop_enabled: document.getElementById("schedEnableStop").checked,
      scheduler_stop_time: document.getElementById("schedStopTime").value,
      scheduler_max_concurrent: parseInt(document.getElementById("schedMaxConc").value, 10),
    },
  });
  closeModal("schedulerModal");
  showToast("Queue schedule saved");
};

// Adaptive HUD Modal
window.openHud = function (downloadId) {
  currentHudDownloadId = downloadId;
  const item = downloads.get(downloadId);
  if (!item) return;
  document.getElementById("hudFilename").textContent = item.filename;
  renderHud(item);
  document.getElementById("hudModal").classList.remove("hidden");
};

function closeHud() {
  closeModal("hudModal");
}
document.getElementById("btnCloseHud").onclick = closeHud;

function renderHud(item) {
  const errBox = document.getElementById("hudErrorBox");
  if (item.state === "failed" && item.errorMessage) {
    errBox.textContent = `Error: ${item.errorMessage}`;
    errBox.classList.remove("hidden");
  } else {
    errBox.classList.add("hidden");
  }

  document.getElementById("hudUrlText").textContent = item.url || "";
  document.getElementById("btnCopyHudUrl").onclick = () => {
    navigator.clipboard?.writeText(item.url || "");
    showToast("Copied URL to clipboard");
  };
  document.getElementById("btnPopOutHud").onclick = () => {
    fetch("/api/open-progress-window", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ download_id: item.downloadId }),
    });
    closeHud();
  };

  const pctStr = computeProgressPct(item);
  const hudPctEl = document.getElementById("hudPercentValue");
  const hudFillEl = document.getElementById("hudProgressFill");
  const hudStatusEl = document.getElementById("hudStatusLabel");
  hudPctEl.textContent = `${pctStr}%`;
  hudPctEl.className = item.state === "completed" ? "hud-percent-value done" : "hud-percent-value";
  hudFillEl.style.width = `${pctStr}%`;
  hudFillEl.className =
    "hud-progress-fill" +
    (item.state === "completed" ? " completed" : item.state === "paused" ? " paused" : item.state === "failed" ? " failed" : "");

  hudStatusEl.textContent =
    item.state === "completed"
      ? "✔ Completed (100%)"
      : item.statusText || (item.state === "downloading" ? `Receiving data... (${pctStr}%)` : item.state);

  const isVideo = Boolean(item.mediaFormat) || STREAMING_URL_REGEX.test(item.url || "");
  document.getElementById("hudSectionTitle").textContent = isVideo ? "Stream Progress" : "Segments";
  document.getElementById("hudConnsLabel").textContent = "Connections";

  const total = item.totalBytes ? formatBytes(item.totalBytes) : "Unknown";
  document.getElementById("hudDownloaded").textContent = `${formatBytes(item.downloadedBytes)} / ${total}`;
  document.getElementById("hudSpeed").textContent =
    item.bytesPerSec && item.bytesPerSec > 0 ? `${formatBytes(item.bytesPerSec)}/s` : "0 MB/s";
  document.getElementById("hudConns").textContent = String(item.activeConnections || 0);
  document.getElementById("hudEta").textContent = formatEta(item.etaSeconds, item.state);

  const container = document.getElementById("chunkMapContainer");
  container.innerHTML = "";
  if (item.chunks && item.chunks.length > 0) {
    const totalSize = item.totalBytes || 1;
    for (const chunk of item.chunks) {
      const block = document.createElement("div");
      block.className = `chunk-block ${chunk.status}`;
      const chunkSize = Math.max(1, chunk.endByte - chunk.startByte + 1);
      block.style.flex = `${Math.max(1, Math.round((chunkSize / totalSize) * 100))}`;
      const fillPct = Math.min(100, (Math.max(0, chunk.currentByte - chunk.startByte) / chunkSize) * 100);
      block.innerHTML = `<div class="chunk-fill" style="height:${fillPct}%"></div>`;
      container.appendChild(block);
    }
  } else {
    container.innerHTML = `<div style="padding:12px;color:#94a3b8;font-size:12px;">${escapeHtml(hudStatusEl.textContent)}</div>`;
  }

  const footerActs = document.getElementById("hudFooterActions");
  if (item.state === "completed") {
    footerActs.innerHTML = `<button class="btn btn-primary btn-icon-sm" onclick="openFolder('${item.downloadId}')">📂 Show in Folder</button>`;
  } else if (item.state === "failed") {
    footerActs.innerHTML = `<button class="btn btn-primary btn-icon-sm" onclick="retryDl('${item.downloadId}')">↻ Retry / Resume</button>`;
  } else if (item.state === "paused") {
    footerActs.innerHTML = `<button class="btn btn-primary btn-icon-sm" onclick="resumeDl('${item.downloadId}')">▶ Resume</button>`;
  } else {
    footerActs.innerHTML = `<button class="btn btn-secondary btn-icon-sm" onclick="pauseDl('${item.downloadId}')">⏸ Pause</button>`;
  }
}

// Remote ZIP & Site Grabber & About
window.openZipModal = () => {
  document.getElementById("zipPreviewModal").classList.remove("hidden");
  document.getElementById("zipUrlInput").focus();
};
document.getElementById("btnCloseZipModal").onclick = () => closeModal("zipPreviewModal");
document.getElementById("btnInspectZip").onclick = () => {
  const url = normalizeUserUrl(document.getElementById("zipUrlInput").value);
  if (!url) return showToast("Enter a valid .zip URL", "warn");
  document.getElementById("zipResultArea").innerHTML = `<div class="placeholder-text">Reading remote Central Directory...</div>`;
  sendWs({ action: "preview_zip", payload: { url } });
};

function handleZipPreviewResult(msg) {
  const area = document.getElementById("zipResultArea");
  if (msg.status !== "ok" || !Array.isArray(msg.data)) {
    area.innerHTML = `<div class="placeholder-text" style="color:#f87171;">Failed: ${escapeHtml(msg.message || "Error")}</div>`;
    return;
  }
  const rows = msg.data
    .map((e) => `<tr><td>${e.isDirectory ? "📁" : "📄"} ${escapeHtml(e.filename)}</td><td>${formatBytes(e.uncompressedSize)}</td><td>${formatBytes(e.compressedSize)}</td><td style="font-family:monospace;">${escapeHtml(e.crc32)}</td></tr>`)
    .join("");
  area.innerHTML = `<table class="mini-table"><thead><tr><th>Path (${msg.data.length})</th><th>Size</th><th>Packed</th><th>CRC32</th></tr></thead><tbody>${rows}</tbody></table>`;
}

window.openGrabberModal = () => {
  document.getElementById("grabberModal").classList.remove("hidden");
  document.getElementById("grabberUrlInput").focus();
};
document.getElementById("btnCloseGrabberModal").onclick = () => closeModal("grabberModal");
document.getElementById("btnRunGrabber").onclick = () => {
  const url = normalizeUserUrl(document.getElementById("grabberUrlInput").value);
  if (!url) return showToast("Enter a valid webpage URL", "warn");
  document.getElementById("grabberResultArea").innerHTML = `<div class="placeholder-text">Scanning webpage for downloadable files...</div>`;
  document.getElementById("grabberFooter").classList.add("hidden");
  sendWs({ action: "crawl_site", payload: { url, max_depth: 1 } });
};

function handleCrawlResult(msg) {
  const area = document.getElementById("grabberResultArea");
  const footer = document.getElementById("grabberFooter");
  if (msg.status !== "ok" || !Array.isArray(msg.data)) {
    area.innerHTML = `<div class="placeholder-text" style="color:#f87171;">Scan failed: ${escapeHtml(msg.message || "Error")}</div>`;
    return;
  }
  const uniqueMap = new Map();
  for (const item of msg.data) if (!uniqueMap.has(item.url)) uniqueMap.set(item.url, item);
  const list = [...uniqueMap.values()].sort((a, b) => Number(b.isFile) - Number(a.isFile));
  if (list.length === 0) {
    area.innerHTML = `<div class="placeholder-text">No downloadable links discovered.</div>`;
    return;
  }
  const rows = list
    .map((item) => `<tr><td width="30"><input type="checkbox" class="grab-chk" data-url="${escapeHtml(item.url)}" ${item.isFile ? "checked" : ""}></td><td><span class="meta-chip">${item.isFile ? "FILE" : "LINK"}</span></td><td style="word-break:break-all;">${escapeHtml(item.url)}</td></tr>`)
    .join("");
  area.innerHTML = `<table class="mini-table"><thead><tr><th><input type="checkbox" id="grabSelectAll"></th><th>Type</th><th>URL (${list.length})</th></tr></thead><tbody>${rows}</tbody></table>`;
  footer.classList.remove("hidden");

  const updateCount = () => {
    document.getElementById("grabberCountLabel").textContent = `${area.querySelectorAll(".grab-chk:checked").length} file(s) selected`;
  };
  updateCount();
  area.querySelectorAll(".grab-chk").forEach((c) => c.addEventListener("change", updateCount));
  document.getElementById("grabSelectAll").onchange = (e) => {
    area.querySelectorAll(".grab-chk").forEach((c) => (c.checked = e.target.checked));
    updateCount();
  };
}

document.getElementById("btnDownloadGrabbed").onclick = () => {
  const checked = Array.from(document.querySelectorAll(".grab-chk:checked")).map((c) => c.dataset.url);
  if (checked.length === 0) return;
  sendWs({ action: "batch_download", payload: { urls: checked, referer: document.getElementById("grabberUrlInput").value.trim() } });
  closeModal("grabberModal");
};

window.openAboutModal = () => document.getElementById("aboutModal").classList.remove("hidden");

// Beginner-Proof Browser Extension Wizard Controller
let cachedBrowserMeta = null;

function updateExtensionChip(connected) {
  const chip = document.getElementById("extConnectChip");
  if (!chip) return;
  if (connected) {
    chip.textContent = "🧩 Extension Active";
    chip.style.color = "#34d399";
    chip.style.borderColor = "rgba(16, 185, 129, 0.45)";
  } else {
    chip.textContent = "🧩 Connect Browser";
    chip.style.color = "";
    chip.style.borderColor = "";
  }
}

window.openBrowserWizardModal = async function () {
  document.getElementById("browserWizardModal").classList.remove("hidden");
  try {
    const res = await fetch("/api/browsers");
    const json = await res.json();
    cachedBrowserMeta = json;
    updateExtensionChip(json.extensionConnected);

    const isFf = document.getElementById("wizBrowserUrlSelect").value.startsWith("about:");
    document.getElementById("wizExtFolderInput").value = isFf
      ? (json.firefoxXpiPath || json.firefoxManifestPath || json.extensionDir)
      : json.extensionDir;
  } catch (_) {}
};

document.getElementById("wizBrowserUrlSelect")?.addEventListener("change", (e) => {
  const url = e.target.value;
  document.getElementById("wizExtUrlInput").value = url;
  if (cachedBrowserMeta) {
    document.getElementById("wizExtFolderInput").value = url.startsWith("about:")
      ? (cachedBrowserMeta.firefoxXpiPath || cachedBrowserMeta.firefoxManifestPath || cachedBrowserMeta.extensionDir)
      : cachedBrowserMeta.extensionDir;
  }
});

document.getElementById("btnWizCopyUrl")?.addEventListener("click", () => {
  const val = document.getElementById("wizExtUrlInput").value;
  navigator.clipboard?.writeText(val);
  showToast(`Copied ${val}`);
});

document.getElementById("btnWizCopyPath")?.addEventListener("click", () => {
  const val = document.getElementById("wizExtFolderInput").value;
  navigator.clipboard?.writeText(val);
  showToast("Extension path copied! Paste (Ctrl+V) in Load Unpacked.");
});

document.getElementById("btnWizHighlightFolder")?.addEventListener("click", () => {
  fetch("/api/open-extension-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ highlightParent: true }),
  });
});

// Check initial extension connection status
fetch("/api/status")
  .then((r) => r.json())
  .then((j) => {
    if (j.extensionConnected || document.documentElement.getAttribute("data-warpdm-ext")) {
      updateExtensionChip(true);
    }
  })
  .catch(() => {});
window.addEventListener("warpdm-extension-ready", () => updateExtensionChip(true));

// Optional Clipboard URL Monitor (when enabled in Options -> General)
setInterval(async () => {
  if (!appSettings.clipboard_monitor || !document.hasFocus() || !navigator.clipboard?.readText) return;
  try {
    const clip = (await navigator.clipboard.readText()).trim();
    if (clip && clip !== lastClipboardUrl && /^https?:\/\/.+\.(zip|rar|7z|exe|msi|iso|mp4|mkv|mp3|pdf|apk|bin)(\?.*)?$/i.test(clip)) {
      lastClipboardUrl = clip;
      window.openFullAddModal(clip);
    }
  } catch (_) {}
}, 2500);

// Global Keyboard Shortcuts
document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".modal-overlay:not(.hidden)").forEach((m) => closeModal(m.id));
    document.getElementById("rowContextMenu").classList.add("hidden");
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
    e.preventDefault();
    window.openQuickUrlModal();
  } else if (e.key === "Delete" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
    window.actSelected(e.shiftKey ? "delete_disk" : "remove");
  }
});

function openRequestedModal(modal) {
  if (modal === "add") window.openQuickUrlModal();
  else if (modal === "grabber") window.openGrabberModal();
  else if (modal === "zip") window.openZipModal();
}

function checkInitialUrlModal() {
  const params = new URLSearchParams(window.location.search);
  const openParam = params.get("open");
  if (openParam) {
    openRequestedModal(openParam);
    window.history.replaceState({}, "", "/");
  }
}

function showToast(text, level = "info") {
  const container = document.getElementById("toastContainer");
  const el = document.createElement("div");
  el.className = `toast${level === "warn" ? " toast-warn" : level === "err" ? " toast-err" : ""}`;
  el.textContent = text;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function formatEta(sec, state) {
  if (state === "merging") return "FFmpeg...";
  if (state === "queued") return "Queued";
  if (!sec || sec <= 0 || state !== "downloading") return "";
  if (sec < 60) return `${sec} sec`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/[&<>'"]/g, (tag) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[tag] || tag));
}

window.onload = initWebSocket;

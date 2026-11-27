using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace WarpDMLauncher
{
    static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        private const uint WM_CLOSE = 0x0010;
        private const string WindowTitle = "WarpDM";
        private static Mutex singleInstanceMutex;
        private static Process engineProcess;
        private static NotifyIcon trayIcon;
        private static MenuItem[] speedItems;
        private const int Port = 20888;
        private const string BaseUrl = "http://127.0.0.1:20888";

        [STAThread]
        static void Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string initialModal = args.Length > 0 ? args[0] : null;

            bool createdNew;
            singleInstanceMutex = new Mutex(true, "WarpDM_SingleInstance_Mutex", out createdNew);

            if (!createdNew)
            {
                if (!IsPortListening(Port))
                {
                    StartEngine();
                }
                LaunchAppWindow(initialModal);
                return;
            }

            StartEngine();
            SetupTray();
            LaunchAppWindow(initialModal);

            Application.Run();
        }

        private static void StartEngine()
        {
            if (IsPortListening(Port))
            {
                return;
            }

            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string nodePath = Path.Combine(baseDir, "runtime", "node.exe");
                if (!File.Exists(nodePath)) nodePath = "node";

                string scriptPath = Path.Combine(baseDir, "src", "server.mjs");
                if (!File.Exists(scriptPath)) scriptPath = Path.Combine(baseDir, "server.mjs");

                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = nodePath,
                    Arguments = string.Format("\"{0}\"", scriptPath),
                    WorkingDirectory = baseDir,
                    CreateNoWindow = true,
                    UseShellExecute = false
                };
                psi.EnvironmentVariables["PYTHONUTF8"] = "1";
                psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
                psi.EnvironmentVariables["PYTHONUNBUFFERED"] = "1";

                engineProcess = Process.Start(psi);

                for (int i = 0; i < 35; i++)
                {
                    if (IsPortListening(Port)) break;
                    Thread.Sleep(100);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to launch WarpDM Engine: " + ex.Message, "WarpDM Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static bool IsPortListening(int port)
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    client.Connect("127.0.0.1", port);
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void SetupTray()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string iconPath = Path.Combine(baseDir, "assets", "app.ico");

            Icon appIcon = null;
            try
            {
                string exePath = Process.GetCurrentProcess().MainModule.FileName;
                appIcon = Icon.ExtractAssociatedIcon(exePath);
            }
            catch { }

            if (appIcon == null && File.Exists(iconPath))
            {
                try { appIcon = new Icon(iconPath, 32, 32); } catch { }
            }
            if (appIcon == null) appIcon = SystemIcons.Application;

            ContextMenu menu = new ContextMenu();
            MenuItem openItem = new MenuItem("Open WarpDM", (s, e) => LaunchAppWindow(null));
            openItem.DefaultItem = true;
            menu.MenuItems.Add(openItem);

            menu.MenuItems.Add("-");
            menu.MenuItems.Add(new MenuItem("Add Download URL...", (s, e) => LaunchAppWindow("add")));
            menu.MenuItems.Add(new MenuItem("Site Grabber...", (s, e) => LaunchAppWindow("grabber")));
            menu.MenuItems.Add(new MenuItem("Remote ZIP Inspector...", (s, e) => LaunchAppWindow("zip")));
            menu.MenuItems.Add(new MenuItem("Open Downloads Folder", (s, e) => PostApiJson("/api/open-folder", "{}")));

            menu.MenuItems.Add("-");
            MenuItem speedMenu = new MenuItem("Speed Limiter");
            speedItems = new MenuItem[]
            {
                new MenuItem("Unlimited (Maximum)"),
                new MenuItem("25 MB/s"),
                new MenuItem("10 MB/s"),
                new MenuItem("5 MB/s"),
                new MenuItem("1 MB/s")
            };
            long[] speedValues = new long[] { 0, 25 * 1048576L, 10 * 1048576L, 5 * 1048576L, 1048576L };

            for (int i = 0; i < speedItems.Length; i++)
            {
                int idx = i;
                speedItems[idx].RadioCheck = true;
                if (idx == 0) speedItems[idx].Checked = true;
                speedItems[idx].Click += (s, e) =>
                {
                    for (int j = 0; j < speedItems.Length; j++) speedItems[j].Checked = (j == idx);
                    PostApiJson("/api/speed-limit", "{\"bytes_per_sec\":" + speedValues[idx] + "}");
                };
                speedMenu.MenuItems.Add(speedItems[idx]);
            }
            menu.MenuItems.Add(speedMenu);

            menu.MenuItems.Add("-");
            menu.MenuItems.Add(new MenuItem("Exit WarpDM", (s, e) => ExitApp()));

            trayIcon = new NotifyIcon
            {
                Icon = appIcon,
                ContextMenu = menu,
                Text = "WarpDM v3.5.0",
                Visible = true
            };

            trayIcon.DoubleClick += (s, e) => LaunchAppWindow(null);
        }

        private static void PostApiJson(string path, string json)
        {
            ThreadPool.QueueUserWorkItem((_) =>
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(BaseUrl + path);
                    req.Method = "POST";
                    req.ContentType = "application/json";
                    req.Timeout = 2000;
                    byte[] body = Encoding.UTF8.GetBytes(json);
                    req.ContentLength = body.Length;
                    using (Stream s = req.GetRequestStream())
                    {
                        s.Write(body, 0, body.Length);
                    }
                    using (WebResponse resp = req.GetResponse()) { }
                }
                catch { }
            });
        }

        private static string PostApiSync(string path, string json, int timeoutMs = 900)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(BaseUrl + path);
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Timeout = timeoutMs;
                byte[] body = Encoding.UTF8.GetBytes(json);
                req.ContentLength = body.Length;
                using (Stream s = req.GetRequestStream())
                {
                    s.Write(body, 0, body.Length);
                }
                using (WebResponse resp = req.GetResponse())
                using (StreamReader sr = new StreamReader(resp.GetResponseStream()))
                {
                    return sr.ReadToEnd();
                }
            }
            catch
            {
                return null;
            }
        }

        private static void FocusExistingWindow()
        {
            try
            {
                IntPtr hWnd = FindWindow(null, WindowTitle);
                if (hWnd != IntPtr.Zero)
                {
                    if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
                    else ShowWindow(hWnd, 5);
                    SetForegroundWindow(hWnd);
                }
            }
            catch { }
        }

        private static void LaunchAppWindow(string modal = null)
        {
            string cmdJson = string.IsNullOrEmpty(modal) ? "{\"modal\":\"focus\"}" : "{\"modal\":\"" + modal + "\"}";
            string resp = PostApiSync("/api/ui-command", cmdJson, 800);
            if (resp != null && resp.Contains("\"delivered\":true"))
            {
                FocusExistingWindow();
                return;
            }

            string targetUrl = string.IsNullOrEmpty(modal)
                ? BaseUrl + "/"
                : BaseUrl + "/?open=" + Uri.EscapeDataString(modal);

            string chromePath = @"C:\Program Files\Google\Chrome\Application\chrome.exe";
            string bravePath = @"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe";
            string edgePath = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
            string edgePath64 = @"C:\Program Files\Microsoft\Edge\Application\msedge.exe";

            string browserExe = null;
            if (File.Exists(chromePath)) browserExe = chromePath;
            else if (File.Exists(bravePath)) browserExe = bravePath;
            else if (File.Exists(edgePath64)) browserExe = edgePath64;
            else if (File.Exists(edgePath)) browserExe = edgePath;

            try
            {
                if (browserExe != null)
                {
                    string profileDir = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "WarpDM",
                        "UiProfile"
                    );
                    Directory.CreateDirectory(profileDir);

                    string args = string.Format(
                        "--app=\"{0}\" --user-data-dir=\"{1}\" --window-size=1280,820 --no-first-run --no-default-browser-check",
                        targetUrl,
                        profileDir
                    );
                    Process.Start(browserExe, args);
                }
                else
                {
                    Process.Start(targetUrl);
                }
            }
            catch
            {
                try { Process.Start(targetUrl); } catch { }
            }
        }

        private static void ExitApp()
        {
            if (trayIcon != null)
            {
                trayIcon.Visible = false;
                trayIcon.Dispose();
            }

            PostApiSync("/api/shutdown", "{}", 700);

            try
            {
                IntPtr hWnd = FindWindow(null, WindowTitle);
                if (hWnd != IntPtr.Zero) PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                for (int i = 0; i < 30; i++)
                {
                    IntPtr hDlg = FindWindow(null, "Download File Info \u2014 WarpDM");
                    if (hDlg == IntPtr.Zero) break;
                    PostMessage(hDlg, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                    Thread.Sleep(15);
                }
            }
            catch { }

            if (engineProcess != null && !engineProcess.HasExited)
            {
                try
                {
                    ProcessStartInfo tk = new ProcessStartInfo
                    {
                        FileName = "taskkill.exe",
                        Arguments = "/PID " + engineProcess.Id + " /T /F",
                        CreateNoWindow = true,
                        UseShellExecute = false
                    };
                    Process p = Process.Start(tk);
                    if (p != null) p.WaitForExit(1000);
                }
                catch
                {
                    try { engineProcess.Kill(); } catch { }
                }
            }

            if (singleInstanceMutex != null)
            {
                try { singleInstanceMutex.ReleaseMutex(); } catch { }
                try { singleInstanceMutex.Dispose(); } catch { }
            }

            Application.Exit();
        }
    }
}

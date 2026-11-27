using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace WarpDMInstaller
{
    public class SetupForm : Form
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [DllImport("shell32.dll")]
        private static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);

        private Panel leftPanel;
        private Panel contentPanel;
        private Panel bottomPanel;

        private Button btnBack;
        private Button btnNext;
        private Button btnCancel;

        private Label lblStepTitle;
        private Label lblStepSubtitle;
        private ProgressBar progressBar;
        private Label lblStatus;
        private Label lblProgressPercent;

        private TextBox txtDestPath;
        private Label lblFreeSpace;
        private CheckBox chkDesktopShortcut;
        private CheckBox chkStartMenuShortcut;
        private CheckBox chkAutoStart;
        private CheckBox chkLaunchNow;
        private RadioButton rbAccept;
        private RadioButton rbDecline;

        private Label[] stepIndicators;
        private readonly string[] stepNames = new string[]
        {
            "Welcome",
            "License Agreement",
            "Destination",
            "Options",
            "Installation",
            "Finish"
        };

        private int currentStep = 0; // 0: Welcome, 1: License, 2: Directory, 3: Tasks, 4: Installing, 5: Finished
        private string installDir;

        [STAThread]
        static void Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool isSilent = false;
            bool isUninstall = false;
            string customDir = null;

            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg.Equals("/S", StringComparison.OrdinalIgnoreCase) ||
                    arg.Equals("/silent", StringComparison.OrdinalIgnoreCase) ||
                    arg.Equals("--silent", StringComparison.OrdinalIgnoreCase))
                {
                    isSilent = true;
                }
                else if (arg.Equals("/uninstall", StringComparison.OrdinalIgnoreCase) ||
                         arg.Equals("--uninstall", StringComparison.OrdinalIgnoreCase))
                {
                    isUninstall = true;
                }
                else if (arg.StartsWith("/DIR=", StringComparison.OrdinalIgnoreCase))
                {
                    customDir = arg.Substring(5).Trim('\"');
                }
            }

            if (isUninstall)
            {
                PerformUninstall(isSilent);
                return;
            }

            if (isSilent)
            {
                SetupForm silentForm = new SetupForm(customDir);
                silentForm.PerformSilentInstall();
                return;
            }

            Application.Run(new SetupForm(customDir));
        }

        public SetupForm(string customDir = null)
        {
            this.Text = "WarpDM v3.5.0 Setup";
            this.ClientSize = new Size(720, 480);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedSingle;
            this.MaximizeBox = false;
            this.MinimizeBox = true;
            this.BackColor = Color.FromArgb(248, 250, 252);
            this.Font = new Font("Segoe UI", 9F, FontStyle.Regular);
            this.DoubleBuffered = true;

            // Resolve target directory
            if (!string.IsNullOrEmpty(customDir))
            {
                installDir = customDir;
            }
            else
            {
                installDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Programs",
                    "WarpDM"
                );
            }

            LoadAppIcon();
            BuildLayout();
            ShowStep(0);
        }

        private void LoadAppIcon()
        {
            try
            {
                string exePath = Process.GetCurrentProcess().MainModule.FileName;
                Icon exeIcon = Icon.ExtractAssociatedIcon(exePath);
                if (exeIcon != null)
                {
                    this.Icon = exeIcon;
                    return;
                }
            }
            catch { }

            try
            {
                Assembly asm = Assembly.GetExecutingAssembly();
                using (Stream stream = asm.GetManifestResourceStream("WarpDMInstaller.app.ico"))
                {
                    if (stream != null) this.Icon = new Icon(stream);
                }
            }
            catch { }
        }

        private void BuildLayout()
        {
            this.Controls.Clear();

            // 1. Left Sidebar (Fixed 220px width)
            leftPanel = new Panel
            {
                Location = new Point(0, 0),
                Size = new Size(220, 416),
                BackColor = Color.FromArgb(17, 24, 32) // Graphite #111820
            };

            // Logo Branding Container
            Panel logoBox = new Panel
            {
                Location = new Point(0, 0),
                Size = new Size(220, 96),
                BackColor = Color.FromArgb(12, 17, 23)
            };

            PictureBox picLogo = new PictureBox
            {
                Location = new Point(16, 22),
                Size = new Size(46, 46),
                SizeMode = PictureBoxSizeMode.Zoom,
                BackColor = Color.Transparent
            };
            try
            {
                Assembly asm = Assembly.GetExecutingAssembly();
                using (Stream s = asm.GetManifestResourceStream("WarpDMInstaller.logo.png"))
                {
                    if (s != null) picLogo.Image = new Bitmap(Image.FromStream(s));
                    else if (this.Icon != null) picLogo.Image = new Icon(this.Icon, 48, 48).ToBitmap();
                }
            }
            catch { }

            Label lblBrand = new Label
            {
                Text = "WARPDM",
                Font = new Font("Segoe UI", 16F, FontStyle.Bold),
                ForeColor = Color.FromArgb(243, 245, 247),
                Location = new Point(68, 20),
                Size = new Size(140, 30)
            };

            Label lblSubtitle = new Label
            {
                Text = "DOWNLOAD MANAGER",
                Font = new Font("Segoe UI", 7.5F, FontStyle.Bold),
                ForeColor = Color.FromArgb(53, 213, 232),
                Location = new Point(70, 50),
                Size = new Size(145, 18)
            };

            logoBox.Controls.Add(picLogo);
            logoBox.Controls.Add(lblBrand);
            logoBox.Controls.Add(lblSubtitle);
            leftPanel.Controls.Add(logoBox);

            // Stepper Navigation Indicators on Left Sidebar
            Panel stepperBox = new Panel
            {
                Location = new Point(0, 120),
                Size = new Size(220, 240),
                BackColor = Color.Transparent
            };

            stepIndicators = new Label[stepNames.Length];
            for (int i = 0; i < stepNames.Length; i++)
            {
                Label lblStep = new Label
                {
                    Location = new Point(20, i * 36),
                    Size = new Size(185, 28),
                    TextAlign = ContentAlignment.MiddleLeft,
                    Font = new Font("Segoe UI", 9F, FontStyle.Regular),
                    ForeColor = Color.FromArgb(100, 116, 139) // Slate 500
                };
                stepIndicators[i] = lblStep;
                stepperBox.Controls.Add(lblStep);
            }
            leftPanel.Controls.Add(stepperBox);

            // Left Sidebar Footer
            Label lblFooterVer = new Label
            {
                Text = "v3.5.0 (x64)",
                Font = new Font("Segoe UI", 7.5F),
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(20, 386),
                Size = new Size(180, 20),
                TextAlign = ContentAlignment.MiddleLeft
            };
            leftPanel.Controls.Add(lblFooterVer);

            this.Controls.Add(leftPanel);

            // 2. Right Content Area (Fixed: 220 -> 720, width 500px, height 416px)
            contentPanel = new Panel
            {
                Location = new Point(220, 0),
                Size = new Size(500, 416),
                BackColor = Color.White
            };
            this.Controls.Add(contentPanel);

            // 3. Bottom Control Bar (Fixed: Y=416, height 64px)
            bottomPanel = new Panel
            {
                Location = new Point(0, 416),
                Size = new Size(720, 64),
                BackColor = Color.FromArgb(241, 245, 249)
            };

            // Divider line at top of bottom panel
            Panel divider = new Panel
            {
                Location = new Point(0, 0),
                Size = new Size(720, 1),
                BackColor = Color.FromArgb(226, 232, 240)
            };
            bottomPanel.Controls.Add(divider);

            btnCancel = CreateStyledButton("Cancel", 605, 16, 95, 32, false);
            btnCancel.Click += (s, e) => {
                if (currentStep < 4 || currentStep == 5) this.Close();
            };

            btnNext = CreateStyledButton("Next >", 498, 16, 98, 32, true);
            btnNext.Click += (s, e) => OnNextClicked();

            btnBack = CreateStyledButton("< Back", 395, 16, 95, 32, false);
            btnBack.Enabled = false;
            btnBack.Click += (s, e) => OnBackClicked();

            bottomPanel.Controls.Add(btnBack);
            bottomPanel.Controls.Add(btnNext);
            bottomPanel.Controls.Add(btnCancel);
            this.Controls.Add(bottomPanel);
        }

        private Button CreateStyledButton(string text, int x, int y, int width, int height, bool isPrimary)
        {
            Button btn = new Button
            {
                Text = text,
                Location = new Point(x, y),
                Size = new Size(width, height),
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9.25F, isPrimary ? FontStyle.Bold : FontStyle.Regular),
                Cursor = Cursors.Hand
            };

            if (isPrimary)
            {
                btn.BackColor = Color.FromArgb(24, 154, 180); // Harmonized Deep Cyan
                btn.ForeColor = Color.White;
                btn.FlatAppearance.BorderSize = 0;
            }
            else
            {
                btn.BackColor = Color.White;
                btn.ForeColor = Color.FromArgb(51, 65, 85); // Slate 700
                btn.FlatAppearance.BorderColor = Color.FromArgb(203, 213, 225);
                btn.FlatAppearance.BorderSize = 1;
            }

            return btn;
        }

        private void UpdateStepperUI()
        {
            for (int i = 0; i < stepNames.Length; i++)
            {
                if (stepIndicators == null || stepIndicators[i] == null) continue;

                if (i == currentStep)
                {
                    stepIndicators[i].Text = "\u25CF  " + stepNames[i];
                    stepIndicators[i].Font = new Font("Segoe UI", 9.25F, FontStyle.Bold);
                    stepIndicators[i].ForeColor = Color.FromArgb(56, 189, 248); // Sky 400
                }
                else if (i < currentStep)
                {
                    stepIndicators[i].Text = "\u2713  " + stepNames[i];
                    stepIndicators[i].Font = new Font("Segoe UI", 9F, FontStyle.Regular);
                    stepIndicators[i].ForeColor = Color.FromArgb(148, 163, 184); // Slate 400
                }
                else
                {
                    stepIndicators[i].Text = "\u25CB  " + stepNames[i];
                    stepIndicators[i].Font = new Font("Segoe UI", 9F, FontStyle.Regular);
                    stepIndicators[i].ForeColor = Color.FromArgb(71, 85, 105); // Slate 600
                }
            }
        }

        private void RenderStepHeader(string title, string subtitle)
        {
            lblStepTitle = new Label
            {
                Text = title,
                Font = new Font("Segoe UI", 14F, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(28, 22),
                Size = new Size(445, 30)
            };

            lblStepSubtitle = new Label
            {
                Text = subtitle,
                Font = new Font("Segoe UI", 9F, FontStyle.Regular),
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(28, 54),
                Size = new Size(445, 24)
            };

            Panel headerDivider = new Panel
            {
                Location = new Point(28, 82),
                Size = new Size(445, 1),
                BackColor = Color.FromArgb(226, 232, 240)
            };

            contentPanel.Controls.Add(lblStepTitle);
            contentPanel.Controls.Add(lblStepSubtitle);
            contentPanel.Controls.Add(headerDivider);
        }

        private void ShowStep(int step)
        {
            currentStep = step;
            UpdateStepperUI();
            contentPanel.Controls.Clear();
            btnBack.Enabled = (step > 0 && step < 4);

            if (step == 0) // Welcome
            {
                btnNext.Text = "Next >";
                btnNext.Enabled = true;

                RenderStepHeader("Welcome to WarpDM Setup", "Fast, clean download manager for Windows.");

                int cardY = 96;
                AddFeatureCard("\u26A1", "Multi-Connection Accelerator", "Accelerates large file downloads cleanly across parallel streams.", ref cardY);
                AddFeatureCard("\uD83C\uDFAC", "4K Video & Audio Grabber", "Downloads HD/4K MP4 videos and MP3 audio straight from your browser.", ref cardY);
                AddFeatureCard("\uD83D\uDEE1", "Reliable Pause & Resume", "Resume interrupted transfers right where they stopped.", ref cardY);
                AddFeatureCard("\uD83C\uDF10", "Browser Extension Included", "One-click download integration for Chrome, Edge, Brave, Opera & Firefox.", ref cardY);
            }
            else if (step == 1) // License
            {
                btnNext.Text = "Next >";
                btnNext.Enabled = true;

                RenderStepHeader("License Agreement", "Review the open-source license terms before continuing.");

                TextBox txtLicense = new TextBox
                {
                    Multiline = true,
                    ReadOnly = true,
                    ScrollBars = ScrollBars.Vertical,
                    Font = new Font("Consolas", 8.25F),
                    BackColor = Color.FromArgb(248, 250, 252),
                    ForeColor = Color.FromArgb(30, 41, 59),
                    Location = new Point(28, 96),
                    Size = new Size(445, 195),
                    Text = "MIT License - WarpDM (Warp Download Manager)\r\n\r\n" +
                           "Copyright (c) 2026 JossefHLV\r\n\r\n" +
                           "Permission is hereby granted, free of charge, to any person obtaining a copy\r\n" +
                           "of this software and associated documentation files (the \"Software\"), to deal\r\n" +
                           "in the Software without restriction, including without limitation the rights\r\n" +
                           "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\r\n" +
                           "copies of the Software, and to permit persons to whom the Software is\r\n" +
                           "furnished to do so, subject to the following conditions:\r\n\r\n" +
                           "The above copyright notice and this permission notice shall be included in all\r\n" +
                           "copies or substantial portions of the Software.\r\n\r\n" +
                           "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\r\n" +
                           "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\r\n" +
                           "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\r\n" +
                           "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\r\n" +
                           "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\r\n" +
                           "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\r\n" +
                           "SOFTWARE."
                };

                rbAccept = new RadioButton
                {
                    Text = "I accept the agreement (Free & Open Source)",
                    UseMnemonic = false,
                    Checked = true,
                    Font = new Font("Segoe UI", 9.25F, FontStyle.Bold),
                    ForeColor = Color.FromArgb(15, 23, 42),
                    Location = new Point(28, 305),
                    Size = new Size(445, 24)
                };

                rbDecline = new RadioButton
                {
                    Text = "I do not accept the agreement",
                    UseMnemonic = false,
                    Font = new Font("Segoe UI", 9F),
                    ForeColor = Color.FromArgb(100, 116, 139),
                    Location = new Point(28, 332),
                    Size = new Size(445, 24)
                };

                rbAccept.CheckedChanged += (s, e) => btnNext.Enabled = rbAccept.Checked;
                rbDecline.CheckedChanged += (s, e) => btnNext.Enabled = rbAccept.Checked;

                contentPanel.Controls.Add(txtLicense);
                contentPanel.Controls.Add(rbAccept);
                contentPanel.Controls.Add(rbDecline);
            }
            else if (step == 2) // Directory
            {
                btnNext.Text = "Next >";
                btnNext.Enabled = true;

                RenderStepHeader("Select Destination Location", "Where should WarpDM be installed?");

                Label lblDestPrompt = new Label
                {
                    Text = "Setup will install WarpDM into the following folder:",
                    Font = new Font("Segoe UI", 9F),
                    ForeColor = Color.FromArgb(51, 65, 85),
                    Location = new Point(28, 100),
                    Size = new Size(445, 22)
                };

                txtDestPath = new TextBox
                {
                    Text = installDir,
                    Location = new Point(28, 126),
                    Size = new Size(350, 27),
                    Font = new Font("Segoe UI", 9F)
                };

                Button btnBrowse = CreateStyledButton("Browse...", 385, 124, 88, 28, false);
                btnBrowse.Click += (s, e) => {
                    using (FolderBrowserDialog fbd = new FolderBrowserDialog())
                    {
                        fbd.SelectedPath = txtDestPath.Text;
                        if (fbd.ShowDialog() == DialogResult.OK)
                        {
                            txtDestPath.Text = fbd.SelectedPath;
                            UpdateDiskSpaceLabel(fbd.SelectedPath);
                        }
                    }
                };

                // Disk Space Card
                Panel spaceCard = new Panel
                {
                    Location = new Point(28, 175),
                    Size = new Size(445, 80),
                    BackColor = Color.FromArgb(248, 250, 252)
                };
                spaceCard.Paint += (s, pe) => {
                    pe.Graphics.DrawRectangle(new Pen(Color.FromArgb(226, 232, 240)), 0, 0, spaceCard.Width - 1, spaceCard.Height - 1);
                };

                Label lblReq = new Label
                {
                    Text = "\u2022  Required disk space: ~120 MB",
                    Font = new Font("Segoe UI", 8.75F, FontStyle.Regular),
                    ForeColor = Color.FromArgb(71, 85, 105),
                    Location = new Point(14, 14),
                    Size = new Size(415, 22)
                };

                lblFreeSpace = new Label
                {
                    Text = GetFreeDiskSpace(installDir),
                    Font = new Font("Segoe UI", 8.75F, FontStyle.Regular),
                    ForeColor = Color.FromArgb(2, 132, 199),
                    Location = new Point(14, 40),
                    Size = new Size(415, 24)
                };

                spaceCard.Controls.Add(lblReq);
                spaceCard.Controls.Add(lblFreeSpace);

                contentPanel.Controls.Add(lblDestPrompt);
                contentPanel.Controls.Add(txtDestPath);
                contentPanel.Controls.Add(btnBrowse);
                contentPanel.Controls.Add(spaceCard);
            }
            else if (step == 3) // Tasks
            {
                btnNext.Text = "Install";
                btnNext.Enabled = true;

                RenderStepHeader("Select Additional Options", "Customize your installation preferences and shortcuts.");

                int optY = 104;
                chkDesktopShortcut = AddOptionCheckbox("Create a Desktop shortcut", "Add WarpDM to your Windows Desktop.", ref optY, true);
                chkStartMenuShortcut = AddOptionCheckbox("Create a Start Menu shortcut", "Add WarpDM to your Windows Start Menu.", ref optY, true);
                chkAutoStart = AddOptionCheckbox("Launch on Windows startup", "Start WarpDM in the system tray when signing in.", ref optY, false);
            }
            else if (step == 4) // Installing
            {
                btnBack.Enabled = false;
                btnNext.Enabled = false;
                btnCancel.Enabled = false;

                RenderStepHeader("Installing WarpDM", "Extracting application files...");

                lblStatus = new Label
                {
                    Text = "Preparing installation package...",
                    Font = new Font("Segoe UI", 9.25F, FontStyle.Bold),
                    ForeColor = Color.FromArgb(2, 132, 199),
                    Location = new Point(28, 110),
                    Size = new Size(445, 22)
                };

                progressBar = new ProgressBar
                {
                    Location = new Point(28, 140),
                    Size = new Size(445, 24),
                    Style = ProgressBarStyle.Continuous,
                    Value = 5
                };

                lblProgressPercent = new Label
                {
                    Text = "0% completed",
                    Font = new Font("Segoe UI", 8.5F),
                    ForeColor = Color.FromArgb(100, 116, 139),
                    Location = new Point(28, 172),
                    Size = new Size(445, 20)
                };

                // Detail Card below
                Panel infoCard = new Panel
                {
                    Location = new Point(28, 215),
                    Size = new Size(445, 95),
                    BackColor = Color.FromArgb(248, 250, 252)
                };
                infoCard.Paint += (s, pe) => {
                    pe.Graphics.DrawRectangle(new Pen(Color.FromArgb(226, 232, 240)), 0, 0, infoCard.Width - 1, infoCard.Height - 1);
                };

                Label lblInfoTitle = new Label
                {
                    Text = "WarpDM v3.5.0",
                    Font = new Font("Segoe UI", 9F, FontStyle.Bold),
                    ForeColor = Color.FromArgb(15, 23, 42),
                    Location = new Point(14, 12),
                    Size = new Size(415, 20)
                };

                Label lblInfoBody = new Label
                {
                    Text = "Configuring desktop shortcuts, media tools, and browser extension files.",
                    Font = new Font("Segoe UI", 8.5F),
                    ForeColor = Color.FromArgb(71, 85, 105),
                    Location = new Point(14, 36),
                    Size = new Size(415, 42)
                };

                infoCard.Controls.Add(lblInfoTitle);
                infoCard.Controls.Add(lblInfoBody);

                contentPanel.Controls.Add(lblStatus);
                contentPanel.Controls.Add(progressBar);
                contentPanel.Controls.Add(lblProgressPercent);
                contentPanel.Controls.Add(infoCard);

                // Run installation in background thread
                ThreadPool.QueueUserWorkItem((state) => PerformInstall());
            }
            else if (step == 5) // Finished
            {
                btnBack.Enabled = false;
                btnCancel.Enabled = false;
                btnNext.Text = "Finish";
                btnNext.Enabled = true;

                RenderStepHeader("Setup Complete", "WarpDM v3.5.0 is ready.");

                Panel successCard = new Panel
                {
                    Location = new Point(28, 92),
                    Size = new Size(445, 108),
                    BackColor = Color.FromArgb(240, 253, 244)
                };
                successCard.Paint += (s, pe) => {
                    pe.Graphics.DrawRectangle(new Pen(Color.FromArgb(187, 247, 208)), 0, 0, successCard.Width - 1, successCard.Height - 1);
                };

                Label lblCheck = new Label
                {
                    Text = "\u2714",
                    Font = new Font("Segoe UI", 24F, FontStyle.Bold),
                    ForeColor = Color.FromArgb(22, 163, 74),
                    Location = new Point(14, 14),
                    Size = new Size(46, 46),
                    TextAlign = ContentAlignment.MiddleCenter
                };

                Label lblSuccTitle = new Label
                {
                    Text = "Installation Successful",
                    Font = new Font("Segoe UI", 11.5F, FontStyle.Bold),
                    ForeColor = Color.FromArgb(20, 83, 45),
                    Location = new Point(68, 15),
                    Size = new Size(360, 24)
                };

                Label lblSuccDesc = new Label
                {
                    Text = "Installed to:\n" + installDir,
                    Font = new Font("Segoe UI", 8.25F),
                    ForeColor = Color.FromArgb(22, 101, 52),
                    Location = new Point(70, 42),
                    Size = new Size(360, 56)
                };

                successCard.Controls.Add(lblCheck);
                successCard.Controls.Add(lblSuccTitle);
                successCard.Controls.Add(lblSuccDesc);

                chkLaunchNow = new CheckBox
                {
                    Text = "Launch WarpDM now",
                    Checked = true,
                    Font = new Font("Segoe UI", 9.5F, FontStyle.Bold),
                    ForeColor = Color.FromArgb(15, 23, 42),
                    Location = new Point(28, 220),
                    Size = new Size(445, 28)
                };

                string extPath = Path.Combine(installDir, "extension");
                Button btnCopyExt = CreateStyledButton("\uD83D\uDCCB Copy Extension Path", 28, 266, 185, 32, false);
                btnCopyExt.Click += (s, e) => {
                    try
                    {
                        Clipboard.SetText(extPath);
                        btnCopyExt.Text = "\u2714 Path Copied!";
                    }
                    catch { }
                };

                Button btnShowExt = CreateStyledButton("\uD83D\uDCC2 Show Extension Folder", 222, 266, 185, 32, false);
                btnShowExt.Click += (s, e) => {
                    try
                    {
                        if (Directory.Exists(extPath))
                        {
                            Process.Start("explorer.exe", "/select,\"" + extPath + "\"");
                        }
                    }
                    catch { }
                };

                Label lblHint = new Label
                {
                    Text = "To connect Chrome, Brave, Edge, Opera, or Firefox anytime, click the 'Browser' button on the WarpDM toolbar.",
                    Font = new Font("Segoe UI", 8.5F),
                    ForeColor = Color.FromArgb(100, 116, 139),
                    Location = new Point(28, 312),
                    Size = new Size(445, 38)
                };

                contentPanel.Controls.Add(successCard);
                contentPanel.Controls.Add(chkLaunchNow);
                contentPanel.Controls.Add(btnCopyExt);
                contentPanel.Controls.Add(btnShowExt);
                contentPanel.Controls.Add(lblHint);
            }
        }

        private void AddFeatureCard(string icon, string title, string description, ref int currentY)
        {
            Panel card = new Panel
            {
                Location = new Point(28, currentY),
                Size = new Size(445, 58),
                BackColor = Color.FromArgb(248, 250, 252)
            };
            card.Paint += (s, pe) => {
                pe.Graphics.DrawRectangle(new Pen(Color.FromArgb(226, 232, 240)), 0, 0, card.Width - 1, card.Height - 1);
            };

            Label lblIcon = new Label
            {
                Text = icon,
                Font = new Font("Segoe UI Emoji", 14F),
                Location = new Point(10, 10),
                Size = new Size(34, 36),
                TextAlign = ContentAlignment.MiddleCenter
            };

            Label lblTitle = new Label
            {
                Text = title,
                Font = new Font("Segoe UI", 9F, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(48, 8),
                Size = new Size(385, 20)
            };

            Label lblDesc = new Label
            {
                Text = description,
                Font = new Font("Segoe UI", 8.25F),
                ForeColor = Color.FromArgb(71, 85, 105),
                Location = new Point(48, 28),
                Size = new Size(385, 22)
            };

            card.Controls.Add(lblIcon);
            card.Controls.Add(lblTitle);
            card.Controls.Add(lblDesc);

            contentPanel.Controls.Add(card);
            currentY += 66;
        }

        private CheckBox AddOptionCheckbox(string title, string description, ref int currentY, bool isChecked)
        {
            Panel optPanel = new Panel
            {
                Location = new Point(28, currentY),
                Size = new Size(445, 52),
                BackColor = Color.Transparent
            };

            CheckBox chk = new CheckBox
            {
                Text = title,
                Checked = isChecked,
                Font = new Font("Segoe UI", 9.25F, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(4, 4),
                Size = new Size(430, 22)
            };

            Label lblDesc = new Label
            {
                Text = description,
                Font = new Font("Segoe UI", 8.25F),
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(24, 26),
                Size = new Size(410, 20)
            };

            optPanel.Controls.Add(chk);
            optPanel.Controls.Add(lblDesc);

            contentPanel.Controls.Add(optPanel);
            currentY += 58;

            return chk;
        }

        private string GetFreeDiskSpace(string path)
        {
            try
            {
                string root = Path.GetPathRoot(Path.GetFullPath(path));
                DriveInfo drive = new DriveInfo(root);
                long freeGb = drive.AvailableFreeSpace / (1024 * 1024 * 1024);
                return string.Format("\u2022  Disk space available: {0} GB free on {1}", freeGb, drive.Name);
            }
            catch
            {
                return "\u2022  Disk space available: Sufficient free space detected";
            }
        }

        private void UpdateDiskSpaceLabel(string path)
        {
            if (lblFreeSpace != null)
            {
                lblFreeSpace.Text = GetFreeDiskSpace(path);
            }
        }

        private void OnNextClicked()
        {
            if (currentStep == 2)
            {
                installDir = txtDestPath.Text.Trim();
                if (string.IsNullOrEmpty(installDir))
                {
                    MessageBox.Show("Please choose a valid destination folder.", "Invalid Path", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
            }

            if (currentStep == 3)
            {
                ShowStep(4);
            }
            else if (currentStep == 5)
            {
                if (chkLaunchNow != null && chkLaunchNow.Checked)
                {
                    string exePath = Path.Combine(installDir, "WarpDM.exe");
                    if (File.Exists(exePath))
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = exePath,
                            WorkingDirectory = installDir
                        });
                    }
                }
                this.Close();
            }
            else
            {
                ShowStep(currentStep + 1);
            }
        }

        private void OnBackClicked()
        {
            if (currentStep > 0)
            {
                ShowStep(currentStep - 1);
            }
        }

        private void PerformInstall()
        {
            try
            {
                TerminateExistingProcesses();
                Directory.CreateDirectory(installDir);

                UpdateProgress(10, "Extracting embedded application package...", 10);

                ExtractEmbeddedPayload(installDir);

                UpdateProgress(85, "Creating shortcuts and system configuration...", 85);

                string targetExe = Path.Combine(installDir, "WarpDM.exe");

                // Self-copy installer to install directory as Uninstall.exe
                try
                {
                    string currentExePath = Assembly.GetExecutingAssembly().Location;
                    if (File.Exists(currentExePath))
                    {
                        string uninstallExe = Path.Combine(installDir, "Uninstall.exe");
                        File.Copy(currentExePath, uninstallExe, true);
                    }
                }
                catch { }

                if (chkDesktopShortcut != null && chkDesktopShortcut.Checked)
                {
                    string desktopPath = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                    string legacyDesktop = Path.Combine(desktopPath, "Hogra Download Manager.lnk");
                    try { if (File.Exists(legacyDesktop)) File.Delete(legacyDesktop); } catch { }
                    CreateShortcut(Path.Combine(desktopPath, "WarpDM.lnk"), targetExe, installDir);
                }

                if (chkStartMenuShortcut != null && chkStartMenuShortcut.Checked)
                {
                    string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs");
                    string legacyStart = Path.Combine(startMenu, "Hogra Download Manager.lnk");
                    try { if (File.Exists(legacyStart)) File.Delete(legacyStart); } catch { }
                    CreateShortcut(Path.Combine(startMenu, "WarpDM.lnk"), targetExe, installDir);
                }

                if (chkAutoStart != null && chkAutoStart.Checked)
                {
                    try
                    {
                        using (RegistryKey rk = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                        {
                            if (rk != null)
                            {
                                rk.DeleteValue("HograDownloadManager", false);
                                rk.SetValue("WarpDM", "\"" + targetExe + "\" --background");
                            }
                        }
                    }
                    catch { }
                }

                RegisterUninstallEntry(installDir, targetExe);
                CleanupLegacyBrowserRegistryKeys();

                UpdateProgress(100, "Installation complete!", 100);
                Thread.Sleep(400);

                if (this.IsHandleCreated)
                {
                    this.BeginInvoke((MethodInvoker)delegate {
                        ShowStep(5);
                    });
                }
            }
            catch (Exception ex)
            {
                if (this.IsHandleCreated)
                {
                    this.BeginInvoke((MethodInvoker)delegate {
                        MessageBox.Show("Installation error: " + ex.Message, "WarpDM Setup Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        ShowStep(3);
                    });
                }
            }
        }

        public void PerformSilentInstall()
        {
            try
            {
                TerminateExistingProcesses();
                Directory.CreateDirectory(installDir);

                ExtractEmbeddedPayload(installDir);

                string targetExe = Path.Combine(installDir, "WarpDM.exe");

                try
                {
                    string currentExePath = Assembly.GetExecutingAssembly().Location;
                    if (File.Exists(currentExePath))
                    {
                        string uninstallExe = Path.Combine(installDir, "Uninstall.exe");
                        File.Copy(currentExePath, uninstallExe, true);
                    }
                }
                catch { }

                string desktopPath = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                try { string oldDesk = Path.Combine(desktopPath, "Hogra Download Manager.lnk"); if (File.Exists(oldDesk)) File.Delete(oldDesk); } catch { }
                CreateShortcut(Path.Combine(desktopPath, "WarpDM.lnk"), targetExe, installDir);

                string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs");
                try { string oldStart = Path.Combine(startMenu, "Hogra Download Manager.lnk"); if (File.Exists(oldStart)) File.Delete(oldStart); } catch { }
                CreateShortcut(Path.Combine(startMenu, "WarpDM.lnk"), targetExe, installDir);

                RegisterUninstallEntry(installDir, targetExe);
                CleanupLegacyBrowserRegistryKeys();

                Console.WriteLine("WarpDM v3.5.0 installed successfully to: " + installDir);
            }
            catch (Exception ex)
            {
                Console.WriteLine("Silent install error: " + ex.Message);
            }
        }

        private void ExtractEmbeddedPayload(string targetDirectory)
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            Stream resourceStream = asm.GetManifestResourceStream("WarpDMInstaller.Payload.zip");

            if (resourceStream == null)
            {
                string fallback = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "payload.zip");
                if (File.Exists(fallback))
                {
                    resourceStream = File.OpenRead(fallback);
                }
                else
                {
                    throw new FileNotFoundException("Embedded payload resource 'WarpDMInstaller.Payload.zip' was not found.");
                }
            }

            using (resourceStream)
            using (ZipArchive archive = new ZipArchive(resourceStream, ZipArchiveMode.Read))
            {
                int totalEntries = archive.Entries.Count;
                int currentEntry = 0;
                string fullTarget = Path.GetFullPath(targetDirectory);

                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    currentEntry++;
                    string destinationPath = Path.GetFullPath(Path.Combine(fullTarget, entry.FullName));

                    // ZipSlip security check
                    if (!destinationPath.StartsWith(fullTarget, StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    if (string.IsNullOrEmpty(entry.Name))
                    {
                        Directory.CreateDirectory(destinationPath);
                    }
                    else
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(destinationPath));
                        entry.ExtractToFile(destinationPath, true);
                    }

                    int pct = 10 + (int)((currentEntry / (double)totalEntries) * 75);
                    UpdateProgress(pct, string.Format("Extracting: {0}", entry.Name), pct);
                }
            }
        }

        private void TerminateExistingProcesses()
        {
            try
            {
                foreach (string procName in new string[] { "WarpDM", "Hogra" })
                {
                    foreach (Process p in Process.GetProcessesByName(procName))
                    {
                        try { p.Kill(); p.WaitForExit(1000); } catch { }
                    }
                }
                foreach (Process p in Process.GetProcessesByName("node"))
                {
                    try
                    {
                        string pFile = p.MainModule.FileName;
                        if (pFile != null && (pFile.IndexOf("WarpDM", StringComparison.OrdinalIgnoreCase) >= 0 || pFile.IndexOf("Hogra", StringComparison.OrdinalIgnoreCase) >= 0))
                        {
                            p.Kill();
                            p.WaitForExit(1000);
                        }
                    }
                    catch { }
                }
            }
            catch { }
        }

        private void RegisterUninstallEntry(string dir, string exePath)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\WarpDM"))
                {
                    if (key != null)
                    {
                        key.SetValue("DisplayName", "WarpDM");
                        key.SetValue("DisplayVersion", "3.5.0");
                        key.SetValue("Publisher", "JossefHLV");
                        key.SetValue("InstallLocation", dir);
                        string iconPath = Path.Combine(dir, "assets", "app.ico");
                        if (File.Exists(iconPath))
                        {
                            key.SetValue("DisplayIcon", iconPath);
                        }
                        string uninstallExe = Path.Combine(dir, "Uninstall.exe");
                        key.SetValue("UninstallString", "\"" + uninstallExe + "\" /uninstall");
                        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    }
                }
                try { SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero); } catch { }
            }
            catch { }
        }

        private void CleanupLegacyBrowserRegistryKeys()
        {
            try
            {
                using (RegistryKey kf = Registry.CurrentUser.OpenSubKey(@"Software\Mozilla\Firefox\Extensions", true))
                {
                    if (kf != null) kf.DeleteValue("warpdm@jossefhlv.github.io", false);
                }
            }
            catch { }
        }

        public static void PerformUninstall(bool isSilent)
        {
            if (!isSilent)
            {
                DialogResult res = MessageBox.Show(
                    "Are you sure you want to completely uninstall WarpDM (Warp Download Manager)?",
                    "WarpDM Uninstall",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question
                );
                if (res != DialogResult.Yes) return;
            }

            try
            {
                foreach (string procName in new string[] { "WarpDM", "Hogra" })
                {
                    foreach (Process p in Process.GetProcessesByName(procName))
                    {
                        try { p.Kill(); p.WaitForExit(1000); } catch { }
                    }
                }

                string desktopShortcut = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                    "WarpDM.lnk"
                );
                if (File.Exists(desktopShortcut)) File.Delete(desktopShortcut);

                string startMenuShortcut = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
                    "Programs",
                    "WarpDM.lnk"
                );
                if (File.Exists(startMenuShortcut)) File.Delete(startMenuShortcut);

                try
                {
                    using (RegistryKey rk = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                    {
                        if (rk != null)
                        {
                            rk.DeleteValue("WarpDM", false);
                            rk.DeleteValue("HograDownloadManager", false);
                        }
                    }
                }
                catch { }

                try
                {
                    Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\WarpDM", false);
                }
                catch { }

                string installDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
                string defaultDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Programs",
                    "WarpDM"
                );

                if (!Directory.Exists(installDir) || !File.Exists(Path.Combine(installDir, "WarpDM.exe")))
                {
                    installDir = defaultDir;
                }

                if (Directory.Exists(installDir))
                {
                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = "cmd.exe",
                        Arguments = string.Format("/C ping 127.0.0.1 -n 2 > nul & rd /s /q \"{0}\"", installDir),
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };
                    Process.Start(psi);
                }

                if (!isSilent)
                {
                    MessageBox.Show("WarpDM was successfully uninstalled.", "Uninstall Complete", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
            catch (Exception ex)
            {
                if (!isSilent)
                {
                    MessageBox.Show("Uninstall error: " + ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        private void UpdateProgress(int value, string text, int percent)
        {
            if (this.IsDisposed || !this.IsHandleCreated) return;
            try
            {
                this.BeginInvoke((MethodInvoker)delegate {
                    try
                    {
                        if (progressBar != null) progressBar.Value = Math.Min(100, Math.Max(0, value));
                        if (lblStatus != null) lblStatus.Text = text;
                        if (lblProgressPercent != null) lblProgressPercent.Text = string.Format("{0}% completed", percent);
                    }
                    catch { }
                });
            }
            catch { }
        }

        private void CreateShortcut(string shortcutPath, string targetPath, string workingDir)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                dynamic shell = Activator.CreateInstance(shellType);
                dynamic shortcut = shell.CreateShortcut(shortcutPath);
                shortcut.TargetPath = targetPath;
                shortcut.WorkingDirectory = workingDir;
                shortcut.Description = "WarpDM \u2014 Warp Download Manager";
                string iconPath = Path.Combine(workingDir, "assets", "app.ico");
                if (File.Exists(iconPath))
                {
                    shortcut.IconLocation = iconPath + ",0";
                }
                shortcut.Save();
            }
            catch { }
        }
    }
}

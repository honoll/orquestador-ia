// Lanzador de bandeja del Orquestador IA (F7). C# 5 (Add-Type de Windows PowerShell 5.1); lo compila
// install-desktop.ps1 a %USERPROFILE%\.orquestador-ia\app\OrquestadorIA.exe. `--self-test` prueba las funciones puras.
// Adopta un servidor que ya responde (nunca lo apaga al salir); si no hay, lanza node oculto con salida a logs\server.log.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Net.Http;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class Core {
  public static string BuildPath(string npmDir, string currentPath) {
    currentPath = currentPath ?? "";
    if (string.IsNullOrEmpty(npmDir)) return currentPath;
    foreach (string p in currentPath.Split(';'))
      if (string.Equals(p.Trim().TrimEnd('\\'), npmDir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) return currentPath;
    return currentPath.Length == 0 ? npmDir : npmDir + ";" + currentPath;
  }

  public static string NodeArgs(string repo) {
    return "\"" + Path.Combine(repo, "node_modules\\tsx\\dist\\cli.mjs") + "\" \"src\\server\\index.ts\"";
  }

  public static string EdgeArgs(string url, string profile) {
    return "--app=" + url + " --user-data-dir=\"" + profile + "\" --no-first-run";
  }

  // {title, text, planId} para un evento plan:done que merece aviso; null para todo lo demás.
  public static string[] NotificationFor(string json) {
    if (json == null || json.IndexOf("plan:done", StringComparison.Ordinal) < 0) return null;
    Dictionary<string, object> e;
    try { e = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>; } catch { return null; }
    if (e == null || Str(e, "type") != "plan:done") return null;
    string id = Str(e, "planId"), status = Str(e, "status"), paused = Str(e, "paused");
    if (string.IsNullOrEmpty(id)) return null;
    string title = null;
    if (status == "completed") title = "Plan terminado";
    else if (status == "failed") title = "El plan falló";
    else if (status == "pending") {
      if (paused == "quota") title = "Plan pausado por cuota";
      else if (paused == "budget") title = "Plan pausado por presupuesto";
      else if (paused == "guard") title = "Plan pausado por guardia";
    }
    if (title == null) return null;
    return new string[] { title, "Plan " + (id.Length > 8 ? id.Substring(0, 8) : id), id };
  }

  // Huella del orquestador: GET /api/voice/status devuelve un objeto JSON con "whisper" y "piper" (objetos).
  // Una app ajena con ruta comodín (200 + index.html) no pasa: así nunca se adopta ni se apaga un servidor ajeno.
  public static bool IsOrquestadorStatus(string body) {
    if (body == null) return false;
    try {
      Dictionary<string, object> d = new JavaScriptSerializer().DeserializeObject(body) as Dictionary<string, object>;
      object w, p;
      return d != null && d.TryGetValue("whisper", out w) && w is Dictionary<string, object> &&
        d.TryGetValue("piper", out p) && p is Dictionary<string, object>;
    } catch { return false; }
  }

  public static bool ShouldRotate(long size) { return size >= 5L * 1024 * 1024; }

  public static string Str(Dictionary<string, object> d, string k) {
    object v; return d != null && d.TryGetValue(k, out v) && v != null ? v.ToString() : null;
  }
}

public class Launcher : ApplicationContext {
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
  [DllImport("kernel32.dll")] static extern bool AttachConsole(int pid);

  static readonly string DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".orquestador-ia");
  static readonly string AppDir = Path.GetDirectoryName(Application.ExecutablePath);
  static readonly string ConfigPath = Path.Combine(AppDir, "launcher.json");
  static readonly string LogDir = Path.Combine(DataDir, "logs");
  static readonly string ServerLog = Path.Combine(LogDir, "server.log");
  static readonly string Profile = Path.Combine(DataDir, "edge-app");

  Dictionary<string, object> cfg;
  string repo, npmDir, edge;
  int port = 3100;
  volatile bool notifications = true;
  volatile bool quitting;
  Process server; // el cmd.exe que envuelve a node; null = servidor adoptado (o ninguno): nunca se apaga al salir
  readonly object serverLock = new object();
  readonly NotifyIcon tray = new NotifyIcon();
  readonly Control ui = new Control();
  Action balloonClick;

  [STAThread]
  public static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "--self-test") { AttachConsole(-1); return SelfTest(); }
    bool created;
    using (Mutex m = new Mutex(true, "Local\\OrquestadorIA", out created))
    using (EventWaitHandle show = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\OrquestadorIA.Show")) {
      if (!created) { AllowSetForegroundWindow(-1); show.Set(); return 0; }
      Application.EnableVisualStyles();
      Application.Run(new Launcher(show));
      GC.KeepAlive(m);
    }
    return 0;
  }

  Launcher(EventWaitHandle show) {
    IntPtr h = ui.Handle; // crea el handle en el hilo de UI para Invoke desde otros hilos
    string ico = Path.Combine(AppDir, "orquestador.ico");
    tray.Icon = File.Exists(ico) ? new Icon(ico) : SystemIcons.Application;
    tray.Text = "Orquestador IA";
    ContextMenuStrip menu = new ContextMenuStrip();
    menu.Items.Add("Abrir", null, delegate { Bg(delegate { OpenWindow(null, null); }); });
    menu.Items.Add("Platicar", null, delegate { Bg(delegate { OpenWindow("platicar", null); }); });
    ToolStripMenuItem notif = new ToolStripMenuItem("Notificaciones");
    menu.Items.Add(notif);
    menu.Items.Add("Reiniciar servidor", null, delegate { Bg(Restart); });
    menu.Items.Add("Ver registro", null, delegate { ShowLog(); });
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add("Salir", null, delegate { Quit(); });
    tray.ContextMenuStrip = menu;
    tray.DoubleClick += delegate { Bg(delegate { OpenWindow(null, null); }); };
    tray.BalloonTipClicked += delegate { Action a = balloonClick; if (a != null) a(); };
    tray.Visible = true;

    if (!LoadConfig()) return;
    notif.Checked = notifications;
    notif.Click += delegate { notifications = notif.Checked = !notif.Checked; SaveConfig(); };

    Bg(delegate { try { while (show.WaitOne() && !quitting) OpenWindow(null, null); } catch (ObjectDisposedException) { } });
    Thread ws = new Thread(WsLoop);
    ws.IsBackground = true; ws.Start();
    Bg(delegate { if (EnsureServer()) OpenWindow(null, null); });
  }

  string BaseUrl { get { return "http://127.0.0.1:" + port; } }

  static void Bg(ThreadStart f) {
    Thread t = new Thread(delegate() { try { f(); } catch (Exception e) { Log("error: " + e); } });
    t.IsBackground = true; t.Start();
  }

  bool LoadConfig() {
    try {
      cfg = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(ConfigPath)) as Dictionary<string, object>;
    } catch (Exception e) { Log("launcher.json: " + e.Message); }
    if (cfg == null) cfg = new Dictionary<string, object>();
    repo = Core.Str(cfg, "repo");
    npmDir = Core.Str(cfg, "npmDir");
    edge = Core.Str(cfg, "edge") ?? @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
    int p; if (int.TryParse(Core.Str(cfg, "port"), out p) && p > 0) port = p;
    notifications = Core.Str(cfg, "notifications") != "False";
    if (string.IsNullOrEmpty(repo) || !Directory.Exists(repo)) {
      Balloon("Falta configuración", "No encuentro el repo en " + ConfigPath + ". Corre install-desktop.ps1.", ToolTipIcon.Error, null);
      return false;
    }
    return true;
  }

  void SaveConfig() {
    cfg["notifications"] = notifications;
    try { File.WriteAllText(ConfigPath, new JavaScriptSerializer().Serialize(cfg), new UTF8Encoding(false)); }
    catch (Exception e) { Log("guardar launcher.json: " + e.Message); }
  }

  // ---------- servidor ----------
  const int Nobody = 0, Ours = 1, Foreign = 2;
  int Probe() {
    try {
      using (HttpClient c = new HttpClient()) {
        c.Timeout = TimeSpan.FromSeconds(2);
        HttpResponseMessage r = c.GetAsync(BaseUrl + "/api/voice/status").Result;
        return r.IsSuccessStatusCode && Core.IsOrquestadorStatus(r.Content.ReadAsStringAsync().Result) ? Ours : Foreign;
      }
    } catch { return Nobody; }
  }

  bool Alive() { return Probe() == Ours; }

  void PortBusy() {
    Balloon("Puerto ocupado", "El puerto " + port + " lo usa otra aplicación; cambia `port` en launcher.json.", ToolTipIcon.Error, null);
  }

  bool Post(string path, string json) {
    try {
      using (HttpClient c = new HttpClient()) {
        c.Timeout = TimeSpan.FromSeconds(5);
        return c.PostAsync(BaseUrl + path, new StringContent(json, Encoding.UTF8, "application/json")).Result.IsSuccessStatusCode;
      }
    } catch { return false; }
  }

  string GetJson(string path) {
    try {
      using (HttpClient c = new HttpClient()) {
        c.Timeout = TimeSpan.FromSeconds(3);
        HttpResponseMessage r = c.GetAsync(BaseUrl + path).Result;
        return r.IsSuccessStatusCode ? r.Content.ReadAsStringAsync().Result : null;
      }
    } catch { return null; }
  }

  bool EnsureServer() {
    lock (serverLock) {
      int probe = Probe();
      if (probe == Ours) return true;
      if (probe == Foreign) { PortBusy(); return false; }
      if (quitting) return false; // Salir llegó antes de lanzar: no dejar un node huérfano
      string path = Core.BuildPath(npmDir, Environment.GetEnvironmentVariable("PATH"));
      string node = FindOnPath("node.exe", path);
      if (node == null) { Balloon("No encuentro Node.js", "Instala Node.js (node en el PATH) y vuelve a abrir.", ToolTipIcon.Error, null); return false; }
      if (!File.Exists(Path.Combine(repo, @"ui\dist\index.html"))) {
        Balloon("Falta la interfaz", "No existe ui\\dist. Corre install-desktop.ps1 (hace npm run build:ui).", ToolTipIcon.Error, null);
        return false;
      }
      if (string.IsNullOrEmpty(npmDir) || !Directory.Exists(npmDir))
        Balloon("No encuentro Claude Code/Codex", "Carpeta npm ausente (" + npmDir + "): los pasos con claude/codex fallarán.", ToolTipIcon.Warning, null);
      try {
        Directory.CreateDirectory(LogDir);
        if (File.Exists(ServerLog) && Core.ShouldRotate(new FileInfo(ServerLog).Length)) {
          string old = ServerLog + ".1";
          if (File.Exists(old)) File.Delete(old);
          File.Move(ServerLog, old);
        }
      } catch (Exception e) { Log("rotar log: " + e.Message); }
      ProcessStartInfo psi = new ProcessStartInfo("cmd.exe",
        "/d /s /c \"\"" + node + "\" " + Core.NodeArgs(repo) + " >> \"" + ServerLog + "\" 2>&1\"");
      psi.UseShellExecute = false;
      psi.CreateNoWindow = true;
      psi.WorkingDirectory = repo;
      psi.EnvironmentVariables["PATH"] = path;
      psi.EnvironmentVariables["ORQUESTADOR_PORT"] = port.ToString();
      try { server = Process.Start(psi); } catch (Exception e) {
        Balloon("No pude arrancar el servidor", e.Message, ToolTipIcon.Error, ShowLog); return false;
      }
      SetText("Orquestador IA · arrancando…");
      for (int i = 0; i < 60; i++) {
        if (Alive()) { SetText("Orquestador IA"); return true; }
        if (server.WaitForExit(1000)) break;
      }
      SetText("Orquestador IA");
      if (server.HasExited && Probe() == Foreign) { PortBusy(); return false; }
      Balloon("El servidor no responde", "Pasaron 60 s sin respuesta. Clic para ver el registro.", ToolTipIcon.Error, ShowLog);
      return false;
    }
  }

  // Apaga el servidor: ordenado por HTTP; si es nuestro y no muere en 10 s, taskkill del árbol.
  void StopServer() {
    lock (serverLock) {
      Process p = server;
      if (p != null && p.HasExited) { server = null; p = null; }
      if (p == null && !Alive()) return;
      Post("/api/system/shutdown", "{}");
      if (p != null) {
        if (!p.WaitForExit(10000)) {
          Log("el servidor no cerró en 10 s; taskkill /T /F " + p.Id);
          try { Process.Start(new ProcessStartInfo("taskkill", "/T /F /PID " + p.Id) { CreateNoWindow = true, UseShellExecute = false }).WaitForExit(5000); }
          catch (Exception e) { Log("taskkill: " + e.Message); }
        }
        server = null;
      } else {
        // shortcut: un servidor adoptado no tiene PID conocido; si ignora el apagado solo se avisa.
        for (int i = 0; i < 10 && Alive(); i++) Thread.Sleep(1000);
        if (Alive()) Balloon("No pude detener el servidor", "El servidor adoptado sigue respondiendo.", ToolTipIcon.Warning, null);
      }
    }
  }

  void Restart() { StopServer(); if (EnsureServer()) Balloon("Servidor reiniciado", "Listo.", ToolTipIcon.Info, null); }

  void Quit() {
    if (quitting) return;
    quitting = true;
    SetText("Orquestador IA · cerrando…");
    Bg(delegate {
      lock (serverLock) { if (server != null) StopServer(); } // solo el servidor propio; uno adoptado nunca se apaga al salir
      ui.BeginInvoke((MethodInvoker)delegate { tray.Visible = false; tray.Dispose(); ExitThread(); });
    });
  }

  static string FindOnPath(string exe, string path) {
    foreach (string d in path.Split(';')) {
      try { string f = Path.Combine(d.Trim().Trim('"'), exe); if (d.Trim().Length > 0 && File.Exists(f)) return f; } catch { }
    }
    return null;
  }

  // ---------- ventana ----------
  void OpenWindow(string intent, string planId) {
    IntPtr h = FindAppWindow();
    if (h != IntPtr.Zero) {
      ShowWindow(h, 9); // SW_RESTORE
      SetForegroundWindow(h);
      if (intent == "platicar") Post("/api/system/ui-intent", "{\"open\":\"platicar\"}");
      else if (intent == "plan") Post("/api/system/ui-intent", "{\"open\":\"plan\",\"planId\":" + new JavaScriptSerializer().Serialize(planId) + "}");
      return;
    }
    string url = BaseUrl + "/";
    if (intent == "platicar") url += "?platicar=1";
    else if (intent == "plan") url += "?plan=" + Uri.EscapeDataString(planId);
    try {
      if (!File.Exists(edge)) throw new FileNotFoundException(edge);
      Process.Start(edge, Core.EdgeArgs(url, Profile));
    } catch (Exception e) {
      Log("Edge: " + e.Message);
      Balloon("No pude abrir Edge", "Abro el navegador predeterminado.", ToolTipIcon.Warning, null);
      try { Process.Start(url); } catch (Exception e2) { Log("navegador: " + e2.Message); }
    }
  }

  static IntPtr FindAppWindow() {
    try {
      using (ManagementObjectSearcher s = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'msedge.exe'")) {
        foreach (ManagementObject o in s.Get()) {
          string cl = o["CommandLine"] as string;
          if (cl == null || cl.IndexOf("--user-data-dir=\"" + Profile + "\"", StringComparison.OrdinalIgnoreCase) < 0 &&
              cl.IndexOf("--user-data-dir=" + Profile, StringComparison.OrdinalIgnoreCase) < 0) continue;
          try {
            IntPtr h = Process.GetProcessById(Convert.ToInt32(o["ProcessId"])).MainWindowHandle;
            if (h != IntPtr.Zero) return h;
          } catch { }
        }
      }
    } catch (Exception e) { Log("WMI: " + e.Message); }
    return IntPtr.Zero;
  }

  // ---------- notificaciones ----------
  void WsLoop() {
    byte[] buf = new byte[16384];
    while (!quitting) {
      try {
        using (ClientWebSocket ws = new ClientWebSocket()) {
          ws.ConnectAsync(new Uri("ws://127.0.0.1:" + port + "/ws"), CancellationToken.None).Wait();
          MemoryStream msg = new MemoryStream();
          while (ws.State == WebSocketState.Open && !quitting) {
            WebSocketReceiveResult r = ws.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None).Result;
            if (r.MessageType == WebSocketMessageType.Close) break;
            if (msg.Length < 4 * 1024 * 1024) msg.Write(buf, 0, r.Count); // evita crecer sin límite con un mensaje enorme
            if (!r.EndOfMessage) continue;
            if (r.MessageType == WebSocketMessageType.Text) OnEvent(Encoding.UTF8.GetString(msg.ToArray()));
            msg.SetLength(0);
          }
        }
      } catch { }
      if (!quitting) Thread.Sleep(5000);
    }
  }

  void OnEvent(string json) {
    string[] n = Core.NotificationFor(json);
    if (n == null || !notifications) return;
    string planId = n[2], text = n[1];
    Dictionary<string, object> plan = null;
    try { plan = new JavaScriptSerializer().DeserializeObject(GetJson("/api/plans/" + Uri.EscapeDataString(planId)) ?? "null") as Dictionary<string, object>; } catch { }
    string desc = Core.Str(plan, "description");
    if (!string.IsNullOrEmpty(desc)) text = desc.Length > 200 ? desc.Substring(0, 200) + "…" : desc;
    Balloon(n[0], text, n[0] == "Plan terminado" ? ToolTipIcon.Info : ToolTipIcon.Warning,
      delegate { Bg(delegate { OpenWindow("plan", planId); }); });
  }

  // ---------- utilidades de UI ----------
  void Balloon(string title, string text, ToolTipIcon icon, Action onClick) {
    Log(title + ": " + text);
    try {
      ui.BeginInvoke((MethodInvoker)delegate {
        balloonClick = onClick;
        tray.ShowBalloonTip(10000, title, text, icon);
      });
    } catch { }
  }

  void SetText(string t) { try { ui.BeginInvoke((MethodInvoker)delegate { tray.Text = t; }); } catch { } }

  void ShowLog() {
    if (File.Exists(ServerLog)) Process.Start("notepad.exe", "\"" + ServerLog + "\"");
    else Balloon("Sin registro", "Aún no existe " + ServerLog, ToolTipIcon.Info, null);
  }

  static void Log(string line) {
    try {
      Directory.CreateDirectory(LogDir);
      File.AppendAllText(Path.Combine(LogDir, "launcher.log"), DateTime.Now.ToString("s") + " " + line + Environment.NewLine);
    } catch { }
  }

  // ---------- self-test ----------
  static int fails, checks;
  static void Check(bool ok, string name) { checks++; if (!ok) { fails++; Console.WriteLine("FAIL " + name); } }

  static int SelfTest() {
    Check(Core.BuildPath(@"C:\npm", @"C:\a;C:\b") == @"C:\npm;C:\a;C:\b", "BuildPath antepone");
    Check(Core.BuildPath(@"C:\npm", @"C:\a;c:\NPM\;C:\b") == @"C:\a;c:\NPM\;C:\b", "BuildPath sin duplicar");
    Check(Core.BuildPath(null, @"C:\a") == @"C:\a", "BuildPath sin npmDir");
    Check(Core.BuildPath(@"C:\npm", "") == @"C:\npm", "BuildPath PATH vacío");
    Check(Core.NodeArgs(@"C:\r") == "\"C:\\r\\node_modules\\tsx\\dist\\cli.mjs\" \"src\\server\\index.ts\"", "NodeArgs");
    Check(Core.EdgeArgs("http://127.0.0.1:3100/?plan=x", @"C:\p") ==
      "--app=http://127.0.0.1:3100/?plan=x --user-data-dir=\"C:\\p\" --no-first-run", "EdgeArgs");
    string[] n = Core.NotificationFor("{\"type\":\"plan:done\",\"planId\":\"abcdef123456\",\"status\":\"completed\",\"timestamp\":\"t\"}");
    Check(n != null && n[0] == "Plan terminado" && n[1] == "Plan abcdef12" && n[2] == "abcdef123456", "completed");
    n = Core.NotificationFor("{\"type\":\"plan:done\",\"planId\":\"p1\",\"status\":\"failed\"}");
    Check(n != null && n[0] == "El plan falló" && n[1] == "Plan p1", "failed");
    n = Core.NotificationFor("{\"type\":\"plan:done\",\"planId\":\"p1\",\"status\":\"pending\",\"paused\":\"quota\"}");
    Check(n != null && n[0] == "Plan pausado por cuota", "quota");
    n = Core.NotificationFor("{\"type\":\"plan:done\",\"planId\":\"p1\",\"status\":\"pending\",\"paused\":\"budget\"}");
    Check(n != null && n[0] == "Plan pausado por presupuesto", "budget");
    n = Core.NotificationFor("{\"type\":\"plan:done\",\"planId\":\"p1\",\"status\":\"pending\",\"paused\":\"guard\"}");
    Check(n != null && n[0] == "Plan pausado por guardia", "guard");
    Check(Core.NotificationFor("{\"type\":\"plan:done\",\"planId\":\"p1\",\"status\":\"pending\"}") == null, "pending sin pausa");
    Check(Core.NotificationFor("{\"type\":\"plan:done\",\"planId\":\"p1\",\"status\":\"cancelled\"}") == null, "cancelled");
    Check(Core.NotificationFor("{\"type\":\"plan:step\",\"planId\":\"p1\",\"status\":\"failed\",\"x\":\"plan:done\"}") == null, "otro tipo");
    Check(Core.NotificationFor("{\"type\":\"plan:done\",\"status\":\"completed\"}") == null, "sin planId");
    Check(Core.NotificationFor("plan:done {no es json") == null, "basura");
    Check(Core.NotificationFor("[\"plan:done\"]") == null, "no es objeto");
    Check(Core.NotificationFor(null) == null, "null");
    Check(Core.IsOrquestadorStatus("{\"whisper\":{\"available\":true,\"state\":\"stopped\"},\"piper\":{\"available\":true},\"duck\":{}}"), "huella ok");
    Check(!Core.IsOrquestadorStatus("<!DOCTYPE html><html></html>"), "huella html");
    Check(!Core.IsOrquestadorStatus("{\"whisper\":{}}"), "huella sin piper");
    Check(!Core.IsOrquestadorStatus("{\"whisper\":true,\"piper\":\"x\"}"), "huella no objetos");
    Check(!Core.IsOrquestadorStatus("[]") && !Core.IsOrquestadorStatus("") && !Core.IsOrquestadorStatus(null), "huella vacía");
    Check(!Core.ShouldRotate(5L * 1024 * 1024 - 1) && Core.ShouldRotate(5L * 1024 * 1024), "ShouldRotate");
    Console.WriteLine(fails == 0 ? "SELF-TEST PASS (" + checks + " checks)" : "SELF-TEST FAIL (" + fails + "/" + checks + ")");
    return fails == 0 ? 0 : 1;
  }
}

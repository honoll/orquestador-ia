// Ducking de audio por aplicacion (Windows Core Audio). Helper de larga vida compilado a .exe
// (ver build-duck-helper.ps1): lee una linea JSON por stdin, responde una linea JSON por stdout.
//   {"cmd":"apply","level":0.2,"exclude":["firefox"]}
//   {"cmd":"restore"}
//   {"cmd":"restore","entries":[{"pid":1,"name":"x","id":"...","saved":0.7,"ducked":0.14}]}   (recuperacion tras un cierre brusco)
//   {"cmd":"ping"}
// Al cerrarse stdin (EOF) restaura todo y termina. Nunca toca pid 0 (sonidos del sistema) ni a si mismo.
// Es un exe (no PowerShell) para poder lanzarlo con detached:true: asi sobrevive al kill del job object de node
// y ve el EOF cuando el servidor muere de golpe. Compatible con C# 5 (Add-Type de Windows PowerShell 5.1).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IMMDeviceCollection ppDevices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
}
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
  [PreserveSig] int GetCount(out uint pcDevices);
  [PreserveSig] int Item(uint nDevice, out IMMDevice ppDevice);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface); }
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 { int NotImpl1(); int NotImpl2(); [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e); }
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator { [PreserveSig] int GetCount(out int c); [PreserveSig] int GetSession(int i, out IAudioSessionControl2 s); }
[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  int NotImpl0(); int NotImpl1(); int NotImpl2(); int NotImpl3(); int NotImpl4(); int NotImpl5(); int NotImpl6(); int NotImpl7(); int NotImpl8();
  int NotImpl9();
  [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetProcessId(out uint pid);
}
[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume { [PreserveSig] int SetMasterVolume(float l, ref Guid ctx); [PreserveSig] int GetMasterVolume(out float l); }

public class Sess {
  public string Id; public int Pid; public string Name; public float Vol;
  internal ISimpleAudioVolume V;
  public bool Set(float l) { Guid g = Guid.Empty; return V.SetMasterVolume(l, ref g) == 0; }
}

public static class Duck {
  // Sesiones de TODOS los dispositivos de render activos (bocinas, audifonos, Bluetooth, rol comunicaciones...).
  public static List<Sess> List() {
    var r = new List<Sess>();
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDeviceCollection col; if (en.EnumAudioEndpoints(0, 1, out col) != 0) return r;   // eRender, DEVICE_STATE_ACTIVE
    uint cnt; if (col.GetCount(out cnt) != 0) return r;
    for (uint d = 0; d < cnt; d++) {
      try { AddDevice(col, d, r); } catch {}
    }
    return r;
  }

  static void AddDevice(IMMDeviceCollection col, uint d, List<Sess> r) {
    IMMDevice dev; if (col.Item(d, out dev) != 0) return;
    var iid = typeof(IAudioSessionManager2).GUID; object o; if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return;
    var mgr = (IAudioSessionManager2)o; IAudioSessionEnumerator se; if (mgr.GetSessionEnumerator(out se) != 0) return;
    int n; se.GetCount(out n);
    for (int i = 0; i < n; i++) {
      try {
        IAudioSessionControl2 s; if (se.GetSession(i, out s) != 0) continue;
        uint pid; s.GetProcessId(out pid);
        string id = null; try { s.GetSessionInstanceIdentifier(out id); } catch {}
        var v = (ISimpleAudioVolume)s; float l; if (v.GetMasterVolume(out l) != 0) continue;
        string name = "?"; try { name = Process.GetProcessById((int)pid).ProcessName; } catch {}
        r.Add(new Sess { Id = id ?? (d + ":" + pid + "#" + i), Pid = (int)pid, Name = name, Vol = l, V = v });
      } catch {}
    }
  }
}

public class Entry {
  public int Pid; public string Name; public double Saved; public double Ducked;
  internal ISimpleAudioVolume V;   // se conserva para restaurar aunque la sesion ya no aparezca en la lista
}

public static class DuckHelper {
  const double Tol = 0.02;
  static readonly Dictionary<string, Entry> ducked = new Dictionary<string, Entry>();
  static readonly JavaScriptSerializer json = new JavaScriptSerializer();
  static TextWriter outw;
  static int own;

  static double Round3(double x) { return Math.Round(x, 3); }

  static Dictionary<string, object> Rec(int pid, string name, double saved) {
    var d = new Dictionary<string, object>();
    d["pid"] = pid; d["name"] = name; d["saved"] = Round3(saved);
    return d;
  }

  static bool Near(double a, double b) { return Math.Abs(a - b) <= Tol; }
  static bool Safe(Sess s) { return s.Pid != 0 && s.Pid != own; }

  // Restaura una entrada. Devuelve true si quedo resuelta (restaurada o respetada porque el usuario la cambio);
  // false si no se encontro nada que restaurar (se conserva para reintentar).
  // Busqueda: 1) mismo id de sesion; 2) mismo pid+nombre con volumen ~ ducked; 3) mismo nombre con volumen ~ ducked
  // (el pid cambio tras reiniciar la app). El respaldo 2/3 exige volumen ~ ducked para no pisar volumenes reales.
  static bool RestoreOne(List<Sess> sessions, string key, Entry e, HashSet<Sess> claimed, List<object> restored, List<object> kept) {
    Sess s = null;
    foreach (var c in sessions) { if (c.Id == key && Safe(c)) { s = c; break; } }
    if (s == null) {
      foreach (var c in sessions) { if (Safe(c) && !claimed.Contains(c) && c.Pid == e.Pid && c.Name == e.Name && Near(c.Vol, e.Ducked)) { s = c; break; } }
    }
    if (s == null) {
      foreach (var c in sessions) { if (Safe(c) && !claimed.Contains(c) && c.Name == e.Name && Near(c.Vol, e.Ducked)) { s = c; break; } }
    }
    if (s == null && e.V != null) {   // la sesion ya no se lista pero el objeto COM puede seguir respondiendo
      try {
        float cur; if (e.V.GetMasterVolume(out cur) == 0 && Near(cur, e.Ducked)) {
          Guid g = Guid.Empty;
          if (e.V.SetMasterVolume((float)e.Saved, ref g) == 0) { restored.Add(Rec(e.Pid, e.Name, e.Saved)); return true; }
        }
      } catch {}
    }
    if (s == null) {
      // Misma app viva (mismo pid+nombre) pero con otro volumen: el usuario lo cambio, se respeta.
      foreach (var c in sessions) { if (Safe(c) && !claimed.Contains(c) && c.Pid == e.Pid && c.Name == e.Name) {
        var d = new Dictionary<string, object>(); d["pid"] = e.Pid; d["name"] = e.Name; d["current"] = Round3(c.Vol);
        kept.Add(d); claimed.Add(c); return true;
      } }
      return false;
    }
    claimed.Add(s);
    if (Near(s.Vol, e.Ducked)) {
      if (s.Set((float)e.Saved)) { restored.Add(Rec(e.Pid, e.Name, e.Saved)); return true; }
      return false;
    }
    var k = new Dictionary<string, object>();   // el usuario lo cambio: se respeta
    k["pid"] = e.Pid; k["name"] = e.Name; k["current"] = Round3(s.Vol);
    kept.Add(k);
    return true;
  }

  static void RestoreAll(List<Sess> sessions, List<object> restored, List<object> kept) {
    var claimed = new HashSet<Sess>();
    foreach (var k in new List<string>(ducked.Keys)) {
      try { if (RestoreOne(sessions, k, ducked[k], claimed, restored, kept)) ducked.Remove(k); } catch {}
    }
  }

  static double Num(object o) { return Convert.ToDouble(o, System.Globalization.CultureInfo.InvariantCulture); }
  static object Get(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) ? v : null; }

  static Dictionary<string, object> Handle(Dictionary<string, object> req) {
    var restored = new List<object>();
    var kept = new List<object>();
    var newly = new List<object>();
    var sessions = Duck.List();
    string cmd = Convert.ToString(Get(req, "cmd"));
    if (cmd == "apply") {
      object lv = Get(req, "level");
      double level = Math.Max(0.0, Math.Min(1.0, lv == null ? 0.2 : Num(lv)));
      var excl = new List<string>();
      var ex = Get(req, "exclude") as IEnumerable;
      if (ex != null && !(ex is string)) foreach (var x in ex) excl.Add(Convert.ToString(x).ToLowerInvariant());
      foreach (var s in sessions) {
        try {
          bool skip = s.Pid == 0 || s.Pid == own || excl.Contains(s.Name.ToLowerInvariant());
          if (skip) {
            Entry old;
            if (ducked.TryGetValue(s.Id, out old)) { if (RestoreOne(sessions, s.Id, old, new HashSet<Sess>(), restored, kept)) ducked.Remove(s.Id); }
            continue;
          }
          if (ducked.ContainsKey(s.Id)) continue;
          bool pend = false;   // una entrada pendiente (app reiniciada) no se vuelve a atenuar encima de su volumen ya atenuado
          foreach (var pe in ducked.Values) { if (pe.Name == s.Name && Near(s.Vol, pe.Ducked)) { pend = true; break; } }
          if (pend) continue;
          float target = (float)(s.Vol * level);
          if (s.Set(target)) {
            ducked[s.Id] = new Entry { Pid = s.Pid, Name = s.Name, Saved = s.Vol, Ducked = target, V = s.V };
            newly.Add(Rec(s.Pid, s.Name, s.Vol));
          }
        } catch {}
      }
    } else if (cmd == "restore") {
      var entries = Get(req, "entries") as IEnumerable;
      var claimedAll = new HashSet<Sess>();
      if (entries != null && !(entries is string)) {
        foreach (var raw in entries) {
          try {
            var e = raw as Dictionary<string, object>; if (e == null) continue;
            int pid = (int)Num(e["pid"]); string name = Convert.ToString(e["name"]);
            string id = Get(e, "id") == null ? "" : Convert.ToString(Get(e, "id"));
            if (pid == 0) continue;
            var en = new Entry { Pid = pid, Name = name, Saved = Num(e["saved"]), Ducked = Num(e["ducked"]) };
            string key = id != "" ? id : ("pid" + pid + ":" + name);
            // Sin sesion que restaurar: se conserva en ducked (y por tanto en "active"/archivo de estado) para reintentar.
            if (!RestoreOne(sessions, key, en, claimedAll, restored, kept)) ducked[key] = en;
          } catch {}
        }
      } else RestoreAll(sessions, restored, kept);
    } else if (cmd != "ping") {
      throw new Exception("comando desconocido");
    }
    var active = new List<object>();
    foreach (var kv in ducked) {
      var d = new Dictionary<string, object>();
      d["id"] = kv.Key; d["pid"] = kv.Value.Pid; d["name"] = kv.Value.Name;
      d["saved"] = Round3(kv.Value.Saved); d["ducked"] = Round3(kv.Value.Ducked);
      active.Add(d);
    }
    var res = new Dictionary<string, object>();
    res["ok"] = true; res["ducked"] = newly; res["active"] = active; res["restored"] = restored; res["kept"] = kept;
    return res;
  }

  static void Emit(Dictionary<string, object> o) { outw.WriteLine(json.Serialize(o)); outw.Flush(); }

  public static void Main() {
    own = Process.GetCurrentProcess().Id;
    outw = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    var inr = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    var ready = new Dictionary<string, object>(); ready["ok"] = true; ready["ready"] = true;
    Emit(ready);
    while (true) {
      string line;
      try { line = inr.ReadLine(); } catch { break; }
      if (line == null) break;   // EOF: node cerro stdin o murio
      if (line.Trim() == "") continue;
      try {
        var req = json.DeserializeObject(line) as Dictionary<string, object>;
        if (req == null) throw new Exception("solicitud invalida");
        Emit(Handle(req));
      } catch (Exception ex) {
        try {
          var err = new Dictionary<string, object>(); err["ok"] = false; err["error"] = ex.Message;
          Emit(err);
        } catch {}
      }
    }
    try { RestoreAll(Duck.List(), new List<object>(), new List<object>()); } catch {}
  }
}

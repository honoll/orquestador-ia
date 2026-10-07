# Ducking de audio por aplicacion (Windows Core Audio). Helper de larga vida:
# lee una linea JSON por stdin, responde una linea JSON por stdout.
#   {"cmd":"apply","level":0.2,"exclude":["firefox"]}
#   {"cmd":"restore"}
#   {"cmd":"restore","entries":[{"pid":1,"name":"x","id":"...","saved":0.7,"ducked":0.14}]}   (recuperacion tras un cierre brusco)
# Al cerrarse stdin restaura todo y termina. Nunca toca pid 0 (sonidos del sistema) ni a si mismo.
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int NotImpl1(); [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice); }
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
  public static List<Sess> List() {
    var r = new List<Sess>();
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice dev; if (en.GetDefaultAudioEndpoint(0, 1, out dev) != 0) return r;
    var iid = typeof(IAudioSessionManager2).GUID; object o; if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return r;
    var mgr = (IAudioSessionManager2)o; IAudioSessionEnumerator se; if (mgr.GetSessionEnumerator(out se) != 0) return r;
    int n; se.GetCount(out n);
    for (int i = 0; i < n; i++) {
      try {
        IAudioSessionControl2 s; if (se.GetSession(i, out s) != 0) continue;
        uint pid; s.GetProcessId(out pid);
        string id = null; try { s.GetSessionInstanceIdentifier(out id); } catch {}
        var v = (ISimpleAudioVolume)s; float l; if (v.GetMasterVolume(out l) != 0) continue;
        string name = "?"; try { name = Process.GetProcessById((int)pid).ProcessName; } catch {}
        r.Add(new Sess { Id = id ?? (pid + "#" + i), Pid = (int)pid, Name = name, Vol = l, V = v });
      } catch {}
    }
    return r;
  }
}
'@
Add-Type -TypeDefinition $code

$own = $PID
$tol = 0.02
$ducked = @{}   # clave id -> @{ pid; name; saved; ducked }

function Round3($x) { [math]::Round([double]$x, 3) }

function Restore-One($sessions, $key, $entry, $restored, $kept) {
  $s = $sessions | Where-Object { $_.Id -eq $key } | Select-Object -First 1
  if (-not $s) { return }   # la sesion desaparecio
  if ([math]::Abs($s.Vol - $entry.ducked) -le $tol) {
    if ($s.Set([float]$entry.saved)) { [void]$restored.Add(@{ pid = $entry.pid; name = $entry.name; saved = (Round3 $entry.saved) }) }
  } else {
    [void]$kept.Add(@{ pid = $entry.pid; name = $entry.name; current = (Round3 $s.Vol) })   # el usuario lo cambio: se respeta
  }
}

function Restore-All($sessions, $restored, $kept) {
  foreach ($k in @($ducked.Keys)) { Restore-One $sessions $k $ducked[$k] $restored $kept }
  $ducked.Clear()
}

function Handle($req) {
  $restored = New-Object System.Collections.ArrayList
  $kept = New-Object System.Collections.ArrayList
  $newly = New-Object System.Collections.ArrayList
  $sessions = @([Duck]::List())
  switch ($req.cmd) {
    'apply' {
      $level = [math]::Max(0.0, [math]::Min(1.0, [double]$req.level))
      $excl = @(); if ($req.exclude) { $excl = @($req.exclude | ForEach-Object { "$_".ToLowerInvariant() }) }
      foreach ($s in $sessions) {
        $skip = ($s.Pid -eq 0) -or ($s.Pid -eq $own) -or ($excl -contains $s.Name.ToLowerInvariant())
        if ($skip) {
          if ($ducked.ContainsKey($s.Id)) { Restore-One $sessions $s.Id $ducked[$s.Id] $restored $kept; $ducked.Remove($s.Id) }
          continue
        }
        if ($ducked.ContainsKey($s.Id)) { continue }
        $target = [float]($s.Vol * $level)
        if ($s.Set($target)) {
          $ducked[$s.Id] = @{ pid = $s.Pid; name = $s.Name; saved = [double]$s.Vol; ducked = [double]$target }
          [void]$newly.Add(@{ pid = $s.Pid; name = $s.Name; saved = (Round3 $s.Vol) })
        }
      }
    }
    'restore' {
      if ($req.entries) {
        foreach ($e in @($req.entries)) {
          $m = $sessions | Where-Object { $_.Pid -eq [int]$e.pid -and $_.Name -eq "$($e.name)" -and ((-not $e.id) -or $_.Id -eq "$($e.id)") }
          foreach ($s in @($m)) { Restore-One $sessions $s.Id @{ pid = $e.pid; name = $e.name; saved = [double]$e.saved; ducked = [double]$e.ducked } $restored $kept }
        }
      } else { Restore-All $sessions $restored $kept }
    }
    'ping' { }
    default { throw "comando desconocido" }
  }
  $list = @()
  foreach ($k in $ducked.Keys) { $d = $ducked[$k]; $list += @{ id = $k; pid = $d.pid; name = $d.name; saved = (Round3 $d.saved); ducked = (Round3 $d.ducked) } }
  return @{ ok = $true; ducked = @($newly); active = $list; restored = @($restored); kept = @($kept) }
}

function Emit($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 6)); [Console]::Out.Flush() }

Emit @{ ok = $true; ready = $true }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  try { Emit (Handle ($line | ConvertFrom-Json)) } catch { Emit @{ ok = $false; error = "$($_.Exception.Message)" } }
}
try { $r = New-Object System.Collections.ArrayList; $k = New-Object System.Collections.ArrayList; Restore-All @([Duck]::List()) $r $k } catch {}

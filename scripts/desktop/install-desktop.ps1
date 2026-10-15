# Instala/actualiza la app de escritorio del Orquestador IA (F7). Correr desde la PowerShell del usuario
# (Windows PowerShell 5.1), NO desde la app de Claude: ahí el menú Inicio quedaría virtualizado por MSIX.
#   powershell -ExecutionPolicy Bypass -File scripts\desktop\install-desktop.ps1
# -AppDir y -NoShortcuts sirven para probar la compilación y el icono en otra carpeta sin tocar accesos directos.
param(
  [string]$AppDir = (Join-Path $env:USERPROFILE '.orquestador-ia\app'),
  [switch]$NoShortcuts
)
$ErrorActionPreference = 'Stop'
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
$repo = (Resolve-Path (Join-Path $here '..\..')).Path

if (Get-Process -Name OrquestadorIA -ErrorAction SilentlyContinue) {
  Write-Host 'OrquestadorIA está corriendo: ciérralo desde la bandeja (Salir) y vuelve a correr este script.' -ForegroundColor Yellow
  exit 1
}

New-Item -ItemType Directory -Force -Path $AppDir, (Join-Path $env:USERPROFILE '.orquestador-ia\logs') | Out-Null
$exe = Join-Path $AppDir 'OrquestadorIA.exe'

# 1. Compilar a un temporal y renombrar (nunca queda un exe a medias), luego self-test.
$tmp = "$exe.$PID.tmp.exe"
try {
  $code = Get-Content -LiteralPath (Join-Path $here 'Launcher.cs') -Raw -Encoding UTF8
  Add-Type -TypeDefinition $code -OutputAssembly $tmp -OutputType WindowsApplication -ReferencedAssemblies @(
    'System.Windows.Forms', 'System.Drawing', 'System.Web.Extensions', 'System.Management', 'System.Net.Http')
  Move-Item -LiteralPath $tmp -Destination $exe -Force
} finally {
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
$out = & $exe --self-test | Out-String  # el pipe hace que PowerShell espere al exe de ventana y capture su salida
Write-Host $out.Trim()
if ($LASTEXITCODE -ne 0) { Write-Host 'El self-test del lanzador falló; no se instala.' -ForegroundColor Red; exit 1 }

# 2. Icono: círculo de color con "OI", 64 px, guardado como ICO (DIB de 32 bits, ver abajo).
Add-Type -AssemblyName System.Drawing
$ico = Join-Path $AppDir 'orquestador.ico'
$bmp = New-Object System.Drawing.Bitmap 64, 64
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 79, 70, 229))), 1, 1, 62, 62)
$font = New-Object System.Drawing.Font 'Segoe UI', 22, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
$g.DrawString('OI', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 0, 64, 64), $fmt)
$g.Dispose()
# ICO con DIB de 32 bits (System.Drawing.Icon de .NET Framework no lee ICO con PNG dentro).
$data = $bmp.LockBits((New-Object System.Drawing.Rectangle 0, 0, 64, 64), 'ReadOnly', 'Format32bppArgb')
$px = New-Object byte[] (64 * 64 * 4)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $px, 0, $px.Length)
$bmp.UnlockBits($data); $bmp.Dispose()
$fs = [System.IO.File]::Create($ico)
$w = New-Object System.IO.BinaryWriter $fs
$size = 40 + $px.Length + 64 * 8
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)                      # ICONDIR: reservado, tipo icono, 1 imagen
$w.Write([byte]64); $w.Write([byte]64); $w.Write([byte]0); $w.Write([byte]0)       # 64x64, sin paleta
$w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$size); $w.Write([uint32]22)
$w.Write([uint32]40); $w.Write([int32]64); $w.Write([int32]128); $w.Write([uint16]1); $w.Write([uint16]32)  # BITMAPINFOHEADER (alto x2: XOR + AND)
$w.Write([uint32]0); $w.Write([uint32]($px.Length + 64 * 8)); $w.Write([int32]0); $w.Write([int32]0); $w.Write([uint32]0); $w.Write([uint32]0)
for ($y = 63; $y -ge 0; $y--) { $w.Write($px, $y * 256, 256) }                    # filas de abajo hacia arriba (BGRA)
$w.Write((New-Object byte[] (64 * 8)))                                             # máscara AND vacía (manda el alfa)
$w.Close()

# 3. launcher.json solo si no existe (es editable por el usuario).
$cfg = Join-Path $AppDir 'launcher.json'
if (-not (Test-Path -LiteralPath $cfg)) {
  $edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
  if (-not (Test-Path -LiteralPath $edge)) { $edge = Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe' }
  [ordered]@{
    repo          = $repo
    port          = 3110
    npmDir        = Join-Path $env:LOCALAPPDATA 'Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\npm'
    edge          = $edge
    notifications = $true
  } | ConvertTo-Json | Set-Content -LiteralPath $cfg -Encoding UTF8
}

# 4. Interfaz: build si ui\dist falta o es más vieja que lo más nuevo de ui\src.
$dist = Join-Path $repo 'ui\dist\index.html'
$newest = Get-ChildItem -LiteralPath (Join-Path $repo 'ui\src') -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not (Test-Path -LiteralPath $dist) -or (Get-Item -LiteralPath $dist).LastWriteTime -lt $newest.LastWriteTime) {
  Write-Host 'Construyendo la interfaz (npm run build:ui)…'
  Push-Location $repo
  try { npm run build:ui; if ($LASTEXITCODE -ne 0) { throw 'npm run build:ui falló' } } finally { Pop-Location }
}

# 5. Accesos directos en el Escritorio (puede ser OneDrive) y en el menú Inicio.
if (-not $NoShortcuts) {
  $shell = New-Object -ComObject WScript.Shell
  foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    $lnk = $shell.CreateShortcut((Join-Path $dir 'Orquestador IA.lnk'))
    $lnk.TargetPath = $exe
    $lnk.WorkingDirectory = $AppDir
    $lnk.IconLocation = "$ico,0"
    $lnk.Description = 'Orquestador IA'
    $lnk.Save()
  }
}
Write-Host "Listo: $exe" -ForegroundColor Green

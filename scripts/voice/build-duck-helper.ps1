# Compila scripts/voice/DuckHelper.cs a un .exe de consola (Windows PowerShell 5.1, csc de .NET Framework).
# Uso: powershell -File build-duck-helper.ps1 -Source <DuckHelper.cs> -Out <duck-helper.exe>
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
# Compila a un temporal y renombra: nunca queda un exe a medias con el nombre final.
$tmp = "$Out.$PID.tmp.exe"
try {
  $code = [System.IO.File]::ReadAllText($Source, [System.Text.Encoding]::UTF8)
  Add-Type -TypeDefinition $code -OutputAssembly $tmp -OutputType ConsoleApplication -ReferencedAssemblies 'System.Web.Extensions'
  Move-Item -LiteralPath $tmp -Destination $Out -Force
} finally {
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}

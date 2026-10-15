<#
.SYNOPSIS
  Copia agy.exe del usuario actual a una carpeta compartida (por defecto C:\tools\agy) para que los
  usuarios de Windows de los trabajadores (agy2, agy3…) lo puedan ejecutar. Volver a correrlo actualiza la copia.
.EXAMPLE
  .\install-agy-shared.ps1 -WhatIf
  .\install-agy-shared.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Source = (Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'),
  [string]$Dest = 'C:\tools\agy'
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
  throw "No encontré agy en '$Source'. Instala Antigravity CLI o pasa -Source <ruta a agy.exe>."
}
$target = Join-Path $Dest 'agy.exe'

if ($PSCmdlet.ShouldProcess($Dest, 'Crear carpeta')) {
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
}
if ($PSCmdlet.ShouldProcess($target, "Copiar $Source")) {
  Copy-Item -LiteralPath $Source -Destination $target -Force
  $a = (Get-Item -LiteralPath $Source).Length
  $b = (Get-Item -LiteralPath $target).Length
  if ($a -ne $b) { throw "La copia quedó incompleta ($b de $a bytes)." }
}
# Lectura y ejecución para Usuarios (SID S-1-5-32-545, funciona en Windows en español o inglés).
if ($PSCmdlet.ShouldProcess($Dest, 'Dar lectura/ejecución a Usuarios (icacls)')) {
  & icacls $Dest /grant '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls falló ($LASTEXITCODE)." }
}
if (-not $WhatIfPreference) {
  Write-Host "Listo: $target ($((Get-Item -LiteralPath $target).Length) bytes)."
}

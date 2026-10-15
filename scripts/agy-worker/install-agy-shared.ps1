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

$meSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($PSCmdlet.ShouldProcess($Dest, 'Crear carpeta y cerrar su ACL (icacls)')) {
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  # Sin herencia: C: da Modify a Usuarios autenticados y cualquier trabajador podría reemplazar agy.exe.
  # Solo Administradores, SYSTEM y quien instala escriben; Usuarios solo leen/ejecutan (SIDs: sirve en es/en).
  & icacls $Dest /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' "*${meSid}:(OI)(CI)F" '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls de la carpeta falló ($LASTEXITCODE)." }
}
if ($PSCmdlet.ShouldProcess($target, "Copiar $Source")) {
  Copy-Item -LiteralPath $Source -Destination $target -Force
  $a = (Get-Item -LiteralPath $Source).Length
  $b = (Get-Item -LiteralPath $target).Length
  if ($a -ne $b) { throw "La copia quedó incompleta ($b de $a bytes)." }
  # Un agy.exe ya existente conserva su ACL vieja al sobrescribirlo: se reinicia para heredar la de la carpeta.
  & icacls $target /reset | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls de agy.exe falló ($LASTEXITCODE)." }
}
if (-not $WhatIfPreference) {
  Write-Host "Listo: $target ($((Get-Item -LiteralPath $target).Length) bytes)."
}

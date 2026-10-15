<#
.SYNOPSIS
  Da de alta un trabajador agy: genera su llave, le pone ACL (usuario actual + usuario del trabajador),
  escribe <cuenta>.json y MUESTRA el comando de la tarea programada para que lo corras tú.
  Este script NO crea usuarios, NO crea la tarea y NO pide contraseñas. La llave nunca se imprime.
.EXAMPLE
  .\register-worker.ps1 -Account agy2 -WindowsUser agy2 -Port 3121
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9-]+$')][string]$Account,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$WindowsUser,
  [Parameter(Mandatory = $true)][ValidateRange(1024, 65535)][int]$Port,
  [string]$Dir = 'C:\ProgramData\orquestador-ia\workers',
  [string]$NodePath = 'C:\Program Files\nodejs\node.exe',
  [string]$WorkerPath,
  # Quien corre el orquestador y debe leer la llave (por defecto, quien corre este script).
  [string]$Owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
# $PSScriptRoot puede venir vacío en param(); se resuelve aquí.
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
if (-not $WorkerPath) { $WorkerPath = Join-Path $here 'worker.mjs' }

if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw "No encontré Node en '$NodePath' (debe estar en una ruta que $WindowsUser pueda leer). Usa -NodePath."
}
$keyPath = Join-Path $Dir "$Account.key"
$jsonPath = Join-Path $Dir "$Account.json"
if ((Test-Path -LiteralPath $keyPath) -and -not $Force) {
  throw "Ya existe la llave de '$Account'. Usa -Force para generar una nueva (el orquestador deberá releerla)."
}
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

# 1) Carpeta cerrada primero (sin herencia): Administradores, SYSTEM y el dueño heredan a los archivos;
#    el usuario del trabajador solo lee la carpeta misma (sin (OI)(CI)), así no hereda las llaves de otras cuentas.
& icacls $Dir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' "${Owner}:(OI)(CI)F" "${WindowsUser}:(RX)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls de la carpeta falló ($LASTEXITCODE). ¿Existen '$Owner' y '$WindowsUser'?" }

if (Test-Path -LiteralPath $keyPath) { Remove-Item -LiteralPath $keyPath -Force }

# 2) Llave escrita sin compartir el handle (FileShare None); 3) ACL final del archivo: dueño, trabajador y SYSTEM.
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$hex = [System.Text.Encoding]::ASCII.GetBytes((-join ($bytes | ForEach-Object { $_.ToString('x2') })))
$fs = [System.IO.File]::Open($keyPath, 'CreateNew', 'Write', 'None')
try { $fs.Write($hex, 0, $hex.Length) } finally { $fs.Dispose() }
Remove-Variable hex, bytes
& icacls $keyPath /inheritance:r /grant:r "${Owner}:F" "${WindowsUser}:R" '*S-1-5-18:F' | Out-Null
if ($LASTEXITCODE -ne 0) {
  Remove-Item -LiteralPath $keyPath -Force -ErrorAction SilentlyContinue
  throw "icacls de la llave falló ($LASTEXITCODE)."
}

$cfg = [ordered]@{ account = $Account; port = $Port; windowsUser = $WindowsUser } | ConvertTo-Json
[System.IO.File]::WriteAllText($jsonPath, $cfg, (New-Object System.Text.UTF8Encoding $false))

Write-Host "Llave creada en $keyPath (solo $Owner, $WindowsUser y SYSTEM pueden leerla)."
Write-Host "Configuración en $jsonPath."
Write-Host ''
Write-Host 'Ahora crea la tarea programada. Abre "Símbolo del sistema" (cmd.exe) COMO ADMINISTRADOR y pega:'
Write-Host '(te pedirá la contraseña de' $WindowsUser '- la guarda Windows, no el orquestador)'
Write-Host ''
Write-Host ('schtasks /Create /TN "orquestador-ia\agy-worker-{0}" /SC ONSTART /RU {1} /RP * /RL LIMITED /F /TR "\"{2}\" \"{3}\" --account {0} --port {4}"' -f $Account, $WindowsUser, $NodePath, $WorkerPath, $Port)

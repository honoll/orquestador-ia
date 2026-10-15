# Varias cuentas de Antigravity (agy) en paralelo — un usuario de Windows por cuenta

Guía de F10 (prueba de concepto). Diseño: `docs/superpowers/specs/2026-10-15-f10-cuentas-agy-paralelo-design.md`.

**Por qué un usuario de Windows por cuenta:** agy guarda su sesión de Google en el Administrador de credenciales de
Windows, en una entrada fija por usuario de Windows. No hay opción de perfil: dos cuentas a la vez solo son posibles
con dos usuarios de Windows. Cada usuario extra corre un **trabajador** (`scripts/agy-worker/worker.mjs`) que escucha
solo en `127.0.0.1` y exige una llave.

> **Riesgo aceptado (decisión tuya):** juntar la cuota de varias cuentas del plan familiar con el agy oficial puede
> ir contra las condiciones de servicio de Google (en sep-2026 hubo baneos por "switchers" de terceros). Esta guía
> no manipula la credencial de agy de ningún usuario: cada usuario hace su propio login normal. Aun así, el riesgo
> de suspensión de las cuentas existe y queda bajo tu responsabilidad.

**Todo lo de esta guía lo corres tú.** El orquestador y sus scripts nunca crean usuarios, nunca crean tareas
programadas y nunca piden ni guardan contraseñas.

Los ejemplos usan la cuenta 2: usuario de Windows `agy2`, cuenta `agy2`, puerto `3121`. Para la cuenta 3 usa
`agy3` y `3122`, y así (+1 por cuenta).

## 1. Copiar agy a una carpeta compartida (una sola vez, y cada que se actualice agy)

Los otros usuarios no pueden leer tu `%LOCALAPPDATA%`. En PowerShell **como administrador**:

```powershell
cd C:\estudio\orquestador-ia\scripts\agy-worker
.\install-agy-shared.ps1 -WhatIf   # muestra lo que haría
.\install-agy-shared.ps1           # copia a C:\tools\agy\agy.exe y da lectura/ejecución a Usuarios
```

Si PowerShell no deja correr scripts: `powershell -ExecutionPolicy Bypass -File .\install-agy-shared.ps1`.

## 2. Crear el usuario local de Windows

Opción A — **Configuración → Cuentas → Otros usuarios → Agregar cuenta → "No tengo los datos de inicio de sesión
de esta persona" → "Agregar un usuario sin cuenta Microsoft"**, nombre `agy2`, con contraseña.

Opción B — en "Símbolo del sistema" **como administrador** (el `*` hace que Windows te pida la contraseña sin
mostrarla):

```cmd
net user agy2 * /add
```

Déjalo como usuario estándar (no administrador). Necesita contraseña: la tarea programada del paso 6 la pide.

## 3. Dar acceso a la carpeta de proyectos

El trabajador corre agy dentro de `C:\estudio`, así que `agy2` necesita modificar ahí. En cmd **como
administrador**:

```cmd
icacls C:\estudio /grant agy2:(OI)(CI)M
```

(Para quitarlo después: `icacls C:\estudio /remove agy2`.)

## 4. Iniciar sesión de Google en agy como `agy2`

```cmd
runas /user:agy2 "C:\tools\agy\agy.exe"
```

`runas` te pide la contraseña de `agy2` y abre agy en una ventana nueva como ese usuario. Ahí haz el login normal
con la **cuenta de Google número 2** (la que vaya a usar este trabajador) y sal de agy cuando termine. La sesión
queda guardada en las credenciales de `agy2`, separada de la tuya.

Si la ventana no abre el navegador para el login: inicia sesión en Windows como `agy2` una vez (cambiar de
usuario), corre `C:\tools\agy\agy.exe`, haz el login y cierra sesión.

## 5. Dar de alta el trabajador (llave y configuración)

En PowerShell **como administrador** (escribe en `C:\ProgramData`):

```powershell
cd C:\estudio\orquestador-ia\scripts\agy-worker
.\register-worker.ps1 -Account agy2 -WindowsUser agy2 -Port 3121
```

El script:
- genera una llave aleatoria en `C:\ProgramData\orquestador-ia\workers\agy2.key` que **solo** tú, `agy2` y SYSTEM
  pueden leer (nunca la imprime);
- escribe `C:\ProgramData\orquestador-ia\workers\agy2.json` con `{ account, port, windowsUser }`;
- **imprime** el comando `schtasks` del paso 6. No lo corre.

La carpeta `workers` queda sin herencia (Administradores, SYSTEM y tú); cada trabajador solo lee su propia
llave. Si abriste la consola de administrador con **otra** cuenta, agrega `-Owner <tu usuario>` para que la llave
sea legible por quien corre el orquestador. Si la llave ya existe se detiene; `-Force` genera una nueva. Node debe estar en `C:\Program Files\nodejs\node.exe`
(o pasa `-NodePath`), en una ruta que `agy2` pueda leer.

## 6. Crear la tarea programada (arranca el trabajador aunque nadie haya iniciado sesión)

Copia el comando que imprimió el paso 5 y pégalo en **"Símbolo del sistema" (cmd.exe) como administrador** (no en
PowerShell: las comillas `\"` solo funcionan bien en cmd). Se ve así:

```cmd
schtasks /Create /TN "orquestador-ia\agy-worker-agy2" /SC ONSTART /RU agy2 /RP * /RL LIMITED /F /TR "\"C:\Program Files\nodejs\node.exe\" \"C:\estudio\orquestador-ia\scripts\agy-worker\worker.mjs\" --account agy2 --port 3121"
```

`/RP *` te pide la contraseña de `agy2`; la guarda Windows (no el orquestador). Luego, en el **Programador de
tareas** → `orquestador-ia` → `agy-worker-agy2` → Propiedades:
- pestaña **Configuración**: desmarca "Detener la tarea si se ejecuta durante más de 3 días";
- pestaña **Condiciones**: desmarca "Iniciar la tarea solo si el equipo está conectado a la corriente alterna".

Si tras reiniciar el trabajador no responde (paso 7), prueba crear la tarea con `/SC ONLOGON` en lugar de
`/SC ONSTART` (arranca cuando inicias sesión tú o cualquier usuario).

Arráncala sin reiniciar:

```cmd
schtasks /Run /TN "orquestador-ia\agy-worker-agy2"
```

## 7. Verificar `/health`

En PowerShell (la llave se lee del archivo y no se muestra en pantalla):

```powershell
$k = (Get-Content C:\ProgramData\orquestador-ia\workers\agy2.key -Raw).Trim()
curl.exe -s -H "Authorization: Bearer $k" http://127.0.0.1:3121/health
Remove-Variable k
```

Esperado: `{"ok":true,"account":"agy2","version":"1","busy":false}`. Sin la llave debe contestar 401:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:3121/health
```

Si no responde: revisa en el Programador de tareas el "Último resultado" de la tarea, que `agy2` pueda leer
`C:\estudio\orquestador-ia\scripts\agy-worker\worker.mjs` (paso 3) y su llave (paso 5), y que el puerto no esté
ocupado (`netstat -ano | findstr :3121`).

## Qué expone el trabajador

Todas las rutas exigen `Authorization: Bearer <llave>` (si no, 401).
- `GET /health` → `{ ok, account, version, busy }`.
- `POST /run` `{ prompt, cwd, model?, readOnly? (true por defecto), timeoutSec? (≤ 1800) }` → NDJSON con los eventos
  de agy (`init`, `step_update`, `result`…), líneas `{"event":"worker:stderr","data":…}` y al final
  `{"event":"worker:done","exitCode":…,"timedOut":…}`. `cwd` debe existir dentro de `C:\estudio` (sin `..` ni
  enlaces que salgan) → si no, 400. Un paso a la vez → 409 si está ocupado. Con `readOnly:false` agy corre con
  `--dangerously-skip-permissions` (igual que el adaptador del orquestador).
- `POST /cancel` → mata el árbol del paso en curso; `{ cancelled: true|false }`.

## Quitar un trabajador

```cmd
schtasks /Delete /TN "orquestador-ia\agy-worker-agy2" /F
icacls C:\estudio /remove agy2
del C:\ProgramData\orquestador-ia\workers\agy2.key C:\ProgramData\orquestador-ia\workers\agy2.json
net user agy2 /delete
```

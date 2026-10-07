# F7 — App de escritorio (lanzador ligero) · diseño

Fecha: 2026-10-07 · Estado: aprobado en conversación · Base: F6 en `main` (merge 96e35fb)

## Hallazgos previos (verificados 2026-10-07)
- Fuera de la app de Claude (PowerShell propia del usuario): `where.exe` encuentra `node` (`C:\Program Files\nodejs\node.exe`)
  y `ffmpeg` (WinGet), pero **no** `claude` ni `codex`: están instalados en el AppData virtualizado por MSIX.
- Sus archivos reales existen en `C:\Users\sidel\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\npm\`
  (`claude.cmd`, `codex.cmd`), visibles desde fuera. Versiones en uso: Claude Code 2.1.292, Codex 0.146.1.
- Sesiones fuera de AppData (visibles): `C:\Users\sidel\.claude` (Claude Code) y
  `C:\Users\sidel\.orquestador-ia\workers\codex` (perfil de trabajador de Codex). agy vive en
  `%LOCALAPPDATA%\agy\bin\agy.exe` (instalado por el usuario, real). Voz en `C:\tools\voz`.
- El menú Inicio (`%APPDATA%\Microsoft\Windows\Start Menu`) está en AppData: lo que se escriba ahí desde la sesión de
  Claude queda virtualizado → la instalación la corre el usuario desde su PowerShell.
- Toolchains: Edge (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`), Firefox, Rust; compilación de C#
  con `Add-Type` de Windows PowerShell 5.1 (C# 5, .NET Framework 4.x) ya probada en F5 (`DuckHelper.cs`).

## Decisiones aprobadas
1. **Alcance (B):** ventana propia + icono en la bandeja; el orquestador sigue corriendo al cerrar la ventana.
   Sin atajo global ni arranque con Windows (fuera de alcance).
2. **Tecnología (1):** lanzador ligero en C# compilado localmente (`Add-Type -OutputAssembly … -OutputType WindowsApplication`)
   + Edge en modo app. Sin descargas.
3. **Binarios (A):** usar las copias existentes de `claude`/`codex` en la carpeta real de MSIX, añadiéndola al `PATH`
   del servidor. Si la carpeta no existe → aviso en la bandeja (no fallo silencioso).

## Experiencia
- Icono "Orquestador IA" en el escritorio y en el menú Inicio. Doble clic → icono en la bandeja y, en unos segundos,
  la ventana (Edge `--app`). Instancia única: un segundo arranque solo trae la ventana al frente.
- Cerrar la ventana no apaga nada. Menú de la bandeja: **Abrir**, **Platicar**, **Notificaciones** (on/off),
  **Reiniciar servidor**, **Ver registro**, **Salir** (apagado ordenado: cierra la plática y guarda su nota,
  restaura el volumen, apaga Whisper). Doble clic en el icono = Abrir.
- Notificaciones de Windows cuando un plan **termina, falla o se pausa** (cuota, presupuesto o guardia); clic → abre la
  ventana en ese plan.
- Perfil propio de Edge en `C:\Users\sidel\.orquestador-ia\edge-app` (permiso de micrófono y tamaño de ventana
  persistentes, separado del Edge personal).
- Avisos en la bandeja si: faltan `claude`/`codex`, falta `ui/dist`, no hay Node, o el servidor no responde en 60 s.

## Arquitectura
**Lanzador `OrquestadorIA.exe`** (`scripts/desktop/Launcher.cs`):
- Mutex con nombre para instancia única; la segunda instancia avisa a la primera (p. ej. por un evento con nombre)
  para que muestre la ventana y termina.
- Servidor: si `GET http://127.0.0.1:3100/api/voice/status` responde → lo **adopta** (no lo apaga al salir). Si no →
  lanza oculto `node <repo>\node_modules\tsx\dist\cli.mjs src\server\index.ts` (equivalente a `npm start`), `cwd` =
  repo, `PATH` = carpeta MSIX de npm + `PATH` actual, salida a `C:\Users\sidel\.orquestador-ia\logs\server.log`
  (rotación a ~5 MB, se conserva un `.1`). Espera hasta 60 s a que responda.
- Ventana: `msedge.exe --app=<url> --user-data-dir=<perfil> --no-first-run`. Abrir/Platicar/notificación: si hay una
  ventana viva de ese perfil (proceso `msedge` con ese `--user-data-dir` y ventana visible), se trae al frente y la
  acción se entrega por el servidor (`POST /api/system/ui-intent {"open":"platicar"|"plan","planId"?}` → evento WS
  `ui:intent` que la UI atiende); si no hay ventana, se abre una nueva con `?platicar=1` o `?plan=<id>`.
- Notificaciones: cliente WebSocket (`System.Net.WebSockets.ClientWebSocket`) a `ws://127.0.0.1:3100/ws`, con
  reconexión; reacciona a `plan:done` (`completed` → "Plan terminado", `failed` → "Plan falló", `pending` con `paused`
  → "Plan pausado por cuota/presupuesto/guardia"). Usa `NotifyIcon.ShowBalloonTip` (toast en Windows 11); el clic abre
  `?plan=<id>`. El título del plan se pide a `GET /api/plans/:id`.
- Salir: `POST /api/system/shutdown` (si el servidor es propio) → espera hasta 10 s a que el proceso termine → si no,
  `taskkill /T /F` del árbol. Si el servidor fue adoptado, solo cierra el lanzador.
- Configuración en `C:\Users\sidel\.orquestador-ia\app\launcher.json` (ruta del repo, puerto, carpeta npm, notificaciones),
  escrita por el instalador y editable.

**Cambios en el orquestador**
- `POST /api/system/shutdown` → responde 202 y ejecuta el mismo apagado ordenado que SIGINT (`shutdownAssistant`,
  ducking restore, `whisper.stop()`), luego `process.exit(0)`. Pasa el `originGuard` (sin `Origin` o local).
- `POST /api/system/ui-intent` `{open:"platicar"|"plan", planId?}` → 202 y broadcast `ui:intent` (mismas validaciones
  JSON/origen que el resto).
- UI: `?platicar=1` abre directamente la vista Platicar; `?plan=<id>` abre ese plan en `PlanView`; el evento `ui:intent`
  hace lo mismo con la ventana ya abierta. Los parámetros se limpian de la URL después de usarse.

**Instalación** `scripts/desktop/install-desktop.ps1` (la corre el usuario desde su PowerShell):
compila `Launcher.cs` a `C:\Users\sidel\.orquestador-ia\app\OrquestadorIA.exe`, genera `orquestador.ico`
(System.Drawing), escribe `launcher.json`, corre `npm run build:ui` si `ui/dist` falta o es más viejo que `ui/src`, y
crea los accesos directos (Escritorio vía `[Environment]::GetFolderPath('Desktop')` — puede ser OneDrive — y menú
Inicio). Idempotente: volver a correrlo actualiza. Si el lanzador está corriendo, pide cerrarlo primero.

## Errores
Sin Node / sin `ui/dist` / sin carpeta npm de MSIX / servidor que no responde → globo en la bandeja con la acción a
seguir (y entrada en el log). El WebSocket caído no detiene el lanzador (reintenta cada 5 s). Un fallo al abrir Edge
→ aviso y abre la URL con el navegador predeterminado.

## Pruebas
Vitest: ruta de apagado (202, llama al apagado inyectado, respeta `originGuard`) y lectura de `?platicar`/`?plan` (lógica
pura en `ui/src/lib`). C#: funciones puras (armar argumentos de node/Edge, `PATH`, texto de notificación desde un evento
JSON, rotación del log) probadas con un pequeño programa de prueba compilado igual que el lanzador. En vivo, desde la
PowerShell del usuario: instalar → doble clic → cerrar ventana (sigue en la bandeja) → plan que use Claude (lo encuentra
fuera de la app de Claude) → notificación al terminar → Platicar desde la bandeja → Salir (sin procesos vivos:
node, whisper-server, duck-helper, agy).

## Fuera de alcance
Atajo de teclado global, arranque con Windows, instalador MSI/firma de código, actualización automática, otros
navegadores para la ventana.

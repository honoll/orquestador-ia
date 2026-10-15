# F7 — App de escritorio · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** `OrquestadorIA.exe`: icono en bandeja + ventana Edge `--app`, arranca/adopta el servidor, notifica planes,
apagado ordenado. Spec: `docs/superpowers/specs/2026-10-07-f7-app-escritorio-design.md`.

**Architecture:** lanzador C# 5 (.NET Framework 4.x, WinForms `NotifyIcon`) compilado con `Add-Type` igual que
`scripts/voice/DuckHelper.cs`; dos rutas nuevas en el servidor; la UI atiende `?platicar=1`, `?plan=<id>` y el evento
WS `ui:intent`.

## Global Constraints
- Sin descargas ni dependencias nuevas.
- Rutas fijas: repo `C:\estudio\orquestador-ia`; datos `%USERPROFILE%\.orquestador-ia`; exe e icono en
  `%USERPROFILE%\.orquestador-ia\app\`; log `%USERPROFILE%\.orquestador-ia\logs\server.log` (rota a 5 MB, guarda `.1`);
  perfil Edge `%USERPROFILE%\.orquestador-ia\edge-app`; carpeta npm de MSIX
  `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\npm` (configurable en `launcher.json`).
- Puerto 3110, host 127.0.0.1. Rutas nuevas pasan `originGuard`, JSON obligatorio (415), body ≤ 1 KB (413).
- Textos en español de México. Tests nunca lanzan procesos reales.
- Cada tarea: TDD donde aplique, `npm test`, `npm run lint` (0 errores), `npm run typecheck`, `npm run build:ui` si toca
  `ui/`. Commits en español + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Rama `f7-app-escritorio`.
- Escribir archivos con Write/Edit (los heredocs rompen `\`).

---

### Task 1: Rutas de sistema y atajos de la UI

**Files:** Create `src/server/routes/system.ts`, `ui/src/lib/intent.ts`; Modify `src/server/index.ts`,
`ui/src/components/Chat.tsx` (y lo mínimo en `ConversationView`/`PlanView` para abrirlos); Tests
`test/server/system-routes.test.ts`, `test/ui/intent.test.ts`.

- `POST /api/system/shutdown` `{}` → 202 `{ ok: true }` y, tras responder (`setTimeout(…, 50)`), ejecuta el MISMO
  apagado que SIGINT. Refactor: extraer en `index.ts` `function shutdown(code)` (shutdownAssistant, whisper.stop,
  closeHelper, `process.exit(code)`) usada por las señales y por la ruta (código 0). La ruta recibe la función por
  inyección (`createSystemRoute({ shutdown })`) para testearla.
- `POST /api/system/ui-intent` `{ open: "platicar" }` | `{ open: "plan", planId: string }` → 202 y
  `broadcast({ type: "ui:intent", open, planId? })`; cualquier otro body → 400.
- `ui/src/lib/intent.ts` (puro): `parseIntentFromSearch(search: string): Intent | null` (`?platicar=1` →
  `{open:"platicar"}`, `?plan=<id>` → `{open:"plan", planId}`; id solo `[A-Za-z0-9-]{1,64}`), `stripIntentParams(url): string`.
- Chat: al montar aplica el intent de la URL y la limpia con `history.replaceState`; escucha `ui:intent` por WS
  (`useWs().subscribe` si existe, si no `lastEvent`) y hace lo mismo. `platicar` abre la vista Platicar como el botón;
  `plan` llama `setActivePlanId(planId)`.
- Tests: 202/400/413/415, shutdown inyectado llamado una vez, broadcast con el payload; parser y strip.
- [ ] Implementar con TDD → checks → commit `feat(escritorio): rutas de sistema y atajos de la UI (F7)` → `git push -u origin f7-app-escritorio`.

### Task 2: Lanzador e instalador

**Files:** Create `scripts/desktop/Launcher.cs`, `scripts/desktop/install-desktop.ps1`,
`scripts/desktop/README.md` (5 líneas: cómo instalar/actualizar).

`Launcher.cs` (C# 5; referencias `System.Windows.Forms`, `System.Drawing`, `System.Web.Extensions`,
`System.Management`, `System.Net.Http`):
- `Main(args)`: `--self-test` → corre `SelfTest()` (asserts sobre las funciones puras; exit 0/1, imprime resultado).
  Mutex `Local\OrquestadorIA`; si ya existe → `EventWaitHandle` `Local\OrquestadorIA.Show` `.Set()` y salir. La
  instancia principal espera ese evento en un hilo y abre la ventana.
- Config `launcher.json` (JavaScriptSerializer): `repo`, `port`, `npmDir`, `edge`, `notifications` (bool).
- Funciones puras (estáticas, en `Core`): `BuildPath(npmDir, currentPath)`; `NodeArgs(repo)` →
  `"node_modules\\tsx\\dist\\cli.mjs" "src\\server\\index.ts"` entre comillas; `EdgeArgs(url, profile)` →
  `--app=<url> --user-data-dir=<profile> --no-first-run`; `NotificationFor(json)` → `(title, text, planId)` o null para
  `plan:done` (`completed` "Plan terminado", `failed` "El plan falló", `pending`+`paused` "Plan pausado por
  cuota|presupuesto|guardia"); `ShouldRotate(size)` (≥ 5 MB).
- Servidor: `GET /api/voice/status` (2 s) → si responde, `adopted = true`. Si no: validar `node` (en PATH), `ui\dist\index.html`,
  `npmDir` (si falta: globo "No encuentro Claude Code/Codex…" pero sigue); rotar log si toca; lanzar
  `cmd.exe /c node <NodeArgs> >> "<log>" 2>&1` oculto (`CreateNoWindow`, `UseShellExecute=false`), cwd repo, `PATH` =
  `BuildPath`. Esperar hasta 60 s a que responda; si no → globo y "Ver registro".
- Ventana: buscar con WMI `msedge.exe` cuyo `CommandLine` contenga `--user-data-dir=<perfil>` y tenga ventana
  (`Process.MainWindowHandle != 0`); si hay → `ShowWindow(SW_RESTORE)` + `SetForegroundWindow` y, para intents,
  `POST /api/system/ui-intent`; si no → `Process.Start(edge, EdgeArgs(url + query))`. Si Edge falla → `Process.Start(url)`.
- Bandeja: `NotifyIcon` con icono `orquestador.ico` (al lado del exe), menú Abrir / Platicar / Notificaciones (check) /
  Reiniciar servidor / Ver registro / Salir; doble clic = Abrir. `BalloonTipClicked` abre el plan del último aviso.
- WS: hilo con `ClientWebSocket` a `ws://127.0.0.1:<port>/ws`, reconexión cada 5 s, mensajes completos (acumular
  frames), `NotificationFor` → `ShowBalloonTip` (en el hilo de UI vía `Control.Invoke`) si `notifications`.
- Salir: si no adoptado → `POST /api/system/shutdown` (JSON `{}`), esperar 10 s a que muera el `cmd` hijo, si no
  `taskkill /T /F /PID`. Si adoptado → solo salir. Reiniciar = Salir del servidor + arrancar (aunque fuera adoptado).

`install-desktop.ps1` (Windows PowerShell 5.1, lo corre el usuario):
- Si hay un proceso `OrquestadorIA` → pedir cerrarlo y salir con código 1.
- Crear `%USERPROFILE%\.orquestador-ia\app` y `logs`; compilar con `Add-Type -TypeDefinition (Get-Content Launcher.cs -Raw)
  -OutputAssembly <app>\OrquestadorIA.exe -OutputType WindowsApplication -ReferencedAssemblies …`; correr
  `OrquestadorIA.exe --self-test` y abortar si falla.
- Generar `orquestador.ico` (System.Drawing: círculo de color con "OI", 64 px) y escribir `launcher.json` si no existe.
- `npm run build:ui` si `ui\dist\index.html` falta o es más viejo que el archivo más nuevo de `ui\src`.
- Accesos directos con `WScript.Shell`: `[Environment]::GetFolderPath('Desktop')` y
  `[Environment]::GetFolderPath('Programs')`, nombre "Orquestador IA", icono el `.ico`.
- [ ] Implementar → compilar desde la sesión con `-OutputAssembly` a una carpeta temporal y correr `--self-test`
  (no instalar accesos directos desde la sesión: el menú Inicio quedaría virtualizado) → commit
  `feat(escritorio): lanzador de bandeja e instalador (F7)` → push.

### Task 3: Verificación en vivo y documentación
- [ ] El usuario corre en SU PowerShell: `powershell -ExecutionPolicy Bypass -File C:\estudio\orquestador-ia\scripts\desktop\install-desktop.ps1`.
- [ ] Doble clic → bandeja + ventana; cerrar ventana → sigue en bandeja; Platicar desde la bandeja; plan con Claude
  (confirma que encuentra `claude` fuera de la app de Claude) → notificación al terminar; Salir → sin `node`,
  `whisper-server`, `duck-helper`, `agy` vivos.
- [ ] Docs: sección `## Desktop app (F7)` en `CLAUDE.md`, `CONTINUAR.md`, nota de Cerebro. Integrar a `main` solo con OK del usuario.

# Orquestador-IA — Continuación y Estado

## F1 — Antigravity (agy), cuentas y medidor · completado 2026-10-06

**Rama:** `f1-antigravity-cuentas`

Lo que se agregó:
- **Adapter agy** (Antigravity) con 4 archivos: meta, detect, execute (NDJSON stdin), parse (stream-json)
- **Tablas** `agy_accounts` (etiqueta, activo, topes manuales 5h/7d, tope calibrado 5h, bloqueo por cuota, notas) y `agy_usage` (account_id, timestamp, tokens, origen: chat|plan|analysis)
- **API** `/api/accounts` (CRUD), `/api/accounts/active` (activa actual + uso), `/api/accounts/switch-terminal` (terminal interactiva agy), `/api/usage/session` (tokens de sesión actual)
- **Medidor estimado:** ventanas de 5h y 7d; límite efectivo = manual si existe, si no calibrado (5h); calibración al primer error de cuota (uso de la ventana 5h se vuelve tope calibrado); bloqueo hasta hora del error + 5h; un éxito posterior limpia el bloqueo
- **Panel de cuentas** (izquierda): listar cuentas, uso por ventana, agregar/cambiar/eliminar/editar topes/cambiar cuenta
- **HUD** (arriba): cuenta activa, uso 5h "~70 % · estimado · reinicia en 2h", aviso si >85% o bloqueado, tokens de sesión
- **Pausa por cuota en planes:** paso agy con error cuota vuelve a `pending` ("Pausado por cuota…"), plan queda `pending`, UI ofrece reintentar tras cambiar de cuenta

Cómo usar:
1. Crear una cuenta en el panel → etiqueta, topes opcionales (manual 5h/7d)
2. Una cuenta debe estar activa (se marca automáticamente la primera)
3. Hacer una tarea agy → se registra su uso en esa cuenta
4. Si se alcanza 85% o hay bloqueo, aparece aviso en HUD y banner en UI
5. "Cambiar cuenta" abre terminal con `agy` interactivo; cerrar sesión, entrar con otra, marcar activa en orquestador
6. Los planes que usan agy se pausan si toca cuota; reintentar tras cambiar de cuenta

Pruebas:
- Suite completa verde: `npm test && npm run lint && npm run typecheck && npm run build:ui`
- API verificada en vivo: llamada agy de 11.6k tokens registrada correctamente en cuenta activa
- UI sin errores en consola

---

## Que es
Un orquestador local de CLIs de IA (Claude Code, Codex CLI, agy/Antigravity) con interfaz web.
Inspirado en PaperClip (https://github.com/paperclipai/paperclip) pero simplificado para uso personal.
El caso de uso principal es desarrollo Flutter + Firebase (POS de taqueria — proyecto COPPER).

## Ubicacion
`C:\estudio\orquestador-ia\`

## Estado actual: FUNCIONAL
Todo lo siguiente ya esta implementado y probado:

### Backend (src/)
- **Server Hono** en puerto 3100 (localhost only, sin auth)
- **3 adapters funcionales**: Claude Code, Codex CLI, agy (Antigravity). Gemini CLI se retiró en F1 (UNSUPPORTED_CLIENT)
- **SQLite** con Drizzle ORM + libsql en `~/.orquestador-ia/data/orquestador.db`
- **WebSocket** para streaming de logs en tiempo real
- **Sistema de conversaciones** — multiples mensajes se agrupan bajo un conversation_id
- **Auto-resume de sesiones** — al continuar una conversacion, busca el session_id del ultimo run del MISMO adapter
- **Stop button / cancel** — POST /api/runs/:id/cancel mata el proceso y marca run como cancelled
- **Filtro de stderr** — solo stdout llega al cliente por WS (stderr se guarda en DB pero no se muestra)
- **Modo /plan** — generacion async: POST devuelve planId inmediatamente, genera en background con streaming WS
- **Plan streaming** — planner.ts extrae text deltas del stream-json de claude, los emite como plan:generating por WS
- **Plan cancel** — cancel-generation (mientras genera) y cancel (mientras ejecuta); ambos con kill()
- **Schema plans.status** — incluye "generating" como estado valido

### Frontend (ui/)
- **React 19 + Vite + Tailwind 4** — tema oscuro
- **3 paneles**: Adapters (izq), Chat (centro), Proyectos (der)
- **Panel de adapters**: click en modelo selecciona adapter+modelo
- **Panel de proyectos**: crear/eliminar proyectos, ver conversaciones, click para abrir, × para borrar
- **Chat**: streaming en vivo, markdown con syntax highlighting, metadata (costo, tokens, session_id)
- **Conversaciones**: historial agrupado, nuevo chat, continuar conversacion existente
- **Stop button** — aparece durante ejecucion, cancela el run activo
- **Command palette** — aparece al escribir `/`, navegable con teclado (↑↓ Tab Enter Esc)
- **PlanView rediseñado**:
  - GeneratingView: muestra streaming del "pensamiento" de claude + iconos de adapters + boton detener
  - FlowDiagram: diagrama horizontal de pasos coloreados por adapter, con animacion en el paso activo
  - StepCard mejorado: streaming con auto-scroll, colores por adapter, resultado expandible
  - Boton "detener" durante ejecucion (llama a cancel endpoint)
  - Transicion automatica generating → step view via WS eventos plan:ready / plan:error
- **GitHub Clone modal** — clona repos (privadas via `gh`, publicas via `git`), streaming WS (github:log), crea proyecto opcional
- **Terminal /run** — ejecuta comandos shell desde el chat, streaming stdout WS (shell:log), boton kill
- **File context picker (📎)** — adjuntar archivos de proyecto, navegacion por directorios, multi-select
- **Pipeline agy → adapter principal**:
  - Cuando hay archivos adjuntos, SIEMPRE pasan primero por agy independientemente del adapter activo
  - POST /api/analyze: corre agy sync, analiza archivos en contexto del prompt, retorna summary
  - El summary de agy se inyecta como "[Análisis de archivos (agy)]..." antes del prompt al adapter principal
  - Indicador visual "◎ agy analizando archivos…" (sky blue) durante la pre-procesamiento
  - Fallback a raw file content si agy falla o no esta disponible
  - Aplica en prompts normales Y en /claude /codex /agy forzados

## Estructura de archivos clave

```
package.json                    — deps: hono, drizzle-orm, @libsql/client, tsx, ws
tsconfig.json                   — ESM, Node 20+

src/
  db/
    schema.ts                   — Drizzle schema: projects, tasks, runs, plans, plan_steps
    index.ts                    — Conexion libsql
    migrate.ts                  — Migracion SQL + backfill conversation_id
  lib/
    types.ts                    — Interfaces: Adapter, AdapterExecutionContext (con onKill callback)
    process-runner.ts           — Spawn con timeout, shell:true en Windows, quoteWindowsArg()
    resolve-command.ts          — Busca comandos en PATH + PATHEXT
  adapters/
    claude/
      index.ts                 — Meta: command "claude", modelos: ver `src/config/models.ts`
      detect.ts                — isCommandAvailable("claude")
      execute.ts               — claude --print - --output-format stream-json --verbose --dangerously-skip-permissions
      parse.ts                 — Parsea stream-json: content_block_delta, result (cost, tokens, session_id)
    codex/
      index.ts                 — Meta: command "codex", modelos: ver `src/config/models.ts`
      detect.ts
      execute.ts               — codex exec --json -m <model> - (prompt por stdin)
      parse.ts                 — Parsea JSONL: item.completed, turn.completed, error/turn.failed
    agy/
      index.ts                 — Meta: command "agy", modelos: ver `src/config/models.ts`
      detect.ts
      execute.ts               — agy.exe directo (shell:false), prompt NDJSON por stdin, stream-json
      parse.ts                 — Parsea stream-json: init, step_update (agent_response), resultado
  server/
    index.ts                   — Hono server, sirve UI desde ui/dist, monta rutas + WS
    runner.ts                  — Orquestador: crea run, spawns adapter, emite logs WS, cancelRun(), historyPrefix
    ws.ts                      — WebSocket broadcast
    planner.ts                 — generatePlan(): streaming onStream/onKillRegistered, extrae text deltas de stream-json
    plan-runner.ts             — runPlanStep() con retry (transient/unknown-session), runPlanAll() secuencial
    routes/
      adapters.ts              — GET /api/adapters (detecta CLIs disponibles)
      projects.ts              — CRUD /api/projects
      tasks.ts                 — CRUD /api/tasks, POST /:id/run, GET /conversations, DELETE /conversation/:id
      runs.ts                  — GET /api/runs, POST /:id/cancel
      plans.ts                 — CRUD /api/plans, POST /:id/run-all, POST /:id/run-next, PATCH /steps/:id
      shell.ts                 — POST /run (ejecuta cmd shell, streaming shell:log WS), POST /:jobId/kill
      github.ts                — POST /clone (gh repo clone o git clone, streaming github:log WS, crea proyecto)
      analyze.ts               — POST /api/analyze (corre agy sync sobre archivos adjuntos, retorna analysis)
  server/
    file-watcher.ts            — fs.watch sobre dir de proyecto durante plan execution; startWatch/stopWatch por planId; debounce 300ms; emite file:change WS events

ui/
  package.json                 — React 19, Vite, Tailwind 4, @tanstack/react-query, react-markdown
  vite.config.ts               — Proxy /api y /ws a localhost:3100
  src/
    main.tsx                   — QueryClient + App
    App.tsx                    — Layout 3 columnas
    context/
      AppStateContext.tsx       — Estado compartido: adapter, model, project, conversationId
      WebSocketProvider.tsx     — WS connection, logs map (keyed por runId Y stepId para plan streaming)
    lib/
      parse-stream.ts          — Parser cliente de JSONL para display en vivo (per-adapter)
    components/
      AdapterPanel.tsx          — Lista CLIs, modelos clickeables
      Chat.tsx                  — Input + command palette + mensajes + streaming + stop button + /plan /run /clone handlers + file context pipeline
      PlanView.tsx              — Vista de plan: StepCard por paso, streaming en vivo, ejecutar/paso-a-paso
      ProjectPanel.tsx          — Proyectos + conversaciones + delete
      GitHubCloneModal.tsx      — Modal clone GitHub: URL input, destino, streaming progreso, crear proyecto
      FileContextPicker.tsx     — Browser de archivos de proyecto, multi-select, buildFileContext()
```

## Como correr
```bash
cd C:\estudio\orquestador-ia
npm install
npm run build:ui        # Compila el frontend
npm start               # Arranca server en http://localhost:3100
```

## CLIs necesarios (deben estar en PATH)
- `claude` — Claude Code CLI (autenticado)
- `codex` — Codex CLI (autenticado con cuenta ChatGPT, NO API key)
- `agy` — Antigravity CLI (autenticado con Google)

## Bugs conocidos ya corregidos
1. **spawn ENOENT en Windows** — `shell: process.platform === "win32"` en process-runner.ts
2. **Codex args con espacios** — prompt por stdin con `-` flag, no como argumento CLI
3. **o3 no soportado con ChatGPT** — modelos actualizados (ver `src/config/models.ts`; gpt-5.4 se quito: no soportado con cuenta ChatGPT)
4. **Cross-adapter session resume** — solo resume sesiones del MISMO adapter
5. **NULL conversation_id** — backfill automatico en migracion
6. **Raw JSON en streaming** — parser no hace fallback a raw JSONL
7. **Titulo de conversacion** — usa el primer mensaje, no el ultimo
8. **Gemini shell quoting en Windows** — quoteWindowsArg() antes de join para cmd.exe
9. **Stderr mezclado en streaming** — WS solo emite chunks con stream="stdout"
10. **plans.ts cancel bug** — `eq(eq(...), eq(...))` corregido a `and(eq(...), eq(...))`
11. **plan:log no llegaba al cliente** — WebSocketProvider acumula plan:log keyed por stepId
12. **--profile no existe en claude CLI** — multi-cuenta OAuth no es posible; infraestructura para API keys preparada (profile-manager.ts, /api/claude-profiles) pero inactiva hasta tener API keys
13. **plan generation bloqueaba UI** — cambiado a async: POST retorna 202 con planId, genera en background, WS emite plan:ready cuando termina
14. **Historial de conversacion no cargaba** — tasks con conversation_id=NULL se buscaban con OR(eq(conversationId,X), eq(id,X))
15. **/plan siempre fallaba** — 4 bugs encadenados resueltos:
    a. SQLite CHECK constraint rechazaba status "generating" → agregado a SCHEMA_SQL y migracion de tabla
    b. quoteWindowsArg() sin flag /g solo escapaba la primera comilla → agregado `g` al regex
    c. --system-prompt con JSON multilinea fallaba en cmd.exe → cambiado a --system-prompt-file con temp file
    d. Race condition: server aceptaba conexiones antes de que migracion terminara → await migrationDone
    e. **FK roto en plan_steps**: ALTER TABLE plans RENAME TO plans_old hace que SQLite actualice automaticamente las FK refs en plan_steps para apuntar a "plans_old"; al borrar plans_old queda FK colgada → migracion ahora detecta y recrea plan_steps con REFERENCES plans(id). Ademas la migracion de plans ahora usa CREATE plans_new + DROP plans + RENAME plans_new→plans para no afectar las FK refs en otras tablas

16. **Codex ejecutaba en read-only sandbox** — `codex exec --json` sin flags extra corre en `sandbox_mode=read-only, approval_policy=never`. Los pasos del plan que asignaban a Codex para implementar codigo corrian, gastaban tokens, pero NO podian crear/editar archivos. Fix: agregado `--full-auto` a los args de codex execute.ts (equivalente a `--dangerously-skip-permissions` de Claude y `-y` de Gemini)
17. **Planes no aparecian en panel de proyectos** — los planes vivian solo en tabla `plans` y el ProjectPanel solo mostraba `tasks/conversations`. Fix: agregado seccion "planes" al ProjectPanel con query a `GET /api/plans?projectId=X`, badge de status, click para abrir PlanView. `activePlanId` movido a AppStateContext para comunicar ProjectPanel→Chat
18. **Plan generation fallaba en proyectos con CLAUDE.md** — el planner corria Claude CLI con `cwd` apuntando al directorio del proyecto, lo que causaba que Claude auto-cargara el CLAUDE.md del proyecto e interfiriera con el system prompt del planner. Fix: planner ahora corre en `os.tmpdir()` — el contexto del proyecto ya esta incluido en el prompt como texto.
19. **Error de plan no se persistia en DB** — cuando la generacion fallaba, el error solo se emitia por WS pero no se guardaba en SQLite, imposibilitando debug posterior. Fix: agregada columna `error_message` a tabla `plans`, migracion automatica, plans.ts guarda el mensaje de error en el catch block, PlanView lo muestra en la pantalla de error.

## Decisiones de diseno
- Single-user, sin auth, bind localhost only
- SQLite en ~/.orquestador-ia/data/orquestador.db
- Claude usa --dangerously-skip-permissions (headless)
- agy corre sin shell (agy.exe directo), prompt NDJSON por stdin
- Codex usa exec --json con prompt por stdin
- Sesiones se persisten para --resume (Claude session_id, Codex thread_id, agy conversation_id)
- WebSocket broadcast a todos los clientes
- Cross-adapter context: se inyecta historial de conversacion como prefijo de texto (solo si no hay session_id nativo)
- Cancel: kill() del proceso hijo, activeKills Map en runner.ts
- Plan routing: claude/codex/agy asignados por tipo de tarea (arquitectura/review vs impl/codegen vs analisis)
- Plan retry: MAX_RETRIES=2, TRANSIENT_RE para 429/503/overloaded, unknown session fallback sin --resume

## Slash commands disponibles en chat
- `/plan <descripcion>` — genera plan multi-agente y abre PlanView
- `/nuevo` — nuevo chat
- `/clear` — limpia historial visual
- `/claude <prompt>` — fuerza adapter Claude para ese mensaje
- `/codex <prompt>` — fuerza adapter Codex para ese mensaje
- `/agy <prompt>` — fuerza adapter agy (Antigravity) para ese mensaje
- `/run <comando>` — ejecuta comando de terminal, muestra output en chat
- `/clone <url>` — abre modal para clonar repositorio de GitHub

## WebSocket events nuevos
- `shell:log` — chunks de stdout de /run, keyed `sh:${jobId}`
- `shell:done` — fin del proceso shell con exitCode
- `github:log` — chunks de stdout del clone, keyed `gh:${jobId}`
- `github:done` — fin del clone con { succeeded, destination, projectId, error }
- `analyze:log` — chunks internos del analisis agy (no consumido por UI, solo info)
- `plan:generating` — chunks de texto del plan generandose, keyed `gen:${planId}`
- `file:change` — archivo modificado durante ejecucion de plan: `{ planId, filePath, content, timestamp }`

## Proximos pasos posibles
- [ ] Mejorar display de errores en chat (mostrar error_message con estilo)
- [ ] Agregar confirmacion antes de borrar conversacion
- [x] Soporte para adjuntar archivos/contexto al prompt (con pipeline agy)
- [ ] Persistir adapter/model seleccionado en localStorage
- [ ] Exportar conversacion como markdown
- [x] Boton cancelar plan en ejecucion (desde PlanView)
- [x] Editar descripcion/adapter de un paso del plan antes de ejecutar
- [x] **Live file preview en PlanView** — fs.watch sobre dir del proyecto durante ejecucion, WS `file:change`, panel derecho con tabs por archivo y line numbers
- [ ] Sintaxis highlighting en file preview (actualmente plain pre)

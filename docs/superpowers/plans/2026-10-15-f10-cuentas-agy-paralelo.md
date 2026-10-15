# F10 — Cuentas de agy en paralelo · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** que agy sea el trabajador principal (código con Claude Opus/Sonnet 4.6 vía Antigravity, lectura con
Gemini Flash) y que los pasos se repartan entre varias cuentas de Antigravity en paralelo, con un trabajador por
usuario de Windows. Spec: `docs/superpowers/specs/2026-10-15-f10-cuentas-agy-paralelo-design.md`.

**Architecture:** `worker.mjs` (Node, sin deps) corre como cada usuario de Windows y expone `127.0.0.1:<puerto>`
con llave; el orquestador guarda los trabajadores en `agy_workers`, elige el de más cuota libre y llama `/run`
(NDJSON) o corre agy local para la cuenta del usuario normal. Compuerta: prueba de concepto con 1 trabajador.

**Tech Stack:** Node 24, Hono, Drizzle/libsql, PowerShell 5.1 para scripts de alta, React UI, vitest.

## Global Constraints
- Rama `f10-agy-cuentas` desde `f8-oficina`. Orden de integración F7 → F8 → F10 → F9.
- Puertos de trabajadores 3121, 3122, 3123 (… +1 por cuenta); solo `127.0.0.1`; `Authorization: Bearer <llave>`;
  llaves en `C:\ProgramData\orquestador-ia\workers\<cuenta>.key` (32 bytes aleatorios en hex); nunca impresas, ni en
  logs, ni en Cerebro.
- agy compartido en `C:\tools\agy\agy.exe` (copia de `%LOCALAPPDATA%\agy\bin\agy.exe`).
- `cwd` de `/run` debe resolver dentro de `C:\estudio` (sin `..`, sin enlaces fuera); tope por paso = `timeoutSec`
  (máx. 1800); un paso a la vez por trabajador (409).
- Nunca: crear usuarios de Windows, tareas programadas, manejar contraseñas, tocar la credencial
  `gemini:antigravity`, cambiar ACL de `C:\estudio` (eso lo hace el usuario con la guía).
- Modelos agy: `claude-opus-4-6-thinking` (código difícil), `claude-sonnet-4-6` (código normal),
  `gemini-3.8-flash-low|medium` (lectura/resumen), `gemini-3.8-flash-high` y `gpt-oss-120b-medium` disponibles.
- Lectores (`writes = 0`) se guardan con `read_only = 1`.
- Cada tarea: TDD, `npm test`, `npm run lint` (0 errores), `npm run typecheck` (+ `npm run build:ui` si toca UI).
  Commits en español + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Write/Edit para archivos.
  Nunca stagear `.superpowers/` ni `AGENTS.md`.

---

### Task 1: Trabajador, scripts y guía (prueba de concepto — parte de código)
**Files:** Create `scripts/agy-worker/worker.mjs`, `scripts/agy-worker/worker-core.mjs` (lógica pura: validar llave en
tiempo constante, validar `cwd`, armar args de agy, máquina "ocupado"), `scripts/agy-worker/install-agy-shared.ps1`,
`scripts/agy-worker/register-worker.ps1` (`-Account <nombre> -WindowsUser <usuario> -Port <n>`: genera la llave,
fija ACL del archivo de llave al usuario actual + ese usuario, escribe `C:\ProgramData\orquestador-ia\workers\<cuenta>.json`
con `{account, port, windowsUser}` y muestra el comando exacto de `schtasks /Create … /RU <usuario> /RP *` para que
el usuario lo corra él — el script NO lo corre), `docs/agy-cuentas-windows.md`, tests `test/agy-worker/*.test.ts`.
- `worker.mjs`: `GET /health` (con llave) → `{ ok, account, version }`; `POST /run` → NDJSON con los eventos de
  agy y un evento final `{event:"worker:done", exitCode}`; `POST /cancel`; sin llave → 401; ocupado → 409; `cwd`
  inválido → 400. Lee su config de `--account` y `--port`, la llave del archivo. Corre `C:\tools\agy\agy.exe` con
  `shell:false`, `windowsHide`, args equivalentes a `buildAgyArgs(model, undefined, {readOnly})`, prompt por stdin
  (`buildAgyStdin`), env sin secretos del orquestador.
- Guía (es-MX, pasos numerados con comandos): crear usuario local (Configuración o `net user` lo corre el usuario),
  `icacls C:\estudio /grant agy2:(OI)(CI)M`, `runas /user:agy2 "C:\tools\agy\agy.exe"` para el login de Google,
  `register-worker.ps1`, crear la tarea programada (comando que imprime el script) y cómo verificar `/health`.
- [ ] Tests de `worker-core` (llave correcta/incorrecta/ausente, `cwd` dentro/fuera/`..`, args readOnly) y del servidor
  con un agy falso (inyectar ruta del ejecutable) → implementar → checks → commit
  `feat(agy-worker): trabajador por usuario de Windows, scripts y guía (F10)` → `git push -u origin f10-agy-cuentas`.

### Task 2: Prueba de concepto en vivo (compuerta)
- [ ] Controlador: correr `install-agy-shared.ps1`; pedir al usuario los pasos de la guía para `agy2` (cuenta 2).
- [ ] Verificar: (a) tras reiniciar sesión/sin sesión de `agy2`, la tarea arranca el trabajador y `/health` responde;
  (b) `/run` con `gemini-3.8-flash-low` contesta (cuenta 2); (c) en paralelo, un `agy` local (cuenta 1) y un `/run`
  (cuenta 2) contestan sin cruzarse; (d) sin llave → 401. Registrar resultados.
- [ ] Si (a) falla: detener y decidir con el usuario (alternativa: trabajador solo con sesión abierta).

### Task 3: Trabajadores en el orquestador y reparto por cuota
**Files:** `src/db/schema.ts` + `src/db/migrate.ts` (tabla `agy_workers`: `id`, `account_id` FK, `port`,
`key_path`, `enabled`, `created_at`), `src/server/agy-workers.ts` (CRUD + `pickWorker(now)` + cliente HTTP NDJSON),
`src/adapters/agy/execute.ts` (rutear al trabajador o local), `src/server/agy-accounts.ts` (registrar uso por cuenta
del trabajador), `src/server/plan-scheduler.ts` (reintento en otra cuenta si `quota_exhausted`; pausa solo si todas
agotadas), rutas `GET/POST/PATCH/DELETE /api/agy-workers` + `GET /api/agy-workers/:id/health`.
- `pickWorker`: entre cuentas `enabled`, no ocupadas, no `quota_blocked_until > now`, la de mayor cuota libre
  estimada (medidor de F1); la cuenta local cuenta como trabajador sin puerto. Devuelve null si ninguna.
- [ ] Tests (selección por cuota, ocupado, bloqueado, todas agotadas → pausa, reintento en otra cuenta, cliente con
  servidor falso, uso registrado en la cuenta correcta) → implementar → checks → commit → push.

### Task 4: Catálogo, reglas de modelo y prompts de agy
**Files:** `src/config/models.ts` (catálogo agy al día), `src/server/planner.ts` (reglas: código difícil → opus-4-6,
normal → sonnet-4-6, lectura → flash low/medium; plantillas de prompt por familia), `src/server/plan-create.ts`
(`read_only = 1` cuando `writes = 0`), tests de planner/plan-create.
- [ ] Tests (prompt del planner lista los modelos nuevos y las reglas; lectores quedan read_only; escritores no) →
  implementar → checks → commit → push.

### Task 5: Oficina y UI de trabajadores
**Files:** `src/server/office-state.ts` (escritorios de AGY por cuenta: `desks` por trabajador ocupado y etiqueta de
cuenta), `ui/src/components/office/*` (etiqueta por escritorio, rack con cuota por cuenta), panel "Trabajadores de
agy" en la columna izquierda (estado/salud/habilitar).
- [ ] Tests de `buildOfficeState` por cuenta → implementar → checks + `build:ui` → captura → commit → push.

### Task 6: Verificación final y documentación
- [ ] Con 3+ cuentas: plan con 3 pasos de lectura en paralelo en 3 cuentas; un paso que agote cuota pasa a otra cuenta.
- [ ] Docs: sección `## Agy workers (F10)` en `CLAUDE.md`, `CONTINUAR.md`, nota de Cerebro. Integrar solo con OK del usuario.

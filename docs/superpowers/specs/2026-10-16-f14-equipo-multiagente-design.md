# F14 — Equipo multiagente (estilo Paperclip) · diseño

Fecha: 2026-10-16 · Estado: aprobado en conversación · Base: `main` (0fdf6a7). Rama: `f14-equipo`.
Siguiente fase: F15 rediseña la barra lateral para este modelo (equipo, agentes, en qué trabaja cada uno, cuentas).

## Qué es
Un modo nuevo, **Equipo**, en el que varios agentes trabajan a la vez sobre una **meta**: el Jefe (Opus) delega
tareas a roles, los agentes crean subtareas y comentan entre ellos por una API local, y cada dueño despierta cuando
pasa algo en su tarea (hijas terminadas, comentario, consulta). Convive con los planes de pasos de F2/F10/F11, que
siguen igual para trabajos cortos, y reutiliza su maquinaria: cuentas agy y leases, cuotas, roles, guardia, marcador
`<<<ESTADO>>>`, oficina en vivo.

## Inspiración: Paperclip (MIT)
Analizado el paquete local `paperclipai` 2026.916.0 (licencia MIT, © 2025 Paperclip AI); notas en
`.superpowers/research/2026-10-16-paperclip-multiagente.md` (fuera de git). Se toma: trabajo en tareas con dueño;
despertares por evento (asignación, comentario, hijas terminadas) con fusión; toma atómica; delegar = crear tarea hija
(opcionalmente bloqueando al padre); el padre despierta con los resúmenes de sus hijas; sesión que se retoma con un
prompt "delta"; token por turno con alcance a su tarea y descendientes; API REST que el agente llama con `curl`;
presupuesto que pausa y cancela la cola. No se toma: organigrama, contrataciones, board de aprobaciones, heartbeat
por reloj, rutinas, políticas de revisión multietapa, la capa de recuperación grande. Si se copia texto de sus
prompts, se conserva el aviso MIT.

## Decisiones aprobadas
1. **Equipo con bandejas**: cada rol (DEV, QA, IMAGEN, INVESTIGADOR, LECTOR, REDACTOR, y el Jefe) es un "empleado"
   con bandeja = sus tareas. Varias tareas de un mismo rol pueden correr a la vez en cuentas distintas.
2. **Convive** con los planes de pasos (no los reemplaza).
3. **Libre con tope**: los agentes crean subtareas sin aprobación humana, dentro de topes por meta y presupuesto;
   la guardia sigue pausando lo riesgoso.
4. **Enfoque A**: sobre las tablas y el scheduler de planes, no un subsistema aparte.
5. **API por `curl`** a media ejecución (no marcadores). Consecuencia aceptada: los roles de solo lectura (LECTOR,
   INVESTIGADOR) no pueden correr comandos en agy, así que entregan con su respuesta pero no delegan ni comentan.
6. **Jefe como agente**: la meta nace con una tarea raíz asignada al Jefe (Opus, adaptador claude); delega, espera
   dormido, despierta con resúmenes y cierra la meta con la respuesta final.

## Modelo de datos (migración sobre SQLite)
- `plans.mode`: `'pasos'` (default, todo lo existente) | `'equipo'`. Para `equipo`: `budget_tokens` (ya existe),
  topes en constantes: `MAX_TAREAS = 30`, `MAX_PROFUNDIDAD = 3`, `MAX_TURNOS_TAREA = 8`.
- `plan_steps` gana (nulos en modo pasos): `parent_step_id`, `depth`, `blocked_by` (JSON de ids de hijas que espera),
  `turns` (turnos consumidos), `account_id` (cuenta del último turno, para retomar sesión ahí),
  `created_by_step_id`. Ya existen `role`, `status`, `session_id`, `result`, `status_detail`, `prompt`.
  Estados de tarea: `pending` (en bandeja, con despertar en cola), `running`, `waiting` (bloqueada por hijas),
  `succeeded`, `failed`, `cancelled`.
- Tabla `team_comments`: `id, plan_id, step_id, author ('humano' | step_id), body (≤ 4000), created_at,
  created_by_run_id`.
- Tabla `team_wakeups`: `id, plan_id, step_id, reason ('asignada'|'comentario'|'hijas_terminadas'|'consulta'|
  'continuar'), payload JSON, status ('en_cola'|'tomado'|'hecho'|'cancelado'), created_at, taken_at`.
- Tabla `team_run_tokens`: `token_hash (sha256), plan_id, step_id, run_id, expires_at`. El token en claro nunca se
  guarda ni se registra.

## Flujo
1. **Crear meta** (`POST /api/equipo/metas {pedido, projectId}` o `/equipo <pedido>` en el chat): plan
   `mode='equipo'`, una tarea raíz `role='jefe'`, adaptador claude, modelo Opus 5.5, y un despertar `asignada`.
2. **Turno**: el scheduler de equipo toma un despertar, arma el prompt (rol + contexto + guía del protocolo, o solo
   el delta si retoma sesión), crea un token, lanza el turno con `runPlanStep` (lease, guardia, roles, estado final).
3. **Delegar**: el agente llama `POST /api/equipo/tareas`; la hija nace `pending` con despertar `asignada`. Con
   `esperar: true` el padre queda `waiting` al terminar su turno (su `<<<ESTADO>>>` debe ser `terminado` o
   `necesita` con detalle "esperando hijas"; el servidor lo pone en `waiting` si tiene hijas sin terminar en
   `blocked_by`).
4. **Hijas terminadas**: cuando todas las hijas de `blocked_by` son terminales, se encola `hijas_terminadas` para el
   padre con sus resúmenes (resultado recortado a 1500 caracteres y estado de cada una).
5. **Comentarios**: un comentario de otro autor (humano u otra tarea) encola `comentario` para el dueño. Un `@rol`
   en el comentario crea una tarea hija de consulta para ese rol (cuenta para los topes); al terminar, el servidor
   publica su resultado como comentario en la tarea que preguntó, lo que despierta a su dueño.
6. **Cierre**: la meta se completa cuando la raíz termina `succeeded`; su resultado es la respuesta final y se escribe
   la nota de plan en Cerebro como en F3b. Si la raíz falla, la meta queda `failed`.

## Protocolo del agente (API local)
Variables de entorno de cada turno: `ORQ_API` (`http://127.0.0.1:<ORQUESTADOR_PORT>`), `ORQ_TAREA` (id de su tarea),
`ORQ_TOKEN` (32 bytes aleatorios en hex; vence al terminar el turno o a las 2 h). Autenticación
`Authorization: Bearer $ORQ_TOKEN`; el token solo puede leer/escribir su tarea y sus descendientes (403 fuera de ese
árbol, 401 si no existe o venció). Rutas (`src/server/routes/equipo-agente.ts`, JSON ≤ 16 KB):
- `GET /api/equipo/tarea` → meta (pedido), su tarea (instrucciones, rol), ancestros (hasta 3, recortados), hijas
  (estado, resumen) y comentarios de su tarea.
- `POST /api/equipo/tareas {rol, titulo, instrucciones, esperar?}` → `{id}`. Rol debe existir; 409 si rebasa
  `MAX_TAREAS`/`MAX_PROFUNDIDAD`, con mensaje para el agente.
- `POST /api/equipo/comentarios {tareaId?, texto}` → `{id}` (por defecto su propia tarea; puede comentar en una hija).
Estas rutas pasan por `originGuard` como todo `/api/*` (desde `curl` no hay `Origin`, así que pasan) y además exigen el token.
La guía del protocolo (comandos `curl` exactos, con PowerShell `Invoke-RestMethod` como alternativa en Windows) se
agrega al prompt de cada rol solo en modo equipo, en `roles/_equipo.md` (editable, con original en `_originales/`).
Los roles de solo lectura reciben una guía corta: "entrega con tu respuesta; no puedes delegar".

## Scheduler de equipo (`src/server/equipo/`)
- `wakeups.ts`: `enqueueWakeup(stepId, reason, payload)` con **fusión** (si hay uno `en_cola` para la tarea, se
  mezcla el payload); `claimWakeup()` con `UPDATE … SET status='tomado' WHERE id=? AND status='en_cola'`; una tarea
  `running` no se toma (el despertar espera).
- `team-scheduler.ts`: bucle por meta activa (como el ActiveRun de F2): toma despertares mientras haya capacidad
  (`parallelLimit()` para agy; el Jefe va por claude local, uno a la vez por meta), revisa presupuesto antes de
  tomar, y al terminar un turno aplica: estado de la tarea, `turns + 1`, `waiting` si espera hijas, despertar al
  padre si todas sus hijas terminaron, cierre de meta si es la raíz.
- **Continuación**: si la tarea ya tiene `session_id`, el turno retoma esa sesión en la misma cuenta (`account_id`;
  si está ocupada, espera) y el prompt es solo el delta (motivo, comentarios nuevos, resúmenes de hijas). Si cambió
  el modelo o la cuenta no está disponible por más de 5 min, sesión nueva con contexto completo.
- `MAX_TURNOS_TAREA`: al llegar, la tarea falla con "demasiados turnos" y despierta a su padre.
- **Presupuesto**: se revisa al encolar y al tomar. Al agotarse: meta `pending` + `pause_reason='budget'`,
  despertares `en_cola` → `cancelado`, evento WS; "continuar" sube el tope a `ceil(1.5 × max(tope, usado))` y
  re-encola un `continuar` para las tareas que tenían despertar cancelado.
- **Guardia**: igual que hoy para tareas que escriben (prompt + contexto); un turno marcado pausa la meta con
  `pause_reason='guard'` y se aprueba en la UI.
- **Reinicio**: al arrancar, turnos `running` de metas de equipo → `pending` con un despertar `continuar`.

## Trabajadores agy (F10)
`scripts/agy-worker/worker-core.mjs` `parseRunBody` acepta `env` (solo claves `ORQ_API`, `ORQ_TAREA`, `ORQ_TOKEN`,
valores ≤ 200 caracteres; cualquier otra clave → 400) y `sessionId` (string ≤ 200) para retomar. El worker pasa esas
variables a agy y `sessionId` a `buildAgyArgs`. Requiere que Alejandro reinicie las 3 tareas programadas
(`schtasks /End` + `/Run`, como admin). Los workers llegan a `127.0.0.1:3110` por loopback (misma máquina).

## UI (mínima; la barra lateral nueva es F15)
- Vista **Equipo** (cuarto botón junto a Chat | Oficina | Roles, mismo bloqueo de Platicar): lista de metas
  (estado, tokens/presupuesto) y, por meta: árbol de tareas (rol, cuenta, estado, turnos, tokens, detalle), hilo de
  comentarios de la tarea seleccionada con caja para comentar (despierta al dueño), botones pausar/continuar/
  cancelar, aprobar guardia, respuesta final en markdown. "Nueva meta" con pedido + proyecto.
- `/equipo <pedido>` en el chat crea la meta y abre la vista Equipo.
- Eventos WS: `team:task` (alta/estado de tarea), `team:comment`, `team:goal` (estado de meta, pausa, cierre).
- Oficina: sin cambios de código salvo que `tagLease` reciba el rol y el plan de la tarea (ya lo hace para pasos),
  así los agentes caminan a su zona.

## Errores
- Tarea `failed` o `bloqueado`/`necesita` sin hijas pendientes: despierta al padre con el detalle; el padre decide.
- Token inválido/vencido → 401; fuera de su árbol → 403; topes → 409 con mensaje; cuerpo inválido → 400.
- Adaptador o worker caído: mismo manejo que F10 (reintento en otra cuenta, sin gastar turno si fue 409/caído).
- Cancelar la meta: mata turnos en curso (como F2), despertares → `cancelado`, tokens revocados.

## Pruebas
- Unitarias: alcance y vencimiento del token (401/403); rutas de la API con topes (409); fusión de despertares y
  espera mientras la tarea corre; padre despierta solo cuando todas sus hijas son terminales; armado del delta;
  `MAX_TURNOS_TAREA`; presupuesto que pausa y cancela la cola; reinicio que re-encola; `parseRunBody` con `env` y
  `sessionId`.
- Integración con adaptador falso: meta con raíz que delega 3 hijas en paralelo, esperar, despertar con resúmenes y
  cerrar.
- En vivo: meta en `C:\estudio\f11-demo` donde el Jefe delegue a DEV, IMAGEN y REDACTOR a la vez y luego a QA;
  verificar paralelo real en cuentas distintas, comentario humano que despierta a un dueño, y cierre con respuesta.

## Fuera de alcance
Barra lateral nueva (F15), heartbeats por reloj y rutinas, organigrama/jerarquía más allá de padre-hija,
contrataciones, aprobaciones humanas de subtareas, documentos y "work products" por tarea, workspaces aislados por
tarea.

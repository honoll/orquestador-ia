# F10 — Cuentas de agy en paralelo (un usuario de Windows por cuenta) · diseño

Fecha: 2026-10-15 · Estado: aprobado en conversación · Base: F8 (`f8-oficina`, con Codex fuera del planner
— `PLANNER_ADAPTERS` por defecto `claude,agy`). Orden de integración: F7 → F8 → F10 → F9.

## Contexto y hallazgos (verificados 2026-10-15)
- El usuario no tiene Codex de pago (`'gpt-5.5' model is not supported when using Codex with a ChatGPT account`)
  y tiene **4 cuentas de Antigravity** (plan familiar). Quiere que agy haga el trabajo de código con prompts
  específicos y usar las 4 cuentas.
- `agy models` hoy: `gemini-3.8-flash-high|medium|low`, `claude-sonnet-4-6` (Thinking), `claude-opus-4-6-thinking`,
  `gpt-oss-120b-medium`. El catálogo del orquestador está desactualizado (lista "Gemini 3.1 Pro", "Sonnet 5.5 vía
  Antigravity").
- `agy --help` no tiene opción de cuenta/perfil. Cambiar `HOME`/`USERPROFILE` crea otra carpeta `.gemini`, pero la
  **sesión no se separa**: agy guarda la credencial en el Administrador de credenciales de Windows en una entrada fija
  (`LegacyGeneric:target=gemini:antigravity`) por usuario de Windows. Por tanto, varias cuentas a la vez solo son
  posibles con **un usuario de Windows por cuenta**.
- agy está instalado por usuario en `%LOCALAPPDATA%\agy\bin\agy.exe` (193 870 488 B); otros usuarios de Windows no
  pueden leer esa carpeta.

## Decisión y riesgo aceptado
- **Opción B (usuario):** varias cuentas en paralelo. Descartados: "simulador"/switcher de credenciales (manipular
  la credencial de agy — prohibido y es lo que causó baneos), y la reescritura automática de credenciales.
- **Riesgo aceptado por el usuario:** juntar la cuota de 4 cuentas del plan familiar con el agy oficial puede ir
  contra las condiciones de Google (hubo baneos en sep-2026 por switchers de terceros). Queda bajo su decisión.

## Arquitectura
1. **agy compartido:** `scripts/agy-worker/install-agy-shared.ps1` copia `%LOCALAPPDATA%\agy\bin\agy.exe` a
   `C:\tools\agy\agy.exe` (permisos de lectura/ejecución para los usuarios de trabajador). Volver a correrlo actualiza.
2. **Trabajador** `scripts/agy-worker/worker.mjs` (Node 24, sin dependencias), uno por usuario de Windows:
   - HTTP solo en `127.0.0.1:<puerto>` (3121, 3122, 3123…); toda petición exige `Authorization: Bearer <llave>`;
     la llave vive en `C:\ProgramData\orquestador-ia\workers\<cuenta>.key` con ACL solo para el usuario dueño del
     orquestador y el usuario de esa cuenta (el script de alta la genera; nunca se imprime ni se registra).
   - `GET /health` → `{ ok, account, version }` (sin llave no responde datos).
   - `POST /run` `{ prompt, model, cwd, readOnly, timeoutSec }` → NDJSON en streaming con los mismos eventos de
     `agy --output-format stream-json`, y el `result` final. Corre `C:\tools\agy\agy.exe` con los mismos argumentos que
     `buildAgyArgs` (`--dangerously-skip-permissions` solo si `readOnly` es falso), `shell:false`, `cwd` validado
     (debe estar dentro de `C:\estudio`), tope de tiempo, un paso a la vez por trabajador (409 si ocupado).
   - `POST /cancel` mata el árbol del proceso en curso.
   - Arranca con una **tarea programada** de Windows que crea el usuario ("ejecutar aunque el usuario no haya
     iniciado sesión"; Windows guarda la contraseña). El orquestador nunca maneja contraseñas.
3. **Orquestador:**
   - Tabla `agy_workers` (`account_id` → `agy_accounts`, `port`, `key_path`, `enabled`); la cuenta del usuario
     normal es el trabajador "local" (sin HTTP, como hoy).
   - El adaptador agy elige trabajador: entre las cuentas habilitadas, libres y no bloqueadas por cuota, la de mayor
     cuota libre estimada (medidor de F1 por cuenta). Si una se agota, el paso se reintenta en otra; el plan solo se
     pausa por cuota si todas están agotadas. El uso se registra en la cuenta que corrió el paso.
   - Paralelismo: hasta `max_parallel` pasos, cada uno en un trabajador distinto.
4. **Modelos y prompts de agy:** catálogo al día (los de `agy models`). El planner elige: código difícil →
   `claude-opus-4-6-thinking`; código normal → `claude-sonnet-4-6`; lectura/búsqueda/resumen →
   `gemini-3.8-flash-low|medium`. Prompts con plantilla por familia (Claude: instrucciones de código precisas,
   archivos, criterios de aceptación; Flash: tarea corta de lectura con formato de salida fijo). Los pasos de lectura
   se guardan con `read_only = 1` (sin `--dangerously-skip-permissions`) — corrige el hallazgo de que los lectores no
   triviales corrían con permisos de escritura.
5. **Oficina/UI:** un escritorio de AGY por cuenta (etiqueta = nombre corto de la cuenta), rack con la cuota de cada
   cuenta, panel de trabajadores (estado, salud, habilitar/deshabilitar).
6. **Guía** `docs/agy-cuentas-windows.md`: crear usuario local, dar acceso a `C:\estudio`, iniciar agy "como ese
   usuario" (`runas /user:agy2 …`) y hacer login con su cuenta de Google, correr el alta del trabajador (llave +
   registro), crear la tarea programada.

## Prueba de concepto (compuerta)
Antes de construir el resto: agy compartido + trabajador + 1 usuario (`agy2`) creado por el usuario. Verificar en
vivo: (a) el trabajador arranca con la tarea programada **sin** sesión iniciada de `agy2` y agy lee su credencial
(punto más dudoso); (b) responde con la cuenta 2; (c) dos pasos simultáneos (cuenta 1 local + cuenta 2 trabajador)
sin cruzarse; (d) sin llave → 401. Si (a) falla, alternativa a decidir con el usuario: el trabajador corre solo con
la sesión de ese usuario abierta (cambio rápido de usuario).

## Seguridad
Solo 127.0.0.1 + llave por trabajador; `cwd` restringido a `C:\estudio`; tope de tiempo; la guardia de F4 sigue
aplicando a pasos que escriben; llaves y tabla de trabajadores nunca en Cerebro ni en logs; nunca se manipulan
credenciales de agy ni contraseñas de Windows.

## Pruebas
Vitest: selección de trabajador (cuota, ocupado, bloqueado, reintento en otra cuenta), cliente HTTP del trabajador
con servidor falso, validación de `cwd`/llave/409 en el trabajador (lógica pura extraída), catálogo y reglas de
modelo del planner, `read_only` en lectores. En vivo: la prueba de concepto y, al final, un plan con 3 pasos en 3
cuentas.

## Fuera de alcance
Switchers o manipulación de credenciales; crear usuarios de Windows o tareas programadas desde el orquestador;
rotación automática fuera del reparto por cuota descrito.

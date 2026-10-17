# Modo equipo: tareas acotadas para gastar menos tokens de agy — diseño

Fecha: 2026-10-16. Rama: `equipo-acotar-tareas` (desde `main` 5bdeae6). Aprobado por Alejandro en el brainstorming.

## Problema

En la meta `7d492911` (16-oct-2026) cada turno de agy gastó 118–147k tokens de **entrada** contra 5–30k de salida,
y las 4 cuentas se agotaron en ~25 min. Causas vistas en las instrucciones que escribió el Jefe:

- Tareas enormes: un módulo completo (Telegram, 8 entregables) en una sola tarea DEV; un LECTOR con 11 archivos de
  agentes + 78 issues + 5 JSON y una entrega de "máx ~2500 palabras".
- "Lee CLAUDE.md de la raíz antes de empezar": ese archivo pesa 121 KB (~30k tokens) y agy cuenta de nuevo todo el
  contexto en cada llamada interna, así que se paga varias veces por turno.
- Nada obliga al Jefe a decir qué leer ni qué tan larga es la entrega.

## Decisiones (brainstorming)

1. **Prompts + campos obligatorios** (no solo prompts).
2. **REDACTOR pasa a `gemini-3.8-flash-medium`**; los demás modelos se quedan (LECTOR/INVESTIGADOR ya son Flash; DEV
   y QA siguen en Sonnet; `dificil` no existe en modo equipo y así se queda).
3. **Aviso a 60 000 tokens de entrada por turno**, dentro del resumen de la hija que el Jefe ya recibe (no un
   comentario: un comentario despierta al Jefe y le cuesta un turno extra).

## Diseño

### 1. Campos obligatorios al delegar (`src/server/equipo/tasks.ts`, `createChildTask`)

`POST /api/equipo/tareas` acepta y **exige** (salvo las consultas `@rol`, `opts.consulta`):

- `leer`: arreglo de 1 a `LEER_MAX_ITEMS` (10) textos no vacíos de ≤ `LEER_ITEM_MAX` (200) caracteres: rutas o
  secciones exactas (`src/slug.mjs`, `CLAUDE.md § Team mode (F14)`, `src/x.ts:40-90`).
- `entrega`: texto no vacío de ≤ `ENTREGA_MAX` (300) caracteres: formato y largo ("5 viñetas, máx 150 palabras").

Faltan o son inválidos → `TeamError(400, …)` con un mensaje que dice qué falta y un ejemplo corto, para que el Jefe
corrija y reintente. Sin migración: se guardan en `plan_steps.prompt` agregados a las instrucciones:

```
<instrucciones>

LEE SOLO:
- src/slug.mjs
- CLAUDE.md § Team mode (F14)

ENTREGA: 5 viñetas, máx 150 palabras.
```

Así la vista Equipo, `GET /tarea` y el prompt del turno ya los muestran sin más cambios. El límite
`INSTRUCCIONES_MAX` sigue aplicando solo a `instrucciones`; el cuerpo total ya está topado por `CUERPO_MAX`.

### 2. Regla de alcance en cada turno de hija (`src/server/equipo/prompts.ts`)

`buildTurnPrompt` agrega a todo turno completo que **no** sea del Jefe (escriba o sea de solo lectura) un bloque fijo
`REGLA_ALCANCE`:

> Lee solo lo que dice LEE SOLO. Busca con grep_search y lee rangos de líneas; no abras archivos grandes completos
> (CLAUDE.md, lockfiles, dist/, node_modules/) ni recorras el proyecto. Si de verdad te falta algo, lee lo mínimo y
> dilo en tu entrega. Respeta el largo de ENTREGA.

Se decide con un campo nuevo `alcance?: boolean` en `TurnInput` (el scheduler lo pone en `step.role !== JEFE_ROL`).
Los turnos retomados no lo repiten (ya está en la sesión).

### 3. Textos

- `JEFE_BODY`: cada tarea lleva **una** pregunta o **un** entregable; siempre `leer` y `entrega`; lo de leer/resumir
  va a LECTOR (Flash), no a DEV/REDACTOR; nunca pedir "lee CLAUDE.md" entero, solo la sección; si una tarea
  necesitaría leer más de ~10 archivos o hacer más de un entregable, se parte en varias; da en `instrucciones` el
  contexto que ya sabes (rutas, decisiones) para que la hija no lo busque.
- `GUIA_MINIMA` y `roles/_equipo.md` (+ `roles/_originales/_equipo.md`): recetas Bash/PowerShell con `leer` y
  `entrega`, y una regla: al delegar, `leer` con rutas exactas y `entrega` con formato y largo.
- `roles/{lector,investigador,redactor,dev,qa,imagen}.md` (+ originales): en "Qué haces" se cambia "recorres la
  estructura" por leer lo que indica la tarea; en "Cómo entregas" un tope de largo si la tarea no da otro.
- `roles/redactor.md` (+ original): `modelo: gemini-3.8-flash-medium`. **Efecto lateral aceptado:** los roles se
  comparten con los planes por pasos (F11), donde REDACTOR también pasa a Flash.

### 4. Aviso de gasto (`childSummary` en `tasks.ts`, constante `TOPE_TOKENS_TURNO = 60_000` en `constants.ts`)

Si `step.inputTokens > TOPE_TOKENS_TURNO`, el resumen de la hija termina con
` · AVISO: su último turno gastó N tokens de entrada (tope 60 000): acota más (leer, entrega) la próxima vez.`
Lo ven el Jefe (al despertar con `hijas_terminadas` y en turnos completos), `GET /tarea` y la respuesta a una
consulta. No corta ni pausa nada.

## Pruebas (vitest)

- `createChildTask`: rechaza (400) sin `leer`, con `leer` vacío/no arreglo/demasiados/ítem largo, sin `entrega` o
  larga; acepta y guarda el prompt compuesto; una consulta `@rol` no los exige.
- Ruta agente `POST /tareas` 400 sin los campos.
- `buildTurnPrompt`: `REGLA_ALCANCE` aparece en turno completo de hija (escriba y solo lectura), no en el Jefe ni al
  retomar.
- `childSummary`: con `inputTokens` 60 001 lleva el aviso; con 60 000 o null no.
- Las llamadas existentes de prueba a `createChildTask` se actualizan con `leer`/`entrega`.

## Medición (prueba en vivo)

Servidor de prueba `:3111` (nunca el `:3110` de uso diario), proyecto `C:\estudio\f11-demo`, la misma meta dos
veces: con `main` (antes) y con la rama (después). Se comparan tokens de entrada/salida por turno (`plan_steps`,
`runs`, `agy_usage`), total de la meta y si la meta se completó con calidad equivalente.

## Fuera de alcance

Cortar un turno a la mitad (agy solo reporta uso al final), `dificil` en modo equipo, cambiar DEV/QA de modelo,
cambios en la UI.

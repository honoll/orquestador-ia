# F15 — Barra lateral de equipo · diseño

Fecha: 2026-10-16 · Estado: aprobado en conversación · Base: `main` (7a5b4d9, F14 integrada). Rama: `f15-barra-equipo`.

## Qué es
La barra lateral izquierda deja de ser "elige adapter → modelo" y pasa a mostrar **el equipo en vivo**: un renglón por
rol con lo que hace ahora y su bandeja (trabajando, en cola, esperando), más un resumen compacto de cuentas. Lo de
administración que hoy vive en la barra se muda a una vista nueva **AJUSTES**. La elección de adapter/modelo para el chat
directo se queda en los selectores que ya tiene el propio chat.

## Decisiones aprobadas
1. **Propósito: equipo en vivo.** Arriba, un renglón por rol (Jefe + roles de `roles/`); abajo, cuentas en compacto.
   La lista de adapters y modelos sale de la barra.
2. **Clic en un rol despliega su bandeja**: trabajando, en cola y esperando hijas, de todas las metas de equipo y planes
   de pasos activos. Clic en una tarea: meta de equipo → vista Equipo en esa meta; plan de pasos → el plan en Chat.
3. **Administración en una vista AJUSTES** (quinta pestaña: CHAT · OFICINA · EQUIPO · ROLES · AJUSTES).
4. **Enfoque A:** un endpoint del servidor junta las bandejas (una consulta, incluye lo que está en cola).

## Barra lateral nueva (de arriba abajo)
1. **EQUIPO** — un renglón por rol, en este orden: Jefe, luego los roles de `loadRoles()` (orden del archivo), y al
   final "otros" solo si hay pasos activos sin rol. Cada renglón: marca de color del rol (`roleColor`; el Jefe usa el
   color de `ROLES.jefe` de la Oficina), nombre, indicador (`trabajando ×N` | `en cola N` | `libre`) y, si trabaja,
   una línea con la primera tarea en curso: "cuenta · título" (título recortado con elipsis).
   Clic → despliega/pliega la bandeja del rol (varios pueden estar abiertos; se recuerda en `localStorage`
   `orquestador.barra.abiertos`, con try/catch). La bandeja lista tres grupos (los vacíos no se muestran):
   TRABAJANDO, EN COLA, ESPERANDO HIJAS; cada tarea es un botón con título, meta/plan (recortado) y cuenta.
   - Tarea de meta de equipo → `setView("equipo")` y la vista Equipo abre esa meta y selecciona esa tarea.
   - Paso de plan de pasos → `setActivePlanId(planId)` + `setView("chat")`.
   - Respeta el bloqueo de Platicar (`viewLocked`): con la plática abierta, el clic no cambia de vista.
2. **CUENTAS** (solo lectura, compacto):
   - Una fila por **bolsa** de agy (`groupByPool` ya existe en la Oficina): etiqueta, % usado de 5 h y "⛔" si está
     bloqueada; la cuenta activa (local) marcada.
   - **Claude**: uso real de 5 h (lo que hoy muestra `AdapterUsage` de `AdapterPanel`, `/api/usage/summary?adapter=claude&windowHours=5`).
   - **Codex**: uso del orquestador de 5 h (misma ruta con `adapter=codex`).
   - Botón "AJUSTES" que abre la vista AJUSTES.

## Vista AJUSTES
Reúne, sin reescribir, los componentes que hoy están en la barra, en paneles con títulos:
- **Cuentas de Antigravity**: `AccountsPanel` (alta, baja, topes, cambiar cuenta).
- **Trabajadores de agy**: `WorkersPanel` (probar, activar) — hoy en la Oficina; en la Oficina se queda también.
- **Claude**: la parte de "segunda cuenta" de `AdapterPanel` (`ClaudeProfiles`) extraída a su propio componente.
- **Codex**: `WorkerIsolationNotice` (login del perfil del trabajador).
- **Memoria**: `MemoryStatus` (reindexar).
- Lo demás de `AdapterPanel` que no es selección de modelo (estado de caveman, si se muestra hoy) se conserva aquí.
`AdapterPanel` como lista de adapters/modelos se retira de la app (sus piezas útiles se extraen; nada de la UI de
selección de modelo se pierde porque el chat tiene sus selectores).

## Servidor: `GET /api/equipo/bandejas`
Router propio `src/server/routes/bandejas.ts` (lógica en `src/server/equipo/bandejas.ts`), montado en
`/api/equipo/bandejas` en `src/server/index.ts` antes de `app.route("/api/equipo", …)` (el router del agente solo
define `/tarea`, `/tareas`, `/comentarios`, así que no chocan). Sin token: es lectura para la UI, como `/api/office/state`. Respuesta:

```ts
interface BandejaTarea {
  id: string; planId: string; modo: "pasos" | "equipo"; titulo: string; meta: string; // pedido de la meta o descripción del plan
  cuenta: string | null; desde: string | null; // startedAt para trabajando; createdAt aproximado para cola
}
interface Bandeja { rol: string; nombre: string; trabajando: BandejaTarea[]; enCola: BandejaTarea[]; esperando: BandejaTarea[] }
// GET → Bandeja[] en el orden de la barra (jefe, roles, "otros" si hay)
```

Reglas:
- **Activo** = metas de equipo con estado no terminal (`pending` o `running`, pausadas incluidas) y planes de pasos
  `running` o con `pause_reason`. Planes de pasos `pending` sin pausa (aún no corridos) no cuentan.
- **trabajando** = paso/tarea `running`. **esperando** = tarea de equipo `pending` cuyo `blocked_by` tiene hijas sin
  terminar (`estadoTarea === "esperando"`). **enCola** = el resto de `pending`.
- Rol del renglón: `plan_steps.role` (`jefe` para la raíz de equipo); sin rol → "otros".
- `cuenta`: etiqueta de `agy_accounts` por `plan_steps.account_id` (F14 lo escribe en cada intento agy, en ambos modos);
  `claude`/`codex` cuando el adaptador es ese; null si no se sabe.
- Tope de 20 tareas por grupo y rol (las más recientes primero); el conteo total por grupo se devuelve aparte
  (`total: { trabajando, enCola, esperando }`) para mostrar "y N más".
- Consultas: una lectura de planes activos + una de sus pasos (no N+1).

## Refresco y errores
- La barra usa `useQuery(["bandejas"])` y `useQuery` de cuentas/uso existentes. Invalida `["bandejas"]` con eventos
  `plan:*` y `team:*` con freno de 300 ms (mismo patrón throttle que la Oficina, no debounce).
- Si la consulta falla: aviso "sin conexión — mostrando la última foto" en la sección EQUIPO; se conserva lo último.
- Vista AJUSTES: los componentes conservan su manejo de errores actual.

## Pruebas
- Servidor: agrupación por rol (equipo y pasos), solo trabajo activo, "esperando" derivado, "otros" para sin rol,
  tope de 20 con totales, orden de la barra, cuenta resuelta.
- UI (lógica pura): orden de renglones, indicador (`trabajando ×N` / `en cola N` / `libre`), destino del clic
  (equipo vs pasos), lectura/escritura tolerante de `localStorage`.
- En vivo: barra con el equipo trabajando en una meta (renglones cambian en vivo, bandeja desplegable, clic lleva a
  la tarea), cuentas compactas, vista AJUSTES con todo lo que antes estaba en la barra funcionando (probar trabajador,
  reindexar memoria, segunda cuenta de Claude visible).

## Fuera de alcance
Reordenar roles a mano, acciones sobre tareas desde la barra (comentar, cancelar), métricas históricas, cambiar el
diseño de la Oficina o de la vista Equipo (salvo abrir una meta/tarea concreta).

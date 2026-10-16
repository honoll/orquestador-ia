# F15 — Barra lateral de equipo · plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** la barra lateral izquierda muestra el equipo en vivo (un renglón por rol con su bandeja) y las cuentas en compacto; la administración que hoy vive ahí se muda a una vista AJUSTES.

**Architecture:** un endpoint `GET /api/equipo/bandejas` agrupa en una sola consulta el trabajo activo por rol (metas de equipo y planes de pasos). La UI lo pinta en `TeamSidebar` con refresco por WebSocket (freno de 300 ms). `AdapterPanel` se desarma: su medidor de uso y la segunda cuenta de Claude se extraen a componentes propios; la selección de modelo queda solo en los selectores del chat.

**Tech Stack:** Hono, drizzle + libsql, vitest, React 19 + TanStack Query. Sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-10-16-f15-barra-equipo-design.md` · **Rama:** `f15-barra-equipo`.

## Global Constraints

- Sin dependencias nuevas. No cambia el comportamiento de planes, metas, Oficina ni vista Equipo (salvo abrir una meta/tarea concreta desde la barra).
- Orden de la barra: Jefe, luego los roles de `loadRoles()` (su orden), y "otros" al final solo si tiene tareas.
- Activo = metas de equipo `pending`/`running` (pausadas incluidas) y planes de pasos `running` o con `pause_reason`.
- Grupos: `trabajando` (`running`), `esperando` (tarea de equipo con hijas esperadas sin terminar), `enCola` (resto de `pending`). Tope de 20 por grupo y rol, más recientes primero, con `total` por grupo.
- Indicador del renglón: `trabajando ×N` | `en cola N` | `esperando hijas` | `libre` (en ese orden de prioridad).
- Refresco de la barra: eventos `plan:*` y `team:*` con freno de 300 ms (throttle, no debounce).
- Clic en tarea: meta de equipo → vista Equipo en esa meta y tarea; plan de pasos → plan en Chat. Respeta `viewLocked` (Platicar).
- Bandejas abiertas en `localStorage["orquestador.barra.abiertos"]` con try/catch.
- Estilo F9: texto VT323 nunca menor de 16 px; etiquetas pequeñas en `font-pixel`; clases `px-*`.
- UI y mensajes en español de México. Importaciones del servidor con `.js`; las de `ui/` sin sufijo.
- Commits en español con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; nunca stagear `.superpowers/` ni `AGENTS.md`.
- Al cerrar cada tarea: `npm test`, `npm run lint` (0 errores), `npm run typecheck`, y `npm run build:ui` si tocó `ui/`. Flakes de tiempo conocidos que rotan: `agy-worker-client` (kill), `process-runner-kill`, `plan-runner-roles` (salidas): si falla uno, repetir y reportar por nombre.

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/server/equipo/bandejas.ts` | `buildBandejas()`: trabajo activo por rol |
| `src/server/routes/bandejas.ts` + `src/server/index.ts` | `GET /api/equipo/bandejas` |
| `ui/src/components/AdapterUsage.tsx` | medidor de uso de 5 h (extraído de `AdapterPanel`) |
| `ui/src/components/ClaudeProfiles.tsx` | segunda cuenta de Claude (extraído de `AdapterPanel`) |
| `ui/src/components/AjustesView.tsx` | vista AJUSTES |
| `ui/src/lib/barra.ts` | lógica pura de la barra |
| `ui/src/components/sidebar/TeamSidebar.tsx` | barra nueva (EQUIPO + CUENTAS) |
| `ui/src/context/AppStateContext.tsx`, `ui/src/components/equipo/EquipoView.tsx` | abrir una meta/tarea concreta |
| `ui/src/lib/office-view.ts`, `ui/src/components/HudBar.tsx`, `ui/src/App.tsx` | vista `ajustes`, barra nueva, retiro de `AdapterPanel` |

---

### Task 1: Endpoint de bandejas

**Files:**
- Create: `src/server/equipo/bandejas.ts`
- Create: `src/server/routes/bandejas.ts`
- Modify: `src/server/index.ts` (montaje)
- Test: `test/server/equipo-bandejas.test.ts`

**Interfaces:**
- Consumes: `estadoTarea`, `StepRow` (`src/server/equipo/tasks.ts`); `JEFE_ROL` (`constants.ts`); `loadRoles` (`src/server/roles.ts`); `schema.plans`, `schema.planSteps`, `schema.agyAccounts`.
- Produces: `MAX_POR_GRUPO = 20`, `OTROS = "otros"`, `interface BandejaTarea { id; planId; modo: "pasos" | "equipo"; titulo; meta; cuenta: string | null; desde: string | null }`, `interface Bandeja { rol; nombre; trabajando: BandejaTarea[]; enCola: BandejaTarea[]; esperando: BandejaTarea[]; total: { trabajando: number; enCola: number; esperando: number } }`, `buildBandejas(): Promise<Bandeja[]>`; `createBandejasRoute(): Hono` montado en `/api/equipo/bandejas`.

- [ ] **Step 1: Prueba que falla**

Create `test/server/equipo-bandejas.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { eq } = await import("drizzle-orm");
const { createGoal, createChildTask } = await import("../../src/server/equipo/tasks.js");
const { createAccount } = await import("../../src/server/agy-accounts.js");
const { loadRoles } = await import("../../src/server/roles.js");
const { buildBandejas, MAX_POR_GRUPO } = await import("../../src/server/equipo/bandejas.js");
const { createBandejasRoute } = await import("../../src/server/routes/bandejas.js");

beforeAll(async () => { await migrationDone; });

const S = schema.planSteps;
async function pasos(status: "running" | "pending", pauseReason: "quota" | null, description: string) {
  const id = randomUUID();
  await db.insert(schema.plans).values({ id, description, status, pauseReason });
  return id;
}
async function paso(planId: string, extra: Partial<typeof S.$inferInsert>) {
  const id = randomUUID();
  await db.insert(S).values({ id, planId, stepIndex: 0, description: "paso", adapter: "agy", prompt: "p", status: "pending", ...extra });
  return id;
}

describe("bandejas por rol", () => {
  it("agrupa trabajo activo de metas y planes por rol, en el orden de la barra", async () => {
    const acc = await createAccount("Cuenta B");
    const { planId: meta, rootStepId } = await createGoal({ pedido: "Meta X" });
    const dev = (await createChildTask(meta, rootStepId, { rol: "dev", titulo: "Código", instrucciones: "i", esperar: true })).id;
    await db.update(S).set({ status: "running", accountId: acc.id, startedAt: "2026-10-16T10:00:00.000Z" }).where(eq(S.id, dev));
    await createChildTask(meta, rootStepId, { rol: "redactor", titulo: "Textos", instrucciones: "i" });
    const plan = await pasos("running", null, "Plan P");
    await paso(plan, { role: "qa", status: "running", accountId: acc.id, description: "Probar", startedAt: "2026-10-16T10:05:00.000Z" });
    await paso(plan, { role: null, adapter: "claude", description: "Viejo sin rol" });
    const noCorrido = await pasos("pending", null, "Plan sin correr");
    await paso(noCorrido, { role: "dev", description: "No cuenta" });
    const pausado = await pasos("pending", "quota", "Plan pausado");
    await paso(pausado, { role: "lector", description: "En cola por pausa" });
    const cerrada = await createGoal({ pedido: "Meta cerrada" });
    await db.update(schema.plans).set({ status: "completed" }).where(eq(schema.plans.id, cerrada.planId));

    const out = await buildBandejas();
    expect(out.map((b) => b.rol)).toEqual(["jefe", ...loadRoles().map((r) => r.id).filter((id) => id !== "jefe"), "otros"]);
    const by = Object.fromEntries(out.map((b) => [b.rol, b]));
    expect(by.jefe.nombre).toBe("Jefe");
    expect(by.jefe.total).toEqual({ trabajando: 0, enCola: 0, esperando: 1 });
    expect(by.jefe.esperando[0]).toMatchObject({ id: rootStepId, modo: "equipo", meta: "Meta X", cuenta: "claude" });
    expect(by.dev.total).toEqual({ trabajando: 1, enCola: 0, esperando: 0 });
    expect(by.dev.trabajando[0]).toMatchObject({ id: dev, titulo: "Código", cuenta: "Cuenta B", desde: "2026-10-16T10:00:00.000Z", planId: meta });
    expect(by.redactor.enCola).toHaveLength(1);
    expect(by.qa.trabajando[0]).toMatchObject({ modo: "pasos", meta: "Plan P", cuenta: "Cuenta B" });
    expect(by.lector.enCola[0]).toMatchObject({ titulo: "En cola por pausa", modo: "pasos" });
    expect(by.otros.enCola[0]).toMatchObject({ titulo: "Viejo sin rol", cuenta: "claude" });
  });

  it("tope de 20 por grupo con el total completo", async () => {
    // Base nueva por archivo, pero esta prueba corre después de la anterior: se mide solo el rol 'investigador'.
    const { planId, rootStepId } = await createGoal({ pedido: "Muchas" });
    for (let i = 0; i < 25; i++) await createChildTask(planId, rootStepId, { rol: "investigador", titulo: `t${i}`, instrucciones: "i" });
    const inv = (await buildBandejas()).find((b) => b.rol === "investigador")!;
    expect(inv.enCola).toHaveLength(MAX_POR_GRUPO);
    expect(inv.total.enCola).toBe(25);
  });

  it("la ruta devuelve el arreglo", async () => {
    const r = await createBandejasRoute().request("/");
    expect(r.status).toBe(200);
    expect(Array.isArray(await r.json())).toBe(true);
  });
});
```

Run: `npx vitest run test/server/equipo-bandejas.test.ts` → FAIL (módulos no existen).

- [ ] **Step 2: `src/server/equipo/bandejas.ts`**

```ts
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { loadRoles } from "../roles.js";
import { estadoTarea, type StepRow } from "./tasks.js";
import { JEFE_ROL } from "./constants.js";

export const MAX_POR_GRUPO = 20;
export const OTROS = "otros";

export interface BandejaTarea {
  id: string; planId: string; modo: "pasos" | "equipo"; titulo: string; meta: string; cuenta: string | null; desde: string | null;
}
type Grupo = "trabajando" | "enCola" | "esperando";
export interface Bandeja {
  rol: string; nombre: string; trabajando: BandejaTarea[]; enCola: BandejaTarea[]; esperando: BandejaTarea[];
  total: Record<Grupo, number>;
}

const P = schema.plans, S = schema.planSteps;
const GRUPOS: Grupo[] = ["trabajando", "enCola", "esperando"];
const vacia = (rol: string, nombre: string): Bandeja => ({ rol, nombre, trabajando: [], enCola: [], esperando: [], total: { trabajando: 0, enCola: 0, esperando: 0 } });
// Más recientes primero; las que no han arrancado (sin `desde`) al final.
const recientes = (a: BandejaTarea, b: BandejaTarea) => (b.desde ?? "").localeCompare(a.desde ?? "");

function grupoDe(step: StepRow, hijas: StepRow[] | null): Grupo {
  if (step.status === "running") return "trabajando";
  return hijas && estadoTarea(step, hijas) === "esperando" ? "esperando" : "enCola";
}

/** Trabajo activo por rol para la barra (F15): metas de equipo abiertas y planes de pasos corriendo o pausados. */
export async function buildBandejas(): Promise<Bandeja[]> {
  const filas: Bandeja[] = [vacia(JEFE_ROL, "Jefe"), ...loadRoles().filter((r) => r.id !== JEFE_ROL).map((r) => vacia(r.id, r.nombre))];
  const porRol = new Map(filas.map((b) => [b.rol, b]));
  const otros = vacia(OTROS, "Otros");

  const planes = await db.select().from(P).where(or(
    and(eq(P.mode, "equipo"), inArray(P.status, ["pending", "running"])),
    and(eq(P.mode, "pasos"), or(eq(P.status, "running"), isNotNull(P.pauseReason))),
  ));
  if (planes.length) {
    const planPorId = new Map(planes.map((p) => [p.id, p]));
    const pasos = await db.select().from(S).where(inArray(S.planId, [...planPorId.keys()]));
    const hijasDe = new Map<string, StepRow[]>();
    for (const s of pasos) if (s.parentStepId) hijasDe.set(s.parentStepId, [...(hijasDe.get(s.parentStepId) ?? []), s]);
    const cuentas = [...new Set(pasos.map((s) => s.accountId).filter((x): x is string => !!x))];
    const etiqueta = new Map(
      (cuentas.length ? await db.select({ id: schema.agyAccounts.id, label: schema.agyAccounts.label }).from(schema.agyAccounts).where(inArray(schema.agyAccounts.id, cuentas)) : [])
        .map((a) => [a.id, a.label]),
    );
    for (const s of pasos) {
      if (s.status !== "pending" && s.status !== "running") continue;
      const plan = planPorId.get(s.planId)!;
      const grupo = grupoDe(s, plan.mode === "equipo" ? hijasDe.get(s.id) ?? [] : null);
      const b = (s.role ? porRol.get(s.role) : undefined) ?? otros;
      b.total[grupo]++;
      b[grupo].push({
        id: s.id, planId: s.planId, modo: plan.mode, titulo: s.description, meta: plan.description,
        cuenta: s.adapter === "agy" ? (s.accountId ? etiqueta.get(s.accountId) ?? null : null) : s.adapter,
        desde: s.startedAt ?? null,
      });
    }
  }
  const salida = GRUPOS.some((g) => otros.total[g] > 0) ? [...filas, otros] : filas;
  for (const b of salida) for (const g of GRUPOS) b[g] = b[g].sort(recientes).slice(0, MAX_POR_GRUPO);
  return salida;
}
```

- [ ] **Step 3: `src/server/routes/bandejas.ts` y montaje**

```ts
import { Hono } from "hono";
import { buildBandejas } from "../equipo/bandejas.js";

/** GET /api/equipo/bandejas: trabajo activo por rol para la barra lateral (lectura para la UI, sin token). */
export function createBandejasRoute() {
  const app = new Hono();
  app.get("/", async (c) => c.json(await buildBandejas()));
  return app;
}
```

En `src/server/index.ts`, junto a los imports de rutas de equipo: `import { createBandejasRoute } from "./routes/bandejas.js";`. Entre `app.route("/api/equipo/metas", createEquipoRoute());` y `app.route("/api/equipo", createEquipoAgenteRoute(kickTeam));`:

```ts
app.route("/api/equipo/bandejas", createBandejasRoute());
```

- [ ] **Step 4: Verificar y commit**

Run: `npx vitest run test/server/equipo-bandejas.test.ts` → PASS; `npm test`, `npm run lint`, `npm run typecheck`.

```bash
git add src/server/equipo/bandejas.ts src/server/routes/bandejas.ts src/server/index.ts test/server/equipo-bandejas.test.ts
git commit -m "F15: GET /api/equipo/bandejas (trabajo activo por rol)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Vista AJUSTES y piezas extraídas de `AdapterPanel`

**Files:**
- Create: `ui/src/components/AdapterUsage.tsx` (mover desde `AdapterPanel.tsx`: `UsageSummary`, `fetchUsage`, `formatTimeLeft`, `TOKEN_BUDGETS`, `AdapterUsage`)
- Create: `ui/src/components/ClaudeProfiles.tsx` (mover desde `AdapterPanel.tsx`: `ProfileStatus`, `fetchProfiles`, `ClaudeProfiles`)
- Create: `ui/src/components/AjustesView.tsx`
- Modify: `ui/src/components/AdapterPanel.tsx` (importa las piezas movidas; se borra en Task 3)
- Modify: `ui/src/lib/office-view.ts` (`View`, `VIEWS`), `ui/src/components/HudBar.tsx`, `ui/src/App.tsx`
- Test: `test/ui/equipo.test.ts` (un caso nuevo de `readView`)

**Interfaces:**
- Produces: `export function AdapterUsage({ adapter }: { adapter: string })` en `components/AdapterUsage.tsx`; `export function ClaudeProfiles()` en `components/ClaudeProfiles.tsx`; `export function AjustesView()`; `View` incluye `"ajustes"`.

- [ ] **Step 1: Prueba que falla**

En `test/ui/equipo.test.ts`, dentro del `describe` existente, agrega:

```ts
  it("la vista 'ajustes' se puede pedir por ?vista= y guardar", () => {
    expect(readView("?vista=ajustes", null)).toBe("ajustes");
    expect(readView("", "ajustes")).toBe("ajustes");
  });
```

Run: `npx vitest run test/ui/equipo.test.ts` → FAIL.

- [ ] **Step 2: Extraer `AdapterUsage` y `ClaudeProfiles`**

Mueve **sin cambiar su código** (corta y pega) de `ui/src/components/AdapterPanel.tsx`:
- A `ui/src/components/AdapterUsage.tsx`: la interfaz `UsageSummary`, `fetchUsage`, `formatTimeLeft`, `TOKEN_BUDGETS` y la función `AdapterUsage`, ahora `export function AdapterUsage`. Imports que necesita: `useState, useEffect, useRef` de react y `useQuery` de `@tanstack/react-query`.
- A `ui/src/components/ClaudeProfiles.tsx`: la interfaz `ProfileStatus`, `fetchProfiles` y la función `ClaudeProfiles`, ahora `export function ClaudeProfiles`. Imports: los hooks de react que use y `useQuery, useMutation, useQueryClient`.

En `AdapterPanel.tsx` importa `{ AdapterUsage } from "./AdapterUsage"` y `{ ClaudeProfiles } from "./ClaudeProfiles"` y quita los imports que ya no use.

- [ ] **Step 3: Vista `ajustes`**

`ui/src/lib/office-view.ts`:

```ts
export type View = "chat" | "oficina" | "roles" | "equipo" | "ajustes";
```

y `const VIEWS: readonly string[] = ["chat", "oficina", "roles", "equipo", "ajustes"];`.

`ui/src/components/HudBar.tsx`: el arreglo del selector pasa a `(["chat", "oficina", "equipo", "roles", "ajustes"] as View[])` y la etiqueta:

```tsx
            {v === "chat" ? "CHAT" : v === "oficina" ? "OFICINA" : v === "equipo" ? "EQUIPO" : v === "roles" ? "ROLES" : "AJUSTES"}
```

- [ ] **Step 4: `ui/src/components/AjustesView.tsx`**

```tsx
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AccountsPanel } from "./AccountsPanel";
import { WorkerIsolationNotice } from "./WorkerIsolationNotice";
import { MemoryStatus } from "./MemoryStatus";
import { ClaudeProfiles } from "./ClaudeProfiles";
import { WorkersPanel } from "./office/WorkersPanel";

function Seccion({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section aria-label={titulo} className="px-panel bg-surface-1 p-3">
      <h2 className="mb-2 font-pixel text-[12px] text-text-secondary">{titulo}</h2>
      {children}
    </section>
  );
}

function Caveman() {
  const { data } = useQuery({
    queryKey: ["caveman-status"],
    queryFn: () => fetch("/api/caveman/status").then((r) => r.json() as Promise<{ active: boolean; mode: string }>),
  });
  if (!data?.active) return null;
  return <p className="mt-2 text-text-secondary">caveman activo: {data.mode}</p>;
}

/** Vista AJUSTES (F15): lo que antes vivía en la barra lateral, sin reescribirlo. */
export function AjustesView() {
  return (
    <div className="@container h-full overflow-y-auto bg-surface-0 p-3 text-text-primary">
      <div className="grid gap-3 @3xl:grid-cols-2">
        <Seccion titulo="CUENTAS DE ANTIGRAVITY"><AccountsPanel /></Seccion>
        <WorkersPanel />
        <Seccion titulo="CLAUDE"><ClaudeProfiles /><Caveman /></Seccion>
        <Seccion titulo="CODEX"><WorkerIsolationNotice /></Seccion>
        <Seccion titulo="MEMORIA"><MemoryStatus /></Seccion>
      </div>
    </div>
  );
}
```

`WorkersPanel` ya trae su propio marco (`Panel`); si `WorkerIsolationNotice` no renderiza nada cuando no aplica, la sección CODEX debe mostrar al menos "perfil de Codex listo" — revisa el componente y, si devuelve `null`, envuelve con un texto de respaldo dentro de la sección (`<WorkerIsolationNotice />` seguido de una línea en `text-text-tertiary` que diga "Sin avisos del perfil de Codex.").

`ui/src/App.tsx`: importa `{ AjustesView } from "./components/AjustesView"` y debajo de `{view === "equipo" && <EquipoView />}`:

```tsx
          {view === "ajustes" && <AjustesView />}
```

(En esta tarea la barra lateral sigue igual; Task 3 la reemplaza.)

- [ ] **Step 5: Verificar y commit**

Run: `npx vitest run test/ui`, `npm run lint`, `npm run typecheck`, `npm run build:ui`.

```bash
git add ui/src/components/AdapterUsage.tsx ui/src/components/ClaudeProfiles.tsx ui/src/components/AjustesView.tsx ui/src/components/AdapterPanel.tsx ui/src/lib/office-view.ts ui/src/components/HudBar.tsx ui/src/App.tsx test/ui/equipo.test.ts
git commit -m "F15: vista AJUSTES y medidor de uso / segunda cuenta de Claude como componentes propios

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Barra lateral de equipo

**Files:**
- Create: `ui/src/lib/barra.ts`
- Create: `ui/src/components/sidebar/TeamSidebar.tsx`
- Modify: `ui/src/context/AppStateContext.tsx` (`equipoFocus`)
- Modify: `ui/src/components/equipo/EquipoView.tsx` (aplica `equipoFocus`)
- Modify: `ui/src/App.tsx` (barra nueva)
- Delete: `ui/src/components/AdapterPanel.tsx`
- Test: `test/ui/barra.test.ts`

**Interfaces:**
- Consumes: `GET /api/equipo/bandejas` (Task 1); `AdapterUsage` (Task 2); `accountsApi.list`, `groupByPool`, `viewLocked`; `roleColor` (`ui/src/lib/roles.ts`); `useWs().subscribe` (devuelve la función para desuscribirse).
- Produces (`ui/src/lib/barra.ts`): tipos `BandejaTarea`, `Bandeja` (iguales a Task 1); `indicador(b: Bandeja): { texto: string; tone: "run" | "wait" | "idle" }`; `lineaActual(b: Bandeja): string | null`; `type Destino = { view: "equipo"; metaId: string; tareaId: string } | { view: "chat"; planId: string }`; `destino(t: BandejaTarea): Destino`; `ABIERTOS_KEY`; `leerAbiertos(raw: string | null): string[]`; `alternar(abiertos: string[], rol: string): string[]`; `colorRol(rol: string): string`; `refrescaBarra(type: string): boolean`. AppState: `equipoFocus: { metaId: string; tareaId: string } | null`, `setEquipoFocus(f: { metaId: string; tareaId: string } | null): void`.

- [ ] **Step 1: Prueba que falla**

Create `test/ui/barra.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { alternar, colorRol, destino, indicador, leerAbiertos, lineaActual, refrescaBarra, type Bandeja, type BandejaTarea } from "../../ui/src/lib/barra";

const t = (extra: Partial<BandejaTarea> = {}): BandejaTarea => ({ id: "s1", planId: "p1", modo: "equipo", titulo: "Código", meta: "Meta", cuenta: "agy3", desde: null, ...extra });
const b = (total: Bandeja["total"], trabajando: BandejaTarea[] = []): Bandeja => ({ rol: "dev", nombre: "DEV", trabajando, enCola: [], esperando: [], total });

describe("barra de equipo (lógica)", () => {
  it("indicador por prioridad: trabajando > en cola > esperando > libre", () => {
    expect(indicador(b({ trabajando: 2, enCola: 3, esperando: 1 }))).toEqual({ texto: "trabajando ×2", tone: "run" });
    expect(indicador(b({ trabajando: 0, enCola: 3, esperando: 1 }))).toEqual({ texto: "en cola 3", tone: "wait" });
    expect(indicador(b({ trabajando: 0, enCola: 0, esperando: 1 }))).toEqual({ texto: "esperando hijas", tone: "wait" });
    expect(indicador(b({ trabajando: 0, enCola: 0, esperando: 0 }))).toEqual({ texto: "libre", tone: "idle" });
  });

  it("línea actual: cuenta · título de la primera tarea en curso", () => {
    expect(lineaActual(b({ trabajando: 1, enCola: 0, esperando: 0 }, [t()]))).toBe("agy3 · Código");
    expect(lineaActual(b({ trabajando: 1, enCola: 0, esperando: 0 }, [t({ cuenta: null })]))).toBe("— · Código");
    expect(lineaActual(b({ trabajando: 0, enCola: 0, esperando: 0 }))).toBeNull();
  });

  it("destino: meta de equipo abre la vista Equipo en esa tarea; plan de pasos abre el plan en Chat", () => {
    expect(destino(t())).toEqual({ view: "equipo", metaId: "p1", tareaId: "s1" });
    expect(destino(t({ modo: "pasos" }))).toEqual({ view: "chat", planId: "p1" });
  });

  it("bandejas abiertas tolerantes a basura; alternar abre y cierra", () => {
    expect(leerAbiertos('["dev","qa"]')).toEqual(["dev", "qa"]);
    expect(leerAbiertos("no json")).toEqual([]);
    expect(leerAbiertos('{"a":1}')).toEqual([]);
    expect(leerAbiertos(null)).toEqual([]);
    expect(alternar(["dev"], "qa")).toEqual(["dev", "qa"]);
    expect(alternar(["dev", "qa"], "dev")).toEqual(["qa"]);
  });

  it("colores y eventos que refrescan", () => {
    expect(colorRol("jefe")).toBe("#a78bfa");
    expect(colorRol("dev")).toBe("#60a5fa");
    expect(refrescaBarra("team:task")).toBe(true);
    expect(refrescaBarra("plan:step")).toBe(true);
    expect(refrescaBarra("voice:assistant:delta")).toBe(false);
  });
});
```

Run: `npx vitest run test/ui/barra.test.ts` → FAIL.

- [ ] **Step 2: `ui/src/lib/barra.ts`**

```ts
// Barra lateral de equipo (F15): tipos de /api/equipo/bandejas y lógica pura.
import { roleColor } from "./roles";
import { ROLES } from "./office";

export interface BandejaTarea {
  id: string; planId: string; modo: "pasos" | "equipo"; titulo: string; meta: string; cuenta: string | null; desde: string | null;
}
export interface Bandeja {
  rol: string; nombre: string; trabajando: BandejaTarea[]; enCola: BandejaTarea[]; esperando: BandejaTarea[];
  total: { trabajando: number; enCola: number; esperando: number };
}

export function indicador(b: Bandeja): { texto: string; tone: "run" | "wait" | "idle" } {
  if (b.total.trabajando) return { texto: `trabajando ×${b.total.trabajando}`, tone: "run" };
  if (b.total.enCola) return { texto: `en cola ${b.total.enCola}`, tone: "wait" };
  if (b.total.esperando) return { texto: "esperando hijas", tone: "wait" };
  return { texto: "libre", tone: "idle" };
}

export function lineaActual(b: Bandeja): string | null {
  const t = b.trabajando[0];
  return t ? `${t.cuenta ?? "—"} · ${t.titulo}` : null;
}

export type Destino = { view: "equipo"; metaId: string; tareaId: string } | { view: "chat"; planId: string };
export const destino = (t: BandejaTarea): Destino =>
  t.modo === "equipo" ? { view: "equipo", metaId: t.planId, tareaId: t.id } : { view: "chat", planId: t.planId };

export const ABIERTOS_KEY = "orquestador.barra.abiertos";
export function leerAbiertos(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}
export const alternar = (abiertos: string[], rol: string): string[] =>
  abiertos.includes(rol) ? abiertos.filter((r) => r !== rol) : [...abiertos, rol];

export const colorRol = (rol: string): string => (rol === "jefe" ? ROLES.jefe.color : roleColor(rol));
export const refrescaBarra = (type: string): boolean => type.startsWith("plan:") || type.startsWith("team:");
```

- [ ] **Step 3: `equipoFocus` en `AppStateContext.tsx` y `EquipoView.tsx`**

En `AppStateContext.tsx`:
- En `interface AppState` agrega:
  ```ts
  /** F15: la barra pide a la vista Equipo abrir esta meta y tarea. */
  equipoFocus: { metaId: string; tareaId: string } | null;
  setEquipoFocus: (f: { metaId: string; tareaId: string } | null) => void;
  ```
- En el valor por defecto del contexto: `equipoFocus: null, setEquipoFocus: () => {},`.
- En `AppStateProvider`: `const [equipoFocus, setEquipoFocus] = useState<{ metaId: string; tareaId: string } | null>(null);` y pasa ambos en el `value` del proveedor (junto a los demás campos).

En `EquipoView.tsx`, después de las declaraciones de `metaId`/`tareaId`/`error`:

```tsx
  const { equipoFocus, setEquipoFocus } = useAppState();
  // F15: la barra lateral pide abrir una meta y tarea concretas.
  useEffect(() => {
    if (!equipoFocus) return;
    setMetaId(equipoFocus.metaId);
    setTareaId(equipoFocus.tareaId);
    setError(null);
    setEquipoFocus(null);
  }, [equipoFocus, setEquipoFocus]);
```

(Si `EquipoView` ya desestructura `useAppState()`, agrega `equipoFocus, setEquipoFocus` a esa misma desestructuración en lugar de una segunda llamada.)

- [ ] **Step 4: `ui/src/components/sidebar/TeamSidebar.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWs } from "../../context/WebSocketProvider";
import { useAppState } from "../../context/AppStateContext";
import { accountsApi } from "../../lib/accounts-api";
import { groupByPool, viewLocked } from "../../lib/office-view";
import { ABIERTOS_KEY, alternar, colorRol, destino, indicador, leerAbiertos, lineaActual, refrescaBarra, type Bandeja, type BandejaTarea } from "../../lib/barra";
import { AdapterUsage } from "../AdapterUsage";

const TONE = { run: "text-blue", wait: "text-warn", idle: "text-text-tertiary" } as const;
const GRUPOS = [["trabajando", "TRABAJANDO"], ["enCola", "EN COLA"], ["esperando", "ESPERANDO HIJAS"]] as const;

async function fetchBandejas(): Promise<Bandeja[]> {
  const r = await fetch("/api/equipo/bandejas");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function EquipoSection() {
  const qc = useQueryClient();
  const { subscribe } = useWs();
  const { view, talkActive, setView, setActivePlanId, setEquipoFocus } = useAppState();
  const bandejas = useQuery({ queryKey: ["bandejas"], queryFn: fetchBandejas, refetchInterval: 30_000, retry: 1 });
  const [abiertos, setAbiertos] = useState<string[]>(() => {
    try { return leerAbiertos(localStorage.getItem(ABIERTOS_KEY)); } catch { return []; }
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsub = subscribe((ev) => {
      if (!refrescaBarra(ev.type) || timer.current) return;
      // Freno de 300 ms (no debounce): una ráfaga de eventos no deja la barra congelada.
      timer.current = setTimeout(() => {
        timer.current = null;
        void qc.invalidateQueries({ queryKey: ["bandejas"] });
      }, 300);
    });
    return () => { unsub(); if (timer.current) clearTimeout(timer.current); timer.current = null; };
  }, [subscribe, qc]);

  const toggle = (rol: string) => setAbiertos((prev) => {
    const next = alternar(prev, rol);
    try { localStorage.setItem(ABIERTOS_KEY, JSON.stringify(next)); } catch { /* almacenamiento bloqueado */ }
    return next;
  });

  const abrir = (t: BandejaTarea) => {
    const d = destino(t);
    if (viewLocked(d.view, view, talkActive)) return;
    if (d.view === "equipo") setEquipoFocus({ metaId: d.metaId, tareaId: d.tareaId });
    else setActivePlanId(d.planId);
    setView(d.view);
  };

  return (
    <section aria-label="Equipo">
      <p className="mb-1 font-pixel text-[11px] text-text-secondary">EQUIPO</p>
      {bandejas.isError && <p role="alert" className="mb-1 text-err">sin conexión — mostrando la última foto</p>}
      <ul>
        {(bandejas.data ?? []).map((b) => {
          const ind = indicador(b);
          const abierto = abiertos.includes(b.rol);
          const linea = lineaActual(b);
          return (
            <li key={b.rol}>
              <button aria-expanded={abierto} className="flex w-full items-start gap-2 px-1 py-1 text-left hover:bg-white/10" onClick={() => toggle(b.rol)}>
                <span aria-hidden="true" className="mt-1.5 h-2.5 w-2.5 shrink-0" style={{ background: colorRol(b.rol) }} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-pixel text-[11px]" style={{ color: colorRol(b.rol) }}>{b.nombre.toUpperCase()}</span>
                    <span className={`font-pixel text-[10px] ${TONE[ind.tone]}`}>{ind.texto}</span>
                  </span>
                  {linea && <span className="block truncate text-text-secondary" title={linea}>{linea}</span>}
                </span>
              </button>
              {abierto && (
                <div className="mb-1 ml-5 border-l-2 border-edge pl-2">
                  {GRUPOS.map(([g, label]) => (b[g].length ? (
                    <div key={g}>
                      <p className="font-pixel text-[10px] text-text-tertiary">
                        {label}{b.total[g] > b[g].length ? ` · y ${b.total[g] - b[g].length} más` : ""}
                      </p>
                      <ul>
                        {b[g].map((t) => (
                          <li key={t.id}>
                            <button className="w-full truncate py-0.5 text-left hover:bg-white/10" title={`${t.titulo} — ${t.meta}`} onClick={() => abrir(t)}>
                              {t.titulo}<span className="text-text-tertiary"> · {t.cuenta ?? "—"}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null))}
                  {ind.tone === "idle" && <p className="text-text-tertiary">sin tareas</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CuentasSection() {
  const { view, talkActive, setView } = useAppState();
  const { data: accounts = [] } = useQuery({ queryKey: ["accounts"], queryFn: accountsApi.list, refetchInterval: 60_000 });
  const pools = groupByPool(accounts.map((a) => ({
    id: a.id, label: a.label, active: a.active, pool: a.pool, quotaBlockedUntil: a.quotaBlockedUntil, poolShortPct: a.poolUsage?.short.pct ?? a.usage.short.pct,
  })));
  return (
    <section aria-label="Cuentas">
      <p className="mb-1 font-pixel text-[11px] text-text-secondary">CUENTAS</p>
      <ul>
        {pools.map((p) => (
          <li key={p.key} className="flex items-center justify-between gap-2">
            <span className="truncate">{p.accounts.some((a) => a.active) ? "● " : ""}{p.accounts.map((a) => a.label).join(", ")}</span>
            <span className={p.blocked ? "text-err" : "text-text-secondary"}>{p.blocked ? "⛔" : p.pct !== null ? `${p.pct}%` : "—"}</span>
          </li>
        ))}
        {pools.length === 0 && <li className="text-text-tertiary">sin cuentas de agy</li>}
      </ul>
      <p className="mt-2 font-pixel text-[10px] text-text-tertiary">CLAUDE</p>
      <AdapterUsage adapter="claude" />
      <p className="mt-2 font-pixel text-[10px] text-text-tertiary">CODEX</p>
      <AdapterUsage adapter="codex" />
      <button className="px-btn mt-3 w-full" disabled={viewLocked("ajustes", view, talkActive)} onClick={() => setView("ajustes")}>AJUSTES</button>
    </section>
  );
}

/** Barra lateral (F15): el equipo en vivo y las cuentas en compacto. */
export function TeamSidebar() {
  return (
    <div className="flex flex-col gap-4 px-2 pb-3">
      <EquipoSection />
      <CuentasSection />
    </div>
  );
}
```

Revisa la forma de los eventos de `subscribe` en `ui/src/context/WebSocketProvider.tsx` (que traen `type`) y que `AccountView.poolUsage` exista como lo usa `AccountRack.tsx`.

- [ ] **Step 5: `ui/src/App.tsx` y retiro de `AdapterPanel`**

En el `<aside>` izquierdo reemplaza el contenido de `<div className="flex-1 overflow-y-auto overflow-x-hidden pt-3">` (hoy `AdapterPanel`, `AccountsPanel`, `WorkerIsolationNotice`, `MemoryStatus`) por `<TeamSidebar />`. Ajusta los imports: agrega `import { TeamSidebar } from "./components/sidebar/TeamSidebar";` y quita los de `AdapterPanel`, `AccountsPanel`, `WorkerIsolationNotice` y `MemoryStatus` (siguen usándose en `AjustesView`). Cambia el comentario `{/* Left — Adapters */}` por `{/* Left — Equipo y cuentas (F15) */}`.

Borra `ui/src/components/AdapterPanel.tsx` (`git rm`). Confirma con `grep -rn "AdapterPanel" ui/src` que no quede ningún import.

- [ ] **Step 6: Verificar y commit**

Run: `npx vitest run test/ui`, `npm test`, `npm run lint`, `npm run typecheck`, `npm run build:ui`.

```bash
git add ui/src/lib/barra.ts ui/src/components/sidebar/TeamSidebar.tsx ui/src/context/AppStateContext.tsx ui/src/components/equipo/EquipoView.tsx ui/src/App.tsx test/ui/barra.test.ts
git rm ui/src/components/AdapterPanel.tsx
git commit -m "F15: barra lateral de equipo (roles en vivo con bandeja, cuentas en compacto)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Prueba en vivo y documentación

**Files:**
- Modify: `CLAUDE.md` (sección nueva "Team sidebar (F15)" en inglés), `CONTINUAR.md` (sección nueva arriba, en español)
- Local (no git): nota de Cerebro `C:\Users\sidel\Documents\Cerebro\20-Personal\Orquestador-IA.md`

- [ ] **Step 1: Servidor de prueba**

`npm run build:ui` y en segundo plano `ORQUESTADOR_PORT=3111 npm start` (no tocar la app de :3110).

- [ ] **Step 2: Recorrido**

En `http://127.0.0.1:3111/?vista=equipo`, con el proyecto `f11-demo` elegido, lanza una meta chica ("Lee README.md de este proyecto y resúmelo en 5 viñetas; que LECTOR lo lea y REDACTOR lo pula.") y verifica:
1. La barra muestra JEFE, los 6 roles y (si aplica) OTROS; el Jefe pasa a "trabajando ×1" y luego "esperando hijas"; LECTOR/REDACTOR a "trabajando" con "cuenta · título".
2. Clic en un rol despliega su bandeja con grupos; se recuerda al recargar.
3. Clic en una tarea abre la vista Equipo con esa meta y esa tarea seleccionadas.
4. CUENTAS muestra las bolsas con % y la marca de la local, y el uso de Claude y Codex.
5. AJUSTES: cuentas de agy (lista), trabajadores ("probar" responde), segunda cuenta de Claude, Codex, memoria (estado) — todo lo que antes estaba en la barra.
6. Con la meta terminada, los roles vuelven a "libre".
7. Consola sin errores nuevos; `GET /api/equipo/bandejas` responde rápido.

Detén el servidor de :3111 al terminar.

- [ ] **Step 3: Docs**

`CLAUDE.md`: "## Team sidebar (F15)" después de "## Team mode (F14)": barra nueva (EQUIPO con bandejas, CUENTAS compacto, botón AJUSTES), `GET /api/equipo/bandejas` (reglas de activo, grupos, tope 20, `total`, "otros"), refresco con freno de 300 ms, `equipoFocus`, vista AJUSTES (qué contiene), retiro de `AdapterPanel` (`AdapterUsage`/`ClaudeProfiles` como componentes), resultados en vivo y pendientes. Actualiza la línea de "Frontend State" que describe el layout de 3 columnas (`AdapterPanel | Chat | ProjectPanel`) a `TeamSidebar | Chat | ProjectPanel`.
`CONTINUAR.md`: "## F15 — Barra lateral de equipo · completada <fecha>" en el estilo de F14 (rama, qué hay, verificado en vivo, siguiente, pendientes).
Cerebro: viñeta de F15 en "## Estado" después de F14, `actualizado`, `siguiente`.

- [ ] **Step 4: Calidad final y commit**

`npm test`, `npm run lint`, `npm run typecheck`, `npm run build:ui`.

```bash
git add CLAUDE.md CONTINUAR.md
git commit -m "F15: docs de la barra lateral de equipo y resultados en vivo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

Merge a `main` solo con el OK de Alejandro.

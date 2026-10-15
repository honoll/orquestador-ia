# F12 · Oficina jugable — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** La vista Oficina gana un modo "mundo": un mapa pixel-art desde arriba con 3 pisos y elevador, el personaje del
usuario (clic para caminar + flechas/WASD), los agentes caminando al cubículo de la zona de su rol, y un cuadro de
diálogo estilo Pokémon con lo que hace el agente cercano.

**Architecture:** Motor mínimo propio en TypeScript + `<canvas>` dentro de `ui/src/office/` (lógica pura testeable en
`world/`: mapas como datos, BFS, colocación por rol, rutas entre pisos; dibujo en `render.ts`; sprites originales
generados por código en `sprites/`). El componente `OfficeWorld` reemplaza a `OfficeScene` cuando el modo es "mundo".
Servidor: ruta segura `/sprites/:file` y `GET /api/office/sprites` para skins del usuario fuera del repo; el asiento de
agy gana `planId`/`stepKey`/`progress` para el cuadro.

**Tech Stack:** React 19 + TypeScript + Tailwind 4 (UI), Hono (servidor), vitest en entorno node. Sin dependencias nuevas.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-15-f12-oficina-jugable-design.md`; prototipos `docs/superpowers/specs/assets/f12-oficina-jugable-prototipo.html` y `f12-zonas-por-rol.html` (estilo de baldosas y personas a copiar).
- Rama `f12-oficina-jugable` creada desde `f11-roles`. Orden de merge: F7 → F8 → F10 → F11 → F12 → F9; integrar a main **solo con OK del usuario**.
- Baldosas de **16×16** px, escala entera **×3 por defecto**, ajustada al ancho (mínimo ×1); `image-rendering: pixelated`.
- **Sin dependencias nuevas.** Sin sonido. Sin editor de mapas. Sin multijugador.
- **Sprites de terceros nunca en el repo**; el orquestador no busca ni descarga sprites. Skins del usuario solo desde `OFFICE_SPRITES_DIR` (default `C:\tools\sprites`), que nunca entra a git.
- `prefers-reduced-motion` → sin caminatas animadas (cambios instantáneos). Bucle `requestAnimationFrame` pausado con la pestaña oculta.
- Accesibilidad: el mundo es una vista adicional; tarjetas, cola, planes y log siguen en texto. El cuadro de diálogo es DOM (no canvas) con `aria-live="polite"`. Canvas con `tabIndex=0` y `aria-label`.
- Todo texto de UI en español de México. Commits en español + línea en blanco + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; `git push`. Nunca stagear `.superpowers/` ni `AGENTS.md`.
- Antes de cada commit: `npm test`, `npm run lint` (0 errores), `npm run typecheck`, `npm run build:ui`. Archivos con Write/Edit (no heredocs en bash: Windows).
- Pruebas de UI: lógica pura en `test/ui/*.test.ts` (vitest `environment: node`, sin DOM). No probar el canvas con DOM.
- **Sala limpia (decisión del usuario, 2026-10-15):** la mecánica estilo GBA 3.ª gen. se escribe desde cero a partir de reglas observables (tiempos y comportamientos listados en las tareas). **Prohibido abrir, leer, copiar o traducir** cualquier archivo de `C:\GAMES_N_SHIT\` (incluidos `pokeemerald` y `esmeralda-port`) o de pret/pokeemerald: es código derivado de Nintendo sin licencia. Tampoco usar nombres de símbolos de ese código.
- Skins en **formato `gen3`**: hoja de 144×32 = 9 cuadros de 16×32 en fila (orden: de pie abajo, arriba, izquierda; caminar abajo 1, abajo 2, arriba 1, arriba 2, izquierda 1, izquierda 2; derecha = espejo de izquierda). Es el formato que el usuario ya tiene en su máquina y el de los sprites originales que generó el propio orquestador.
- Puerto del orquestador 3110 (no tocarlo en pruebas; usar `ORQUESTADOR_PORT=3111` para revisar visualmente). Trabajadores agy: no tocarlos.

---

## Mapa de archivos

| Archivo | Responsabilidad |
|---|---|
| `ui/src/office/world/types.ts` | Tipos: `Tile`, `Zone`, `FloorMap`, `WorldAgent`, `Leg` |
| `ui/src/office/world/maps.ts` | Los 3 pisos como datos (filas ASCII + zonas + puestos fijos) |
| `ui/src/office/world/path.ts` | `isSolid`, `findPath` (BFS), `isNear`, `zoneSeats`, `freeTileIn` |
| `ui/src/office/world/placement.ts` | Estado de la Oficina → agentes del mundo con zona y asiento; `planRoute` entre pisos |
| `ui/src/office/world/input.ts` | `screenToTile`, `keyToDir`, `fitScale` |
| `ui/src/office/world/dialog.ts` | `dialogFor(agent)` → líneas del cuadro |
| `ui/src/office/world/render.ts` | Dibujo de baldosas y de zonas (canvas 2D) |
| `ui/src/office/sprites/creatures.ts` | Criaturas originales generadas por código (4 direcciones × 3 cuadros) |
| `ui/src/office/sprites/skins.ts` | `resolveSkin` + carga de imágenes de skins |
| `ui/src/components/office/OfficeWorld.tsx` | Canvas, bucle, entrada, elevador, cuadro |
| `ui/src/components/office/OfficeView.tsx` | Selector "mundo · escritorios" |
| `src/server/sprites.ts` + `src/server/routes/sprites.ts` | Validación de `sprites.json` y servido seguro |
| `src/server/agy-workers.ts`, `src/server/office-state.ts`, `src/server/plan-runner.ts` | Asiento con `planId`, `stepKey`, `progress` |

---

### Task 1: Mapas y caminos (lógica pura)

**Files:**
- Create: `ui/src/office/world/types.ts`, `ui/src/office/world/maps.ts`, `ui/src/office/world/path.ts`
- Test: `test/ui/world-path.test.ts`

**Interfaces:**
- Produces: `type Tile = readonly [x: number, y: number]`; `interface Zone { id: string; etiqueta: string; color: string; x: number; y: number; w: number; h: number; fijos?: Record<string, Tile> }`; `interface FloorMap { piso: number; nombre: string; fondo: string; filas: readonly string[]; zonas: readonly Zone[]; elevador: Tile; llegada: Tile; salida?: Tile }`; `FLOORS: readonly FloorMap[]` (índice 0 = piso 1); `floorOf(piso: number): FloorMap`; `isSolid(map, x, y, occupied?: ReadonlySet<string>): boolean`; `key(t: Tile): string` (`"x,y"`); `findPath(map, from: Tile, to: Tile, occupied?): Tile[]` (sin incluir `from`; `[]` si no hay ruta o ya estás); `isNear(a: Tile, b: Tile): boolean`; `zoneSeats(map, zoneId): Tile[]` (asientos `s` dentro del rectángulo que no son puestos fijos); `freeTileIn(map, zone, taken: ReadonlySet<string>): Tile | null`; `zoneAt(map, t): Zone | null`.

Leyenda de las filas: `#` pared · `.` piso · `=` escritorio · `*` planta · `B` librero · `S` sofá · `|` y `-` mampara de cubículo · `d` puerta (se pisa) · `E` elevador (se pisa) · `s` asiento (se pisa) · `p` salida del jugador (se pisa). Sólidos: `#=*BS|-`. Los pisos tienen pasillos de 2 casillas, cubículos con mamparas abiertos al pasillo y salas con puerta.

- [ ] **Step 1: Escribir la prueba que falla**

```ts
// test/ui/world-path.test.ts
import { describe, it, expect } from "vitest";
import { FLOORS, floorOf } from "../../ui/src/office/world/maps";
import { findPath, isNear, isSolid, zoneSeats, freeTileIn, zoneAt, key } from "../../ui/src/office/world/path";

describe("mapas de la Oficina", () => {
  it("3 pisos rectangulares; todo asiento, puesto fijo y la salida se alcanzan desde el elevador", () => {
    expect(FLOORS.map((f) => f.piso)).toEqual([1, 2, 3]);
    for (const f of FLOORS) {
      const w = f.filas[0].length;
      expect(f.filas.every((r) => r.length === w)).toBe(true);
      expect(f.filas[f.elevador[1]][f.elevador[0]]).toBe("E");
      expect(isSolid(f, ...f.llegada)).toBe(false);
      const targets = f.filas.flatMap((r, y) => [...r].flatMap((c, x) => ("sp".includes(c) ? [[x, y] as const] : [])));
      for (const t of targets) expect(findPath(f, f.elevador, t).at(-1), `${f.piso}:${key(t)}`).toEqual(t);
      for (const z of f.zonas) for (const t of Object.values(z.fijos ?? {})) expect(f.filas[t[1]][t[0]]).toBe("s");
    }
    expect(floorOf(1).salida).toEqual([8, 13]);
  });

  it("findPath rodea escritorios, va a una vecina libre si el destino es sólido y devuelve [] sin ruta", () => {
    const f = floorOf(2);
    const p = findPath(f, [3, 3], [3, 7]); // de un cubículo al de abajo: sale al pasillo y rodea mamparas
    expect(p.at(-1)).toEqual([3, 7]);
    for (const t of p) expect(isSolid(f, ...t)).toBe(false);
    expect(p.length).toBeGreaterThan(6);
    expect(findPath(f, [3, 3], [3, 8]).at(-1)).toEqual([3, 7]); // escritorio: termina en la única vecina libre
    expect(findPath(f, [3, 3], [0, 0])).toEqual([]); // pared rodeada de paredes
    expect(findPath(f, [3, 3], [3, 3])).toEqual([]);
    const f1 = floorOf(1);
    const occupied = new Set([key([4, 4])]);
    expect(findPath(f1, [3, 4], [5, 4], occupied).some((t) => key(t) === "4,4")).toBe(false);
  });

  it("isNear: vecino a 1 casilla incluida la diagonal; la misma casilla no", () => {
    expect(isNear([5, 5], [6, 6])).toBe(true);
    expect(isNear([5, 5], [5, 4])).toBe(true);
    expect(isNear([5, 5], [5, 5])).toBe(false);
    expect(isNear([5, 5], [7, 5])).toBe(false);
  });

  it("zoneSeats excluye puestos fijos; freeTileIn da una casilla libre del rectángulo", () => {
    expect(zoneSeats(floorOf(2), "dev")).toHaveLength(6);
    expect(zoneSeats(floorOf(1), "descanso")).toHaveLength(11);
    expect(zoneSeats(floorOf(1), "direccion")).toHaveLength(0); // jefe y guardia son fijos
    const z = floorOf(3).zonas.find((x) => x.id === "lector")!;
    const t = freeTileIn(floorOf(3), z, new Set())!;
    expect(isSolid(floorOf(3), ...t)).toBe(false);
    expect(zoneAt(floorOf(3), t)?.id).toBe("lector");
  });
});
```

- [ ] **Step 2: Correrla y ver que falla**

Run: `npx vitest run test/ui/world-path.test.ts`
Expected: FAIL (módulos no existen).

- [ ] **Step 3: Implementar tipos, mapas y caminos**

```ts
// ui/src/office/world/types.ts
export type Tile = readonly [x: number, y: number];
export interface Zone { id: string; etiqueta: string; color: string; x: number; y: number; w: number; h: number; fijos?: Record<string, Tile> }
export interface FloorMap {
  piso: number; nombre: string; fondo: string;
  filas: readonly string[]; zonas: readonly Zone[];
  elevador: Tile; llegada: Tile; // llegada = casilla donde aparece quien sale del elevador
  salida?: Tile; // aparición del jugador (solo piso 1)
}
```

```ts
// ui/src/office/world/maps.ts
// Datos validados: todo asiento se alcanza desde el elevador (test/ui/world-path.test.ts).
import type { FloorMap } from "./types";

export const FLOORS: readonly FloorMap[] = [
  {
    piso: 1, nombre: "PISO 1 · DIRECCIÓN Y RECEPCIÓN", fondo: "#1b1b22", elevador: [15, 1], llegada: [15, 2], salida: [8, 13],
    filas: [
      "##############################",
      "#*.............E............*#",
      "#.....===............===...B.#",
      "#......s..............s....B.#",
      "#............................#",
      "#.....===............===.....#",
      "#......s..............s......#",
      "#######d###########d##########",
      "#............................#",
      "#*...........................#",
      "#..SSSS......SSS......SSSS...#",
      "#..ssss......sss......ssss...#",
      "#............................#",
      "#.......p....................#",
      "#*..........................*#",
      "##############################",
    ],
    zonas: [
      { id: "direccion", etiqueta: "DIRECCIÓN", color: "#a78bfa", x: 1, y: 1, w: 12, h: 6, fijos: { jefe: [7, 3], guardia: [7, 6] } },
      { id: "recepcion", etiqueta: "RECEPCIÓN Y MEMORIA", color: "#fb923c", x: 17, y: 1, w: 12, h: 6, fijos: { recepcion: [22, 3], biblio: [22, 6] } },
      { id: "descanso", etiqueta: "SALA DE DESCANSO", color: "#a1a1aa", x: 1, y: 8, w: 28, h: 7 },
    ],
  },
  {
    piso: 2, nombre: "PISO 2 · DESARROLLO Y PRUEBAS", fondo: "#16202a", elevador: [15, 1], llegada: [15, 2],
    filas: [
      "##############################",
      "#*.............E............*#",
      "#............................#",
      "#.|s.|s.|s.|....######d#######",
      "#.|==|==|==|....#..........*.#",
      "#.----------....#..=s=..=s=..#",
      "#...............#............#",
      "#.|s.|s.|s.|....#..=s=.......#",
      "#.|==|==|==|....#............#",
      "#.----------....#....B.B.....#",
      "#...............#............#",
      "#......|s.|s.|..#............#",
      "#......|==|==|..#............#",
      "#*.....-------..#...........*#",
      "##############################",
    ],
    zonas: [
      { id: "dev", etiqueta: "DEV · CUBÍCULOS", color: "#60a5fa", x: 1, y: 3, w: 15, h: 7 },
      { id: "agentes", etiqueta: "CLAUDE Y CODEX", color: "#e879f9", x: 1, y: 10, w: 15, h: 4, fijos: { claude: [8, 11], codex: [11, 11] } },
      { id: "qa", etiqueta: "QA · LABORATORIO", color: "#34d399", x: 17, y: 4, w: 12, h: 10 },
    ],
  },
  {
    piso: 3, nombre: "PISO 3 · ESTUDIO Y BIBLIOTECA", fondo: "#221a1a", elevador: [15, 1], llegada: [15, 2],
    filas: [
      "##############################",
      "#*.............E............*#",
      "#............................#",
      "######d#######..######d#######",
      "#.==...==....#..#.B.B..B.B...#",
      "#..s....s....#..#............#",
      "#............#..#..==...==...#",
      "#*...........#..#...s....s..*#",
      "######d#######..######d#######",
      "#.==...==....#..#..==...==...#",
      "#..s....s....#..#...s....s...#",
      "#*...........#..#..........*.#",
      "##############################",
    ],
    zonas: [
      { id: "imagen", etiqueta: "IMAGEN · ESTUDIO", color: "#fb923c", x: 1, y: 4, w: 12, h: 4 },
      { id: "investigador", etiqueta: "INVESTIGADOR · BIBLIOTECA", color: "#f472b6", x: 17, y: 4, w: 12, h: 4 },
      { id: "lector", etiqueta: "LECTOR · SALA DE LECTURA", color: "#fbbf24", x: 1, y: 9, w: 12, h: 3 },
      { id: "redactor", etiqueta: "REDACTOR", color: "#e879f9", x: 17, y: 9, w: 12, h: 3 },
    ],
  },
];

export const floorOf = (piso: number): FloorMap => FLOORS[piso - 1];
```

```ts
// ui/src/office/world/path.ts
import type { FloorMap, Tile, Zone } from "./types";

const SOLID = "#=*BS|-";
const DIRS: readonly Tile[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export const key = (t: Tile): string => `${t[0]},${t[1]}`;

export function isSolid(map: FloorMap, x: number, y: number, occupied?: ReadonlySet<string>): boolean {
  const ch = map.filas[y]?.[x];
  return ch === undefined || SOLID.includes(ch) || (occupied?.has(`${x},${y}`) ?? false);
}

/** BFS en 4 direcciones. Si el destino es sólido, termina en una vecina libre. Sin `from` en el resultado. */
export function findPath(map: FloorMap, from: Tile, to: Tile, occupied?: ReadonlySet<string>): Tile[] {
  const ok = (x: number, y: number) => !isSolid(map, x, y, occupied);
  const goals = new Set<string>();
  if (ok(to[0], to[1])) goals.add(key(to));
  else for (const [dx, dy] of DIRS) if (ok(to[0] + dx, to[1] + dy)) goals.add(`${to[0] + dx},${to[1] + dy}`);
  if (goals.size === 0 || goals.has(key(from))) return [];
  const prev = new Map<string, string | null>([[key(from), null]]);
  const queue: Tile[] = [from];
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    if (goals.has(`${x},${y}`)) {
      const out: Tile[] = [];
      for (let k: string | null = `${x},${y}`; k && k !== key(from); k = prev.get(k) ?? null) {
        const [a, b] = k.split(",").map(Number);
        out.unshift([a, b]);
      }
      return out;
    }
    for (const [dx, dy] of DIRS) {
      const nk = `${x + dx},${y + dy}`;
      if (!prev.has(nk) && ok(x + dx, y + dy)) { prev.set(nk, `${x},${y}`); queue.push([x + dx, y + dy]); }
    }
  }
  return [];
}

export const isNear = (a: Tile, b: Tile): boolean => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) === 1;

const inZone = (z: Zone, x: number, y: number) => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h;

export const zoneAt = (map: FloorMap, t: Tile): Zone | null => map.zonas.find((z) => inZone(z, t[0], t[1])) ?? null;

export function zoneSeats(map: FloorMap, zoneId: string): Tile[] {
  const z = map.zonas.find((x) => x.id === zoneId);
  if (!z) return [];
  const fixed = new Set(Object.values(z.fijos ?? {}).map(key));
  const out: Tile[] = [];
  for (let y = z.y; y < z.y + z.h; y++) for (let x = z.x; x < z.x + z.w; x++) {
    if (map.filas[y]?.[x] === "s" && !fixed.has(`${x},${y}`)) out.push([x, y]);
  }
  return out;
}

/** Primera casilla pisable del rectángulo que nadie ocupa (para cuando no quedan asientos). */
export function freeTileIn(map: FloorMap, z: Zone, taken: ReadonlySet<string>): Tile | null {
  for (let y = z.y; y < z.y + z.h; y++) for (let x = z.x; x < z.x + z.w; x++) {
    if (!isSolid(map, x, y) && !taken.has(`${x},${y}`) && map.filas[y][x] !== "E") return [x, y];
  }
  return null;
}
```

- [ ] **Step 4: Correr la prueba**

Run: `npx vitest run test/ui/world-path.test.ts`
Expected: PASS (4 pruebas).

- [ ] **Step 5: Commit**

```bash
git add ui/src/office/world/types.ts ui/src/office/world/maps.ts ui/src/office/world/path.ts test/ui/world-path.test.ts
git commit -m "F12 tarea 1: mapas de 3 pisos y caminos (BFS)"
```

---

### Task 2: Datos del asiento (servidor) y colocación por rol (UI)

**Files:**
- Modify: `src/server/agy-workers.ts:300-313` (`tagLease`, `AgySeat`, `agySeats`), `src/server/plan-runner.ts:148`, `src/server/office-state.ts` (progreso por plan), `ui/src/components/office/OfficeView.tsx:14-15` (espejo de tipos)
- Create: `ui/src/office/world/placement.ts`
- Test: `test/server/office-state.test.ts` (agregar caso), `test/ui/world-placement.test.ts`

**Interfaces:**
- Consumes: Task 1 (`floorOf`, `zoneSeats`, `freeTileIn`, `findPath`, `key`, tipos).
- Produces (servidor): `tagLease(accountId, activity, model, role = null, step: { planId: string; stepKey: string | null } | null = null)`; `AgySeat` gana `planId: string | null; stepKey: string | null; progress: { done: number; total: number } | null` (progress lo llena `office-state`; `agySeats` lo deja `null`). Las mismas tres propiedades en el espejo `AgySeat` de `OfficeView.tsx`.
- Produces (UI): `interface WorldAgent { key: string; nombre: string; rol: string | null; cuenta: string | null; color: string; criatura: CreatureKind; working: boolean; paused: boolean; activity: string; model: string | null; tokens: number | null; planId: string | null; stepKey: string | null; progress: { done: number; total: number } | null; piso: number; tile: Tile }`; `type CreatureKind = "jugador" | "jefe" | "guardia" | "recepcion" | "biblio" | "claude" | "codex" | "agy" | "dev" | "qa" | "imagen" | "investigador" | "lector" | "redactor"`; `type Place = { piso: number; tile: Tile }`; `zoneForSeat(seat: AgySeat): string` (devuelve `"descanso"` si no trabaja; el `role` si es zona conocida; si no, `"dev"`); `pisoOfZone(zoneId): number`; `placeAgents(state: OfficeState, prev: ReadonlyMap<string, Place>): WorldAgent[]`; `interface Leg { piso: number; path: Tile[] }`; `planRoute(from: Place, to: Place): Leg[]`.

Reglas de colocación:
- Fijos: `jefe`, `guardia`, `recepcion`, `biblio` (piso 1) y `claude`, `codex` (piso 2) en `zona.fijos[id]`. Colores y nombres de `ROLES` en `ui/src/lib/office.ts`; `criatura = id`.
- agy: un `WorldAgent` por `seat` (`key = "agy:" + seat.account`, `nombre = seat.local ? "tu cuenta" : seat.account`). Zona = `zoneForSeat(seat)`. Criatura = el rol si `working` y es un rol conocido; si no, `"agy"`. Color = `roleColor(rol)` de `ui/src/lib/roles.ts` si trabaja con rol; si no `ROLES.agy.color`; en reposo el render lo pinta gris.
- Asiento estable: si `prev.get(key)` está en la misma zona y su casilla sigue libre, se conserva; si no, el primer asiento libre (`zoneSeats` en orden); sin asientos libres → `freeTileIn` de esa zona; sin nada → la `llegada` del piso. Orden de asignación: primero los que conservan asiento, después el resto por `key` (determinista).
- Sin `seats` (sin cuentas de agy), no se dibuja ningún agy.

`planRoute`: mismo piso → `[{ piso, path: findPath(...) }]`; distinto piso → `[{ piso: from.piso, path: findPath(from → elevador) }, { piso: to.piso, path: [llegada, ...findPath(llegada → to)] }]`. Los agentes no se bloquean entre sí (sin `occupied`).

- [ ] **Step 1: Pruebas que fallan**

Servidor (agregar en `test/server/office-state.test.ts`, siguiendo el estilo de los casos de `seats` que ya existen; leer el archivo primero):

```ts
it("el asiento lleva planId/stepKey del paso y el avance del plan", () => {
  const seat = { local: false, account: "agy2", pool: "agy2", working: true, activity: "Crear slug", model: "claude-sonnet-4-6", role: "dev", planId: "p1", stepKey: "s2", progress: null };
  const st = buildOfficeState(base({ agySeats: [seat], planProgress: { p1: { done: 1, total: 4 } } }));
  expect(st.agents.find((a) => a.id === "agy")!.seats![0]).toMatchObject({ planId: "p1", stepKey: "s2", progress: { done: 1, total: 4 } });
});
```

(`base()` es el constructor de entrada que ya usa ese archivo; agregarle `planProgress: {}` por defecto. `OfficeInput` gana `planProgress: Record<string, { done: number; total: number }>`; `collectOfficeInput` lo llena con una consulta por los `planId` de asientos que trabajan: `done` = pasos `succeeded`/`skipped`, `total` = todos los pasos del plan.)

UI:

```ts
// test/ui/world-placement.test.ts
import { describe, it, expect } from "vitest";
import { placeAgents, planRoute, zoneForSeat, pisoOfZone } from "../../ui/src/office/world/placement";
import { floorOf } from "../../ui/src/office/world/maps";
import type { OfficeState, AgySeat } from "../../ui/src/components/office/OfficeView";

const seat = (account: string, extra: Partial<AgySeat> = {}): AgySeat => ({ local: false, account, pool: account, working: false, activity: "libre", model: null, role: null, planId: null, stepKey: null, progress: null, ...extra });
const base = (seats: AgySeat[]): OfficeState => ({
  agents: (["jefe", "guardia", "agy", "codex", "claude", "biblio", "recepcion"] as const).map((id) => ({ id, working: false, desks: 1, activity: "", model: "", tokens: 0, ...(id === "agy" ? { seats } : {}) })),
  queue: [], plans: [], generatedAt: "2026-10-15T00:00:00Z",
});

describe("colocación de agentes por rol", () => {
  it("zoneForSeat: libre → descanso; rol conocido → su zona; trabajando sin rol → dev", () => {
    expect(zoneForSeat(seat("a"))).toBe("descanso");
    expect(zoneForSeat(seat("a", { working: true, role: "qa" }))).toBe("qa");
    expect(zoneForSeat(seat("a", { working: true, role: "inventado" }))).toBe("dev");
    expect(zoneForSeat(seat("a", { working: true }))).toBe("dev");
    expect([pisoOfZone("descanso"), pisoOfZone("qa"), pisoOfZone("lector")]).toEqual([1, 2, 3]);
  });

  it("fijos en su puesto y agy en la zona de su rol, sin dos en la misma casilla", () => {
    const st = base([seat("agy2", { working: true, role: "dev" }), seat("agy3", { working: true, role: "dev" }), seat("agy4"), seat("local", { local: true, working: true, role: "imagen" })]);
    const out = placeAgents(st, new Map());
    const by = Object.fromEntries(out.map((a) => [a.key, a]));
    expect(by.jefe).toMatchObject({ piso: 1, tile: [7, 3], criatura: "jefe" });
    expect(by.claude).toMatchObject({ piso: 2, tile: [8, 11] });
    expect(by["agy:agy2"]).toMatchObject({ piso: 2, criatura: "dev", rol: "dev" });
    expect(by["agy:agy4"]).toMatchObject({ piso: 1, criatura: "agy", working: false });
    expect(by["agy:local"]).toMatchObject({ piso: 3, criatura: "imagen", nombre: "tu cuenta" });
    const tiles = out.map((a) => `${a.piso}:${a.tile.join(",")}`);
    expect(new Set(tiles).size).toBe(tiles.length);
    expect(floorOf(1).filas[by["agy:agy4"].tile[1]][by["agy:agy4"].tile[0]]).toBe("s");
  });

  it("conserva el asiento previo si sigue en la misma zona", () => {
    const st = base([seat("agy2", { working: true, role: "dev" })]);
    const out = placeAgents(st, new Map([["agy:agy2", { piso: 2, tile: [6, 7] as const }]]));
    expect(out.find((a) => a.key === "agy:agy2")!.tile).toEqual([6, 7]);
  });

  it("más agentes que asientos: los sobrantes van a casillas libres de la zona", () => {
    const seats = Array.from({ length: 8 }, (_, i) => seat(`c${i}`, { working: true, role: "qa" })); // qa tiene 3 asientos
    const out = placeAgents(base(seats), new Map()).filter((a) => a.rol === "qa");
    expect(out).toHaveLength(8);
    expect(new Set(out.map((a) => a.tile.join(","))).size).toBe(8);
  });

  it("planRoute entre pisos pasa por el elevador y aparece en la llegada", () => {
    const legs = planRoute({ piso: 1, tile: [3, 11] }, { piso: 2, tile: [3, 3] });
    expect(legs).toHaveLength(2);
    expect(legs[0].path.at(-1)).toEqual([15, 1]);
    expect(legs[1].path[0]).toEqual([15, 2]);
    expect(legs[1].path.at(-1)).toEqual([3, 3]);
    expect(planRoute({ piso: 2, tile: [3, 3] }, { piso: 2, tile: [6, 3] })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Correr y ver que fallan**

Run: `npx vitest run test/ui/world-placement.test.ts test/server/office-state.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

Servidor:

```ts
// src/server/agy-workers.ts (reemplaza tagLease, AgySeat y el map de agySeats)
export function tagLease(accountId: string, activity: string, model: string | null, role: string | null = null, step: { planId: string; stepKey: string | null } | null = null): void {
  if (reserved.has(accountId)) leaseInfo.set(accountId, { activity, model, role, planId: step?.planId ?? null, stepKey: step?.stepKey ?? null });
}

export interface AgySeat {
  local: boolean; account: string; pool: string | null; working: boolean; activity: string; model: string | null; role: string | null;
  planId: string | null; stepKey: string | null; progress: { done: number; total: number } | null;
}
// en agySeats():
//   planId: working ? (info?.planId ?? null) : null, stepKey: working ? (info?.stepKey ?? null) : null, progress: null,
```

(El tipo de `leaseInfo` gana `planId: string | null; stepKey: string | null`.) En `plan-runner.ts:148`: `tagLease(lease.accountId, step.description, step.model ?? null, step.role ?? null, { planId: step.planId, stepKey: step.stepKey ?? null })` — usar los nombres reales de campos de `step` en ese archivo (`planId`/`stepKey` en el row de Drizzle).

`office-state.ts`: `OfficeInput.planProgress: Record<string, { done: number; total: number }>`; en `buildOfficeState`, al copiar los asientos: `seats.map((s) => ({ ...s, progress: s.planId ? (i.planProgress[s.planId] ?? null) : null }))`; en `collectOfficeInput`:

```ts
const ids = [...new Set(agySeats.filter((s) => s.working && s.planId).map((s) => s.planId!))];
const planProgress: Record<string, { done: number; total: number }> = {};
for (const id of ids) {
  const rows = await db.select({ status: schema.planSteps.status }).from(schema.planSteps).where(eq(schema.planSteps.planId, id));
  planProgress[id] = { done: rows.filter((r) => r.status === "succeeded" || r.status === "skipped").length, total: rows.length };
}
```

Actualizar en `OfficeView.tsx` el espejo `AgySeat` con las tres propiedades nuevas.

UI:

```ts
// ui/src/office/world/placement.ts
import { ROLES, type AgentId } from "../../lib/office";
import { roleColor } from "../../lib/roles";
import type { AgySeat, OfficeState } from "../../components/office/OfficeView";
import { FLOORS, floorOf } from "./maps";
import { findPath, freeTileIn, key, zoneSeats } from "./path";
import type { Tile } from "./types";

export type CreatureKind = "jugador" | "jefe" | "guardia" | "recepcion" | "biblio" | "claude" | "codex" | "agy" | "dev" | "qa" | "imagen" | "investigador" | "lector" | "redactor";
export interface Place { piso: number; tile: Tile }
export interface Leg { piso: number; path: Tile[] }
export interface WorldAgent {
  key: string; nombre: string; rol: string | null; cuenta: string | null; color: string; criatura: CreatureKind;
  working: boolean; paused: boolean; activity: string; model: string | null; tokens: number | null;
  planId: string | null; stepKey: string | null; progress: { done: number; total: number } | null;
  piso: number; tile: Tile;
}

const ROLE_ZONES = ["dev", "qa", "imagen", "investigador", "lector", "redactor"] as const;
const FIXED: readonly AgentId[] = ["jefe", "guardia", "recepcion", "biblio", "claude", "codex"];

export function zoneForSeat(seat: AgySeat): string {
  if (!seat.working) return "descanso";
  return seat.role && (ROLE_ZONES as readonly string[]).includes(seat.role) ? seat.role : "dev";
}

export function pisoOfZone(zoneId: string): number {
  return FLOORS.find((f) => f.zonas.some((z) => z.id === zoneId))!.piso;
}

function fixedPlace(id: AgentId): Place {
  for (const f of FLOORS) for (const z of f.zonas) { const t = z.fijos?.[id]; if (t) return { piso: f.piso, tile: t }; }
  throw new Error(`sin puesto fijo para ${id}`);
}

export function placeAgents(state: OfficeState, prev: ReadonlyMap<string, Place>): WorldAgent[] {
  const out: WorldAgent[] = [];
  for (const id of FIXED) {
    const a = state.agents.find((x) => x.id === id);
    const p = fixedPlace(id);
    out.push({
      key: id, nombre: ROLES[id].label, rol: null, cuenta: null, color: ROLES[id].color, criatura: id,
      working: a?.working ?? false, paused: a?.paused ?? false, activity: a?.activity ?? "", model: a?.model ?? null,
      tokens: a?.tokens ?? null, planId: null, stepKey: null, progress: null, ...p,
    });
  }
  const seats = state.agents.find((x) => x.id === "agy")?.seats ?? [];
  const taken = new Map<number, Set<string>>(FLOORS.map((f) => [f.piso, new Set(out.filter((o) => o.piso === f.piso).map((o) => key(o.tile)))]));
  const wants = seats.map((s) => ({ s, k: `agy:${s.account}`, zone: zoneForSeat(s) }));
  const keep = (w: (typeof wants)[number]) => {
    const p = prev.get(w.k);
    return p && p.piso === pisoOfZone(w.zone) && zoneSeats(floorOf(p.piso), w.zone).some((t) => key(t) === key(p.tile)) ? p : null;
  };
  const ordered = [...wants.filter((w) => keep(w)), ...wants.filter((w) => !keep(w)).sort((a, b) => a.k.localeCompare(b.k))];
  for (const w of ordered) {
    const piso = pisoOfZone(w.zone);
    const map = floorOf(piso);
    const used = taken.get(piso)!;
    const kept = keep(w);
    const tile = (kept && !used.has(key(kept.tile)) ? kept.tile : null)
      ?? zoneSeats(map, w.zone).find((t) => !used.has(key(t)))
      ?? freeTileIn(map, map.zonas.find((z) => z.id === w.zone)!, used)
      ?? map.llegada;
    used.add(key(tile));
    const rol = w.s.working && w.s.role && (ROLE_ZONES as readonly string[]).includes(w.s.role) ? w.s.role : null;
    out.push({
      key: w.k, nombre: w.s.local ? "tu cuenta" : w.s.account, rol, cuenta: w.s.account,
      color: rol ? roleColor(rol) : ROLES.agy.color, criatura: (rol ?? "agy") as CreatureKind,
      working: w.s.working, paused: false, activity: w.s.activity, model: w.s.model, tokens: null,
      planId: w.s.planId, stepKey: w.s.stepKey, progress: w.s.progress, piso, tile,
    });
  }
  return out;
}

export function planRoute(from: Place, to: Place): Leg[] {
  if (from.piso === to.piso) return [{ piso: from.piso, path: findPath(floorOf(from.piso), from.tile, to.tile) }];
  const a = floorOf(from.piso), b = floorOf(to.piso);
  return [
    { piso: from.piso, path: findPath(a, from.tile, a.elevador) },
    { piso: to.piso, path: [b.llegada, ...findPath(b, b.llegada, to.tile)] },
  ];
}
```

Si `ROLES[id].label` no existe con ese nombre en `ui/src/lib/office.ts`, usar la propiedad real del nombre visible (leer el archivo).

- [ ] **Step 4: Correr las pruebas**

Run: `npx vitest run test/ui/world-placement.test.ts test/server/office-state.test.ts test/server/agy-workers.test.ts`
Expected: PASS. Luego `npm test` completo (los tests existentes de asientos pueden necesitar `planId: null, stepKey: null, progress: null` en sus objetos esperados: actualizarlos).

- [ ] **Step 5: Commit**

```bash
git add src/server/agy-workers.ts src/server/plan-runner.ts src/server/office-state.ts ui/src/components/office/OfficeView.tsx ui/src/office/world/placement.ts test/ui/world-placement.test.ts test/server/office-state.test.ts
git commit -m "F12 tarea 2: asiento con plan/paso/avance y colocación de agentes por rol"
```

---

### Task 3: Sprites originales y skins del usuario

**Files:**
- Create: `ui/src/office/sprites/creatures.ts`, `ui/src/office/sprites/skins.ts`, `src/server/sprites.ts`, `src/server/routes/sprites.ts`
- Modify: `src/server/index.ts` (montar rutas), `.env.example` (`OFFICE_SPRITES_DIR`)
- Test: `test/server/sprites.test.ts`, `test/ui/sprites.test.ts`

**Interfaces:**
- Consumes: `CreatureKind` (Task 2).
- Produces (UI): `gen3Frame(dir: Dir, step: 0 | 1 | 2): { index: number; mirror: boolean }` (step 1 = de pie, 0 = paso 1, 2 = paso 2; índices 0–8 en el orden de Global Constraints; `right` usa los de `left` con `mirror: true`); `type Dir = "down" | "up" | "left" | "right"`; `creatureFrame(kind: CreatureKind, dir: Dir, frame: 0 | 1 | 2, working: boolean): Rect[]` (rects `[x, y, w, h, color]` en una caja de 16×16; usa el tipo `Rect` de `ui/src/lib/office.ts`); `interface SpriteSpec { file: string; frameW: number; frameH: number; frames: number; rows: Record<Dir, number>; formato?: "gen3" }` (en `sprites.json`, `{ "file": "x.png", "formato": "gen3" }` basta y el servidor lo expande a `frameW 16, frameH 32, frames 9, rows {down:0,left:0,right:0,up:0}, formato "gen3"`); `interface SkinsConfig { player?: SpriteSpec; roles: Record<string, SpriteSpec>; agents: Record<string, SpriteSpec>; warnings: string[] }`; `resolveSkin(cfg: SkinsConfig, who: { player?: boolean; agentKey?: string; account?: string | null; rol?: string | null; criatura: CreatureKind }): SpriteSpec | null` (prioridad: jugador → `agents[account]` → `agents[agentKey]` → `roles[rol]` → `roles[criatura]` → `null`).
- Produces (servidor): `spritesDir(): string` (env `OFFICE_SPRITES_DIR`, leído en cada llamada, default `C:\tools\sprites`); `validateSprites(raw: unknown): SkinsConfig`; `SPRITE_FILE = /^[A-Za-z0-9_-]{1,64}\.(png|gif|webp)$/`; rutas `GET /sprites/:file` y `GET /api/office/sprites`.

Criaturas originales (arte propio, nada copiado): un cuerpo base redondo de 16×16 con 3 cuadros por dirección (cuadro 1 = de pie; 0 y 2 = pierna izquierda/derecha adelantada) y rasgos por especie:

| kind | especie | color base | rasgo |
|---|---|---|---|
| jugador | gato | `#e11d48` | orejas triangulares |
| jefe | búho real | `#a78bfa` | cuernitos + sombrero |
| guardia | armadillo | `#fbbf24` | placas en la espalda + gorra |
| recepcion | conejo | `#fb923c` | orejas largas + diadema |
| biblio | tortuga | `#f472b6` | caparazón + libro |
| claude | zorro ártico | `#e879f9` | cola esponjada |
| codex | rana | `#34d399` | ojos saltones |
| agy | robotito | `#60a5fa` | antena |
| dev | zorro | `#60a5fa` | orejas + cola naranja |
| qa | mapache | `#34d399` | antifaz + lupa |
| imagen | camaleón | `#fb923c` | cresta + pincel |
| investigador | búho | `#f472b6` | ojos grandes |
| lector | erizo | `#fbbf24` | púas + lentes |
| redactor | ardilla | `#e879f9` | cola rizada + pluma |

```ts
// ui/src/office/sprites/creatures.ts
import { shade, type Rect } from "../../lib/office";
import type { CreatureKind } from "../world/placement";

export type Dir = "down" | "up" | "left" | "right";
const O = "#09090b";
const BASE: Record<CreatureKind, string> = {
  jugador: "#e11d48", jefe: "#a78bfa", guardia: "#fbbf24", recepcion: "#fb923c", biblio: "#f472b6", claude: "#e879f9",
  codex: "#34d399", agy: "#60a5fa", dev: "#60a5fa", qa: "#34d399", imagen: "#fb923c", investigador: "#f472b6",
  lector: "#fbbf24", redactor: "#e879f9",
};

/** Cuerpo base (16×16): sombra, contorno, cuerpo, panza, ojos según dirección, patas según el cuadro. */
function body(c: string, dir: Dir, frame: 0 | 1 | 2, bob: number): Rect[] {
  const r: Rect[] = [[3, 14, 10, 2, "#0007"], [3, 3 + bob, 10, 10, O], [4, 4 + bob, 8, 8, c], [4, 4 + bob, 8, 2, shade(c, 1.35)], [5, 9 + bob, 6, 3, shade(c, 0.62)]];
  if (dir === "down") r.push([5, 7 + bob, 1, 2, "#fff"], [10, 7 + bob, 1, 2, "#fff"], [7, 10 + bob, 2, 1, shade(c, 1.6)]);
  if (dir === "left") r.push([5, 7 + bob, 1, 2, "#fff"]);
  if (dir === "right") r.push([10, 7 + bob, 1, 2, "#fff"]);
  const lf = frame === 0 ? -1 : 0, rf = frame === 2 ? -1 : 0;
  r.push([4, 13 + lf, 3, 2, O], [9, 13 + rf, 3, 2, O]);
  return r;
}

function features(k: CreatureKind, c: string, dir: Dir, bob: number): Rect[] {
  const y = bob, back = dir === "up";
  switch (k) {
    case "jugador": return [[3, 1 + y, 3, 3, O], [4, 2 + y, 1, 1, c], [10, 1 + y, 3, 3, O], [11, 2 + y, 1, 1, c]];
    case "jefe": return [[4, 2 + y, 2, 2, shade(c, 0.5)], [10, 2 + y, 2, 2, shade(c, 0.5)], [5, 0 + y, 6, 2, "#991b1b"], [3, 2 + y, 10, 1, O]];
    case "guardia": return [[4, 2 + y, 8, 2, "#1e3a8a"], ...(back ? [[5, 6 + y, 6, 1, shade(c, 0.5)], [5, 9 + y, 6, 1, shade(c, 0.5)]] as Rect[] : [])];
    case "recepcion": return [[5, -2 + y, 2, 5, c], [9, -2 + y, 2, 5, c], [3, 3 + y, 10, 1, "#3f3f46"]];
    case "biblio": return [[3, 6 + y, 10, 5, "#166534"], [4, 7 + y, 8, 3, "#15803d"], [12, 9, 3, 4, "#7c3aed"]];
    case "claude": return [[12, 9 + y, 4, 4, shade(c, 1.4)], [3, 2 + y, 2, 2, c], [11, 2 + y, 2, 2, c]];
    case "codex": return [[4, 2 + y, 3, 3, "#fff"], [9, 2 + y, 3, 3, "#fff"], [5, 3 + y, 1, 1, O], [10, 3 + y, 1, 1, O]];
    case "agy": return [[8, 0 + y, 1, 3, "#a1a1aa"], [7, -1 + y, 3, 1, "#fde047"]];
    case "dev": return [[3, 1 + y, 3, 3, c], [10, 1 + y, 3, 3, c], [12, 10 + y, 4, 3, "#f97316"]];
    case "qa": return [[4, 6 + y, 8, 2, "#27272a"], [12, 8, 3, 3, "#e4e4e7"], [13, 9, 1, 1, "#0ea5e9"]];
    case "imagen": return [[6, 1 + y, 4, 2, "#16a34a"], [12, 6 + y, 1, 6, "#7c5a33"], [12, 5 + y, 1, 1, "#60a5fa"]];
    case "investigador": return [[4, 5 + y, 3, 3, "#fff"], [9, 5 + y, 3, 3, "#fff"], [5, 6 + y, 1, 1, O], [10, 6 + y, 1, 1, O], [7, 8 + y, 2, 1, "#f59e0b"]];
    case "lector": return [[3, 2 + y, 1, 2, shade(c, 0.5)], [6, 1 + y, 1, 2, shade(c, 0.5)], [9, 1 + y, 1, 2, shade(c, 0.5)], [12, 2 + y, 1, 2, shade(c, 0.5)], [4, 7 + y, 3, 1, "#e4e4e7"], [9, 7 + y, 3, 1, "#e4e4e7"]];
    case "redactor": return [[12, 4 + y, 3, 7, shade(c, 1.3)], [13, 3 + y, 2, 1, shade(c, 1.3)], [2, 8, 1, 4, "#f5f5f4"]];
  }
}

export function creatureFrame(kind: CreatureKind, dir: Dir, frame: 0 | 1 | 2, working: boolean): Rect[] {
  const c = working || kind === "jugador" ? BASE[kind] : "#6b6b76";
  const bob = frame === 1 ? 0 : -1 * Number(working || kind === "jugador");
  const f = features(kind, c, dir, bob);
  const mirrored = dir === "left" ? f.map(([x, y, w, h, col]) => [16 - x - w, y, w, h, col] as Rect) : f;
  return [...body(c, dir, frame, bob), ...mirrored];
}

export const CREATURES = Object.keys(BASE) as CreatureKind[];
```

```ts
// ui/src/office/sprites/skins.ts
import type { CreatureKind } from "../world/placement";
import type { Dir } from "./creatures";

export interface SpriteSpec { file: string; frameW: number; frameH: number; frames: number; rows: Record<Dir, number>; formato?: "gen3" }

const GEN3: Record<"down" | "up" | "left", [walk1: number, stand: number, walk2: number]> = { down: [3, 0, 4], up: [5, 1, 6], left: [7, 2, 8] };
export function gen3Frame(dir: Dir, step: 0 | 1 | 2): { index: number; mirror: boolean } {
  return { index: GEN3[dir === "right" ? "left" : dir][step], mirror: dir === "right" };
}
export interface SkinsConfig { player?: SpriteSpec; roles: Record<string, SpriteSpec>; agents: Record<string, SpriteSpec>; warnings: string[] }
export const EMPTY_SKINS: SkinsConfig = { roles: {}, agents: {}, warnings: [] };

const own = <T>(o: Record<string, T>, k: string | null | undefined): T | undefined => (k && Object.hasOwn(o, k) ? o[k] : undefined);

export function resolveSkin(cfg: SkinsConfig, who: { player?: boolean; agentKey?: string; account?: string | null; rol?: string | null; criatura: CreatureKind }): SpriteSpec | null {
  if (who.player) return cfg.player ?? null;
  return own(cfg.agents, who.account) ?? own(cfg.agents, who.agentKey) ?? own(cfg.roles, who.rol) ?? own(cfg.roles, who.criatura) ?? null;
}

export async function fetchSkins(): Promise<SkinsConfig> {
  const r = await fetch("/api/office/sprites").catch(() => null);
  return r?.ok ? ((await r.json()) as SkinsConfig) : EMPTY_SKINS;
}

/** Carga cada archivo una vez; las que fallan quedan fuera (sin skin → criatura original). */
export async function loadSkinImages(cfg: SkinsConfig): Promise<Map<string, HTMLImageElement>> {
  const files = new Set([cfg.player, ...Object.values(cfg.roles), ...Object.values(cfg.agents)].filter(Boolean).map((s) => s!.file));
  const out = new Map<string, HTMLImageElement>();
  await Promise.all([...files].map((f) => new Promise<void>((res) => {
    const img = new Image();
    img.onload = () => { out.set(f, img); res(); };
    img.onerror = () => res();
    img.src = `/sprites/${encodeURIComponent(f)}`;
  })));
  return out;
}
```

Servidor:

```ts
// src/server/sprites.ts
import fs from "node:fs";
import path from "node:path";

export const SPRITE_FILE = /^[A-Za-z0-9_-]{1,64}\.(png|gif|webp)$/;
export const SPRITE_MIME: Record<string, string> = { png: "image/png", gif: "image/gif", webp: "image/webp" };
const DIRS = ["down", "left", "right", "up"] as const;
const MAX_JSON = 64 * 1024;

export const spritesDir = (): string => process.env.OFFICE_SPRITES_DIR || "C:\\tools\\sprites";

type Spec = { file: string; frameW: number; frameH: number; frames: number; rows: Record<(typeof DIRS)[number], number>; formato?: "gen3" };
export interface SkinsConfig { player?: Spec; roles: Record<string, Spec>; agents: Record<string, Spec>; warnings: string[] }

const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function spec(v: unknown, where: string, warnings: string[]): Spec | null {
  const o = v as Record<string, unknown> | null;
  if (o && o.formato === "gen3") {
    if (typeof o.file === "string" && SPRITE_FILE.test(o.file)) return { file: o.file, frameW: 16, frameH: 32, frames: 9, rows: { down: 0, left: 0, right: 0, up: 0 }, formato: "gen3" };
    warnings.push(`${where}: formato gen3 sin "file" válido (.png/.gif/.webp)`);
    return null;
  }
  const rows = o?.rows as Record<string, unknown> | undefined;
  const ok = o && typeof o.file === "string" && SPRITE_FILE.test(o.file) && int(o.frameW, 8, 128) && int(o.frameH, 8, 128)
    && int(o.frames, 1, 8) && rows && DIRS.every((d) => int(rows[d], 0, 63));
  if (!ok) { warnings.push(`${where}: formato inválido (file .png/.gif/.webp, frameW/frameH 8–128, frames 1–8, rows down/left/right/up 0–63)`); return null; }
  return { file: o.file as string, frameW: o.frameW as number, frameH: o.frameH as number, frames: o.frames as number, rows: Object.fromEntries(DIRS.map((d) => [d, rows![d] as number])) as Spec["rows"] };
}

function group(v: unknown, name: string, warnings: string[]): Record<string, Spec> {
  const out: Record<string, Spec> = {};
  if (v === undefined) return out;
  if (!v || typeof v !== "object" || Array.isArray(v)) { warnings.push(`${name}: debe ser un objeto`); return out; }
  for (const [k, s] of Object.entries(v)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(k)) { warnings.push(`${name}.${k}: nombre inválido`); continue; }
    const p = spec(s, `${name}.${k}`, warnings);
    if (p) out[k] = p;
  }
  return out;
}

export function validateSprites(raw: unknown): SkinsConfig {
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { roles: {}, agents: {}, warnings: ["sprites.json debe ser un objeto"] };
  const o = raw as Record<string, unknown>;
  const player = o.player === undefined ? null : spec(o.player, "player", warnings);
  return { ...(player ? { player } : {}), roles: group(o.roles, "roles", warnings), agents: group(o.agents, "agents", warnings), warnings };
}

export function readSpritesConfig(dir = spritesDir()): SkinsConfig {
  const file = path.join(dir, "sprites.json");
  try {
    if (fs.statSync(file).size > MAX_JSON) return { roles: {}, agents: {}, warnings: ["sprites.json pesa más de 64 KB"] };
    return validateSprites(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { roles: {}, agents: {}, warnings: code === "ENOENT" ? [] : ["sprites.json no se pudo leer o no es JSON"] };
  }
}

/** Ruta real del archivo solo si es un nombre válido y su realpath cae dentro de la carpeta (sin enlaces que escapen). */
export function resolveSpriteFile(name: string, dir = spritesDir()): string | null {
  if (!SPRITE_FILE.test(name)) return null;
  try {
    const root = fs.realpathSync(dir);
    const real = fs.realpathSync(path.join(root, name));
    const rel = path.relative(root, real);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) && fs.statSync(real).isFile() ? real : null;
  } catch { return null; }
}
```

```ts
// src/server/routes/sprites.ts
import fs from "node:fs";
import { Hono } from "hono";
import { readSpritesConfig, resolveSpriteFile, SPRITE_MIME } from "../sprites.js";

export function createSpritesRoute(dir?: string) {
  const app = new Hono();
  app.get("/:file", (c) => {
    const real = resolveSpriteFile(c.req.param("file"), dir);
    if (!real) return c.json({ error: "Sprite no encontrado" }, 404);
    const ext = real.slice(real.lastIndexOf(".") + 1).toLowerCase();
    return c.body(fs.readFileSync(real), 200, {
      "Content-Type": SPRITE_MIME[ext], "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox", "Cache-Control": "no-cache",
    });
  });
  return app;
}

export function createOfficeSpritesRoute(dir?: string) {
  const app = new Hono();
  app.get("/", (c) => c.json(readSpritesConfig(dir)));
  return app;
}
```

En `src/server/index.ts`: `app.route("/api/office/sprites", createOfficeSpritesRoute());` **antes** de `app.route("/api/office", officeRoute)`, y `app.route("/sprites", createSpritesRoute());` **antes** del `serveStatic` de `ui/dist`. En `.env.example`: `# OFFICE_SPRITES_DIR=C:\tools\sprites  # skins propias para la Oficina (fuera del repo; nunca en git)`.

- [ ] **Step 1: Pruebas que fallan**

```ts
// test/server/sprites.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateSprites, readSpritesConfig, resolveSpriteFile } from "../../src/server/sprites.js";
import { createSpritesRoute, createOfficeSpritesRoute } from "../../src/server/routes/sprites.js";

const good = { file: "zorro.png", frameW: 16, frameH: 16, frames: 3, rows: { down: 0, left: 1, right: 2, up: 3 } };
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sprites-"));
  fs.writeFileSync(path.join(dir, "zorro.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(dir, "notas.txt"), "x");
});

describe("sprites.json", () => {
  it("acepta entradas válidas y descarta las inválidas con aviso", () => {
    const cfg = validateSprites({ player: good, roles: { dev: good, qa: { ...good, frames: 99 } }, agents: { "../x": good, agy2: { ...good, file: "a.svg" } } });
    expect(cfg.player).toEqual(good);
    expect(Object.keys(cfg.roles)).toEqual(["dev"]);
    expect(cfg.agents).toEqual({});
    expect(cfg.warnings).toHaveLength(3);
    expect(validateSprites([]).warnings).toEqual(["sprites.json debe ser un objeto"]);
  });

  it("formato gen3: basta file + formato; se expande a 16×32 × 9", () => {
    const cfg = validateSprites({ roles: { dev: { file: "dev.png", formato: "gen3" }, qa: { formato: "gen3" } } });
    expect(cfg.roles.dev).toEqual({ file: "dev.png", frameW: 16, frameH: 32, frames: 9, rows: { down: 0, left: 0, right: 0, up: 0 }, formato: "gen3" });
    expect(cfg.roles.qa).toBeUndefined();
    expect(cfg.warnings).toHaveLength(1);
  });

  it("sin carpeta o sin sprites.json → vacío sin avisos; JSON roto → aviso", () => {
    expect(readSpritesConfig(path.join(dir, "no"))).toEqual({ roles: {}, agents: {}, warnings: [] });
    fs.writeFileSync(path.join(dir, "sprites.json"), "{roto");
    expect(readSpritesConfig(dir).warnings).toHaveLength(1);
  });

  it("resolveSpriteFile: solo nombres simples de imagen dentro de la carpeta", () => {
    expect(resolveSpriteFile("zorro.png", dir)).toBe(fs.realpathSync(path.join(dir, "zorro.png")));
    for (const bad of ["notas.txt", "../zorro.png", "..\\zorro.png", "sub/zorro.png", "zorro.svg", "falta.png"]) expect(resolveSpriteFile(bad, dir), bad).toBeNull();
  });

  it("rutas: imagen con nosniff y CSP; traversal → 404; /api/office/sprites lee la config", async () => {
    const r = await createSpritesRoute(dir).request("/zorro.png");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toBe("sandbox");
    expect((await createSpritesRoute(dir).request("/..%2Fzorro.png")).status).toBe(404);
    expect((await createSpritesRoute(dir).request("/notas.txt")).status).toBe(404);
    fs.writeFileSync(path.join(dir, "sprites.json"), JSON.stringify({ roles: { dev: good } }));
    expect(await (await createOfficeSpritesRoute(dir).request("/")).json()).toEqual({ roles: { dev: good }, agents: {}, warnings: [] });
  });
});
```

```ts
// test/ui/sprites.test.ts
import { describe, it, expect } from "vitest";
import { creatureFrame, CREATURES } from "../../ui/src/office/sprites/creatures";
import { resolveSkin, gen3Frame, EMPTY_SKINS, type SpriteSpec } from "../../ui/src/office/sprites/skins";

const s = (file: string): SpriteSpec => ({ file, frameW: 16, frameH: 16, frames: 3, rows: { down: 0, left: 1, right: 2, up: 3 } });

describe("criaturas originales", () => {
  it("cada especie dibuja en 16×16 en las 4 direcciones y 3 cuadros", () => {
    expect(CREATURES).toHaveLength(14);
    for (const k of CREATURES) for (const d of ["down", "up", "left", "right"] as const) for (const f of [0, 1, 2] as const) {
      const rects = creatureFrame(k, d, f, true);
      expect(rects.length).toBeGreaterThan(5);
      for (const [x, , w] of rects) { expect(x).toBeGreaterThanOrEqual(0); expect(x + w).toBeLessThanOrEqual(16); }
    }
  });
  it("en reposo el cuerpo es gris; el jugador conserva su color", () => {
    expect(creatureFrame("dev", "down", 1, false).some((r) => r[4] === "#6b6b76")).toBe(true);
    expect(creatureFrame("jugador", "down", 1, false).some((r) => r[4] === "#e11d48")).toBe(true);
  });
  it("izquierda es el espejo de derecha en los rasgos", () => {
    expect(creatureFrame("dev", "left", 1, true)).not.toEqual(creatureFrame("dev", "right", 1, true));
  });
});

describe("gen3Frame", () => {
  it("orden de la hoja gen3; derecha = espejo de izquierda", () => {
    expect(gen3Frame("down", 1)).toEqual({ index: 0, mirror: false });
    expect(gen3Frame("up", 1)).toEqual({ index: 1, mirror: false });
    expect(gen3Frame("down", 0)).toEqual({ index: 3, mirror: false });
    expect(gen3Frame("up", 2)).toEqual({ index: 6, mirror: false });
    expect(gen3Frame("left", 2)).toEqual({ index: 8, mirror: false });
    expect(gen3Frame("right", 1)).toEqual({ index: 2, mirror: true });
  });
});

describe("resolveSkin", () => {
  it("prioridad: cuenta → agente → rol → criatura; jugador aparte; sin skin → null", () => {
    const cfg = { ...EMPTY_SKINS, player: s("yo.png"), roles: { dev: s("dev.png"), agy: s("robot.png") }, agents: { agy2: s("a2.png") } };
    expect(resolveSkin(cfg, { player: true, criatura: "jugador" })?.file).toBe("yo.png");
    expect(resolveSkin(cfg, { account: "agy2", rol: "dev", criatura: "dev" })?.file).toBe("a2.png");
    expect(resolveSkin(cfg, { account: "agy3", rol: "dev", criatura: "dev" })?.file).toBe("dev.png");
    expect(resolveSkin(cfg, { account: "agy3", rol: null, criatura: "agy" })?.file).toBe("robot.png");
    expect(resolveSkin(cfg, { account: "agy3", rol: null, criatura: "jefe" })).toBeNull();
    expect(resolveSkin(cfg, { account: "constructor", criatura: "jefe" })).toBeNull();
  });
});
```

**Sprites generados por el orquestador (plan `fa75a0a7`, proyecto `C:\estudio\oficina-sprites`):** son arte original en formato gen3. Si el controlador los aprueba, se copian a `ui/public/oficina/sprites/*.png` + `ui/public/oficina/sprites/sprites.json` (dentro del repo: son propios) y `fetchSkins` los usa como **capa base**: orden final = skins del usuario (`/api/office/sprites`) → sprites del repo (`/oficina/sprites/sprites.json`) → criaturas por código. `resolveSkin` recibe la config ya combinada (`mergeSkins(base, user)`: el usuario gana por clave; exportarla y probarla con un caso). Si no se aprueban, esta parte se omite.

Si la prueba "x + w ≤ 16" falla por un rasgo, ajustar las coordenadas de ese rasgo (no relajar la prueba). Rasgos con `y` negativa (orejas de conejo) están permitidos: el render dibuja la caja desplazada 4 px hacia arriba (Task 4).

- [ ] **Step 2: Correr y ver que fallan** — `npx vitest run test/server/sprites.test.ts test/ui/sprites.test.ts` → FAIL.
- [ ] **Step 3: Implementar** los cuatro archivos de arriba y montar las rutas.
- [ ] **Step 4: Correr** las pruebas → PASS; `npm test` completo.
- [ ] **Step 5: Commit**

```bash
git add ui/src/office/sprites src/server/sprites.ts src/server/routes/sprites.ts src/server/index.ts .env.example test/server/sprites.test.ts test/ui/sprites.test.ts
git commit -m "F12 tarea 3: criaturas originales y skins del usuario fuera del repo"
```

---

### Task 4: Mundo jugable (canvas, bucle, entrada, elevador)

**Files:**
- Create: `ui/src/office/world/input.ts`, `ui/src/office/world/render.ts`, `ui/src/components/office/OfficeWorld.tsx`
- Test: `test/ui/world-input.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 (`floorOf`, `FLOORS`, `findPath`, `isNear`, `key`, `placeAgents`, `planRoute`, `WorldAgent`, `Place`, `Leg`, `creatureFrame`, `Dir`, `resolveSkin`, `fetchSkins`, `loadSkinImages`).
- Produces: `screenToTile(clientX, clientY, rect: { left: number; top: number; width: number; height: number }, cols: number, rows: number): Tile | null`; `keyToDir(key: string): Dir | null` (flechas y WASD, minúsculas o mayúsculas); `DIR_DELTA: Record<Dir, Tile>`; `fitScale(containerW: number, mapW: number, preferred = 3): number` (entero, `min(preferred, floor(containerW / (mapW*16)))`, mínimo 1); `dirBetween(a: Tile, b: Tile): Dir`; `drawFloor(ctx, map, t: number)`; `drawCreature(ctx, rects: Rect[], px: number, py: number)`; `<OfficeWorld state={OfficeState | undefined} onOpenPlan={(id: string) => void} onNear={(a: WorldAgent | null) => void} />`.

Comportamiento de `OfficeWorld`:
- **Estado en refs** (no en React): `player: { piso, tile, dir, frame, route: Tile[], moving: { from, to, t0 } | null }`, `agents: Map<key, { agent: WorldAgent; place: Place; legs: Leg[]; dir; frame; moving }>`, `piso` visible = el del jugador. React solo guarda el agente cercano (para el cuadro, Task 5) y si el menú del elevador está abierto.
- **Bucle de paso fijo a 60 Hz** (acumulador sobre `requestAnimationFrame`; como máximo 4 pasos por cuadro para no "ponerse al día" de golpe); con `document.hidden` no dibuja ni avanza (escuchar `visibilitychange` y reanudar sin acumular el tiempo oculto).
- **Mecánica estilo GBA 3.ª gen. (reglas, escritas desde cero):**
  - Caminar: **16 pasos (cuadros de 60 Hz) por casilla**; correr con **Shift** sostenido: **8 por casilla**. Posición interpolada de forma lineal.
  - Animación: en cada casilla recorrida alterna paso 1 / paso 2 (cambia en la mitad de la casilla); al detenerse, de pie.
  - Girar: si se pulsa una dirección distinta a la que mira, primero solo gira; si la tecla sigue sostenida **8 pasos** después, empieza a caminar. Si ya mira hacia allá, camina de inmediato.
  - Chocar: si la casilla de enfrente es sólida u ocupada, gira y hace la animación de caminar en su lugar (16 pasos) sin moverse; no repite el choque mientras la tecla siga sostenida contra la misma casilla, solo se queda caminando en su lugar.
  - Al terminar una casilla con la tecla sostenida, encadena la siguiente sin pausa.
  - Los NPC (agentes **en reposo** en la sala de descanso) **deambulan**: cada 2–5 s (aleatorio) intentan moverse 1 casilla al azar dentro de su zona si está libre, y vuelven a su asiento cuando el estado les asigna uno nuevo. Con reduced motion no deambulan.
  - Capas: primero piso y muebles bajos; luego personajes ordenados por `y`; al final la **capa de arriba** (la parte alta de libreros `B`, paredes `#` y plantas `*` que caen sobre la casilla de abajo), para que un personaje detrás de un mueble quede tapado.
- Las skins `gen3` miden 16×32: se dibujan con el borde de abajo alineado al de la casilla (16 px salen hacia arriba) y se eligen con `gen3Frame`; las criaturas por código (16×16) se dibujan 4 px más arriba.
- **Reduced motion** (`matchMedia("(prefers-reduced-motion: reduce)")`, leer una vez): sin interpolación; el jugador salta a la casilla final de su ruta; los agentes aparecen directo en su destino.
- **Agentes:** en cada `state` nuevo, `placeAgents(state, prevPlaces)` da el destino; si cambió el lugar de un agente, `legs = planRoute(lugarActual, destino)`; si la ruta total pasa de **40 casillas**, o el agente aún tenía más de 12 casillas pendientes, se teletransporta (spec: "si la animación no alcanza"). Al terminar un tramo en el elevador cambia de piso. Los agentes de otros pisos no se dibujan.
- **Jugador:** aparece en `floorOf(1).salida`. **Clic** en el canvas → `screenToTile` → si hay un agente en esa casilla, el destino es una vecina libre de él (usar `findPath` con la casilla del agente en `occupied`); si no, `findPath` al punto. **Flechas/WASD** solo con el canvas enfocado (`tabIndex=0`): se lleva un conjunto de teclas sostenidas (`keydown`/`keyup`, `blur` lo vacía; ignorar el `repeat` del navegador) y el bucle aplica las reglas de girar/caminar/chocar de arriba; la última dirección pulsada gana. `preventDefault` en flechas. Clic y teclado se cancelan entre sí (una tecla borra la ruta del clic). Las casillas de agentes del piso actual son `occupied` para el jugador.
- **Elevador:** al pisar `E` se abre un menú DOM superpuesto (`role="menu"`, botones "1 · Dirección y Recepción", "2 · Desarrollo y Pruebas", "3 · Estudio y Biblioteca", "salir"); teclas 1–3 eligen y Esc cierra. Al elegir un piso: el jugador aparece en `llegada` de ese piso mirando abajo; "salir" lo deja en la `llegada` del piso actual. Mientras el menú está abierto no hay movimiento.
- **Dibujo:** canvas de `cols*16 × rows*16` px (el piso más ancho: 30×16), escalado por CSS a `fitScale(anchoContenedor, 30)` (medido con `ResizeObserver`), `image-rendering: pixelated`. Cada cuadro: `drawFloor` (baldosas como en el prototipo: pared, escritorio con monitor, planta, librero, sofá, elevador con foco que parpadea; el foco no parpadea con reduced motion), etiquetas de zona (texto 6 px `Silkscreen` si ya está cargada, si no `monospace`, color de la zona) y un rectángulo de borde tenue por zona; luego las entidades ordenadas por `y` (las de abajo encima). Cada persona: skin si `resolveSkin` da una y su imagen cargó (gen3: `gen3Frame` y espejo con `scale(-1, 1)`; otras: cuadro × fila `rows[dir]`), si no `creatureFrame`. Sobre los agentes que trabajan, un globo amarillo de 4×4 (como el prototipo). HUD DOM arriba a la izquierda con el nombre del piso.
- `aria-label` del canvas: `"Oficina, ${nombre del piso}. Usa clic o flechas para caminar."`.

- [ ] **Step 1: Prueba que falla**

```ts
// test/ui/world-input.test.ts
import { describe, it, expect } from "vitest";
import { screenToTile, keyToDir, fitScale, dirBetween, DIR_DELTA } from "../../ui/src/office/world/input";

describe("entrada del mundo", () => {
  const rect = { left: 100, top: 50, width: 1440, height: 768 }; // 30×16 casillas a ×3
  it("screenToTile convierte coordenadas de pantalla a casilla; fuera del canvas → null", () => {
    expect(screenToTile(100, 50, rect, 30, 16)).toEqual([0, 0]);
    expect(screenToTile(100 + 48 * 15 + 10, 50 + 48 * 2 + 47, rect, 30, 16)).toEqual([15, 2]);
    expect(screenToTile(99, 60, rect, 30, 16)).toBeNull();
    expect(screenToTile(100 + 1440, 60, rect, 30, 16)).toBeNull();
  });
  it("keyToDir: flechas y WASD en ambas mayúsculas; otras teclas null", () => {
    expect(["ArrowUp", "w", "W"].map(keyToDir)).toEqual(["up", "up", "up"]);
    expect(["ArrowLeft", "a", "ArrowDown", "s", "ArrowRight", "D"].map(keyToDir)).toEqual(["left", "left", "down", "down", "right", "right"]);
    expect(keyToDir("Enter")).toBeNull();
    expect(DIR_DELTA.up).toEqual([0, -1]);
  });
  it("fitScale: ×3 si cabe, menos si no, nunca menos de 1", () => {
    expect(fitScale(2000, 30)).toBe(3);
    expect(fitScale(1000, 30)).toBe(2);
    expect(fitScale(300, 30)).toBe(1);
    expect(fitScale(2000, 30, 4)).toBe(4);
  });
  it("dirBetween mira hacia la casilla siguiente", () => {
    expect(dirBetween([5, 5], [5, 4])).toBe("up");
    expect(dirBetween([5, 5], [4, 5])).toBe("left");
    expect(dirBetween([5, 5], [6, 5])).toBe("right");
    expect(dirBetween([5, 5], [5, 6])).toBe("down");
  });
});
```

- [ ] **Step 2: Correr y ver que falla** — `npx vitest run test/ui/world-input.test.ts` → FAIL.

- [ ] **Step 3: Implementar `input.ts`**

```ts
// ui/src/office/world/input.ts
import type { Dir } from "../sprites/creatures";
import type { Tile } from "./types";

export const DIR_DELTA: Record<Dir, Tile> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const KEYS: Record<string, Dir> = { arrowup: "up", w: "up", arrowdown: "down", s: "down", arrowleft: "left", a: "left", arrowright: "right", d: "right" };

export const keyToDir = (key: string): Dir | null => KEYS[key.toLowerCase()] ?? null;

export function screenToTile(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, cols: number, rows: number): Tile | null {
  const fx = (clientX - rect.left) / rect.width, fy = (clientY - rect.top) / rect.height;
  if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return null;
  return [Math.floor(fx * cols), Math.floor(fy * rows)];
}

export const fitScale = (containerW: number, mapW: number, preferred = 3): number =>
  Math.max(1, Math.min(preferred, Math.floor(containerW / (mapW * 16))));

export function dirBetween(a: Tile, b: Tile): Dir {
  if (b[1] < a[1]) return "up";
  if (b[1] > a[1]) return "down";
  return b[0] < a[0] ? "left" : "right";
}
```

- [ ] **Step 4: Correr la prueba** → PASS.

Agregar a `input.ts` y a su prueba la máquina de movimiento pura (para no probar el canvas): `type Mover = { tile: Tile; dir: Dir; from: Tile | null; t: number; frames: number; step: 0 | 1 | 2; parity: 0 | 1; turnWait: number; bumping: boolean }`; `tickMover(m: Mover, held: Dir | null, run: boolean, blocked: (t: Tile) => boolean): Mover` (un paso de 60 Hz; devuelve un objeto nuevo). Casos de prueba obligatorios: (a) sostener la dirección que ya mira → tras 16 ticks está en la casilla vecina y `step` volvió a 1; (b) con `run` → 8 ticks; (c) pulsar otra dirección 3 ticks y soltar → solo giró, misma casilla; (d) sostenerla 8 ticks → empieza a moverse; (e) contra pared → no cambia de casilla tras 32 ticks y `bumping` es `true`; (f) sostener 2 casillas seguidas → 32 ticks, 2 casillas, la animación alternó paso 1 y paso 2.

- [ ] **Step 5: Implementar `render.ts` y `OfficeWorld.tsx`** siguiendo el comportamiento de arriba. Copiar el dibujo de baldosas de `tile()` del prototipo `f12-oficina-jugable-prototipo.html` (mapeo de caracteres: `#` pared, `=` escritorio "D", `*` planta "P", `B` librero, `S` sofá, `E` elevador; `s` y `p` se dibujan como piso, con un tapete `#ffffff10` de 12×12 en `s`). Nuevos: `|` y `-` mampara (panel gris azulado `#3a3f4b` de 4 px de ancho/alto centrado, con borde claro arriba), `d` puerta (marco café `#5b4636` en los lados y piso más claro). `OfficeWorld` todavía no muestra el cuadro de diálogo: solo llama `onNear(agenteCercano | null)` cuando cambia el agente vecino (`isNear` entre el jugador y algún agente del piso actual; si hay varios, el primero por orden de `key`).

- [ ] **Step 6: Revisión visual temporal.** Montar `OfficeWorld` provisionalmente en `OfficeView` (la integración final es la Task 5), `npm run build:ui`, backend en :3111 (`ORQUESTADOR_PORT=3111 npm start` en segundo plano), abrir `http://127.0.0.1:3111/?vista=oficina` en el navegador integrado a 1300 px: caminar con clic y con flechas, entrar al elevador, cambiar a los 3 pisos, ver criaturas de colores en sus zonas; probar a 700 px (escala ×1). Guardar capturas en `.superpowers/sdd/2026-10-15-f12-oficina-jugable/mundo-piso{1,2,3}.png`. Detener :3111.

- [ ] **Step 7: Commit**

```bash
git add ui/src/office/world/input.ts ui/src/office/world/render.ts ui/src/components/office/OfficeWorld.tsx test/ui/world-input.test.ts ui/src/components/office/OfficeView.tsx
git commit -m "F12 tarea 4: mundo jugable con pisos, elevador, clic y teclado"
```

---

### Task 5: Cuadro de diálogo e integración en la Oficina

**Files:**
- Create: `ui/src/office/world/dialog.ts`, `ui/src/components/office/WorldDialog.tsx`
- Modify: `ui/src/components/office/OfficeView.tsx`, `ui/src/components/office/OfficeScene.tsx` (exportar `AccountRack`/`OfficeTalkPanel` donde ya se usan, sin cambiar su comportamiento), `ui/src/lib/office-view.ts` (modo)
- Test: `test/ui/world-dialog.test.ts`, `test/ui/office-view.test.ts` (agregar caso de `readOfficeMode`)

**Interfaces:**
- Consumes: `WorldAgent` (Task 2), `OfficeWorld` con `onNear` (Task 4), `useWs().officeLog` (`OfficeLogEntry` en `ui/src/lib/office.ts`/`WebSocketProvider`), `roleTag` de `ui/src/lib/roles.ts`, `formatTokens` de `ui/src/lib/format.ts` (si se llama distinto, usar el formateador de tokens existente).
- Produces: `dialogFor(a: WorldAgent): { titulo: string; estado: "TRABAJANDO" | "EN ESPERA" | "EN REPOSO"; lineas: string[]; planId: string | null }`; `type OfficeMode = "mundo" | "escritorios"`; `MODE_KEY = "orquestador.oficina.modo"`; `readOfficeMode(stored: string | null): OfficeMode` (default `"mundo"`, valores inválidos → `"mundo"`).

Reglas de `dialogFor`:
- `titulo`: agentes de agy `"<ROL> · <nombre>"` si trabaja con rol (`roleTag(rol)`), `"AGY · <nombre>"` si no; fijos: su `nombre`.
- `estado`: `paused` → `"EN ESPERA"`, `working` → `"TRABAJANDO"`, si no `"EN REPOSO"`.
- `lineas` (solo las que tengan dato, en este orden): `activity` (o `"libre, en la sala de descanso"` para un agy en reposo); `"paso <stepKey> · <done>/<total> pasos del plan"` (si hay `progress`; sin `stepKey` → `"<done>/<total> pasos del plan"`); `"modelo: <model>"`; `"tokens: <formatTokens(tokens)>"` (solo si `tokens` es número > 0); `"cuenta: <cuenta>"` (agy).
- `planId` = el del agente.

`WorldDialog` (DOM sobre el canvas, abajo, estilo del prototipo: fondo `#0b0b10`, borde 4 px `#e4e4e7`, sombra 4 px negra, VT323 si está cargada), **caja de texto estilo GBA**: el texto (título + líneas) se parte en páginas de **2 líneas**; cada página se escribe letra por letra a **1 carácter cada 2 pasos de 60 Hz** (instantánea con reduced motion); al completarse una página parpadea un **▼** abajo a la derecha; **Enter, Espacio, Z o clic** completan la página si aún se escribe, o pasan a la siguiente; tras la última, el cuadro queda en la última página hasta que el jugador se aleja. Lógica pura `paginate(lines: string[], maxChars = 42): string[][]` (corta por palabras; agregar casos a `test/ui/world-dialog.test.ts`: una línea larga se parte en 2; 5 líneas → 3 páginas). El texto completo de la página actual va en un nodo `sr-only` con `aria-live="polite"` (los lectores de pantalla no leen letra por letra); título con el color del agente + estado; las líneas; botones **"abrir plan"** (solo con `planId`; llama `onOpenPlan(planId)`, que en `OfficeView` ya respeta el bloqueo de Platicar) y **"ver log"** (despliega dentro del cuadro las últimas 5 entradas de `officeLog` cuyo `agent` corresponda: `agy` para agentes de agy, su id para los fijos). Con el menú del elevador abierto, el cuadro se oculta.

Integración en `OfficeView`:
- Selector pequeño "mundo · escritorios" (`aria-pressed`) arriba de la escena; el modo se guarda en `localStorage[MODE_KEY]` (try/catch, como `VIEW_KEY`).
- `mundo`: `OfficeWorld` + `WorldDialog` en el lugar de `OfficeScene`; `AccountRack` y `OfficeTalkPanel` (que hoy viven dentro de `OfficeScene`) se muestran en la columna lateral, arriba de `QueuePanel`, para que Platicar siga a mano. `escritorios`: todo como hoy.
- `AgentCards`, cola, planes, trabajadores y log siguen visibles en ambos modos.

- [ ] **Step 1: Pruebas que fallan**

```ts
// test/ui/world-dialog.test.ts
import { describe, it, expect } from "vitest";
import { dialogFor } from "../../ui/src/office/world/dialog";
import type { WorldAgent } from "../../ui/src/office/world/placement";

const a = (x: Partial<WorldAgent>): WorldAgent => ({
  key: "agy:agy3", nombre: "agy3", rol: null, cuenta: "agy3", color: "#60a5fa", criatura: "agy", working: false, paused: false,
  activity: "libre", model: null, tokens: null, planId: null, stepKey: null, progress: null, piso: 1, tile: [3, 11], ...x,
});

describe("cuadro de diálogo", () => {
  it("agy trabajando con rol: título con rol, paso y avance, modelo, cuenta y plan", () => {
    const d = dialogFor(a({ working: true, rol: "dev", criatura: "dev", activity: "Crear src/slug.mjs", model: "claude-sonnet-4-6", planId: "p1", stepKey: "s2", progress: { done: 1, total: 4 } }));
    expect(d).toEqual({
      titulo: "DEV · agy3", estado: "TRABAJANDO", planId: "p1",
      lineas: ["Crear src/slug.mjs", "paso s2 · 1/4 pasos del plan", "modelo: claude-sonnet-4-6", "cuenta: agy3"],
    });
  });
  it("agy libre: en la sala de descanso, sin plan", () => {
    expect(dialogFor(a({}))).toEqual({ titulo: "AGY · agy3", estado: "EN REPOSO", planId: null, lineas: ["libre, en la sala de descanso", "cuenta: agy3"] });
  });
  it("fijo en espera con tokens", () => {
    const d = dialogFor(a({ key: "guardia", nombre: "GUARDIA", cuenta: null, criatura: "guardia", paused: true, working: true, activity: "pausó 1 paso", tokens: 0 }));
    expect(d.titulo).toBe("GUARDIA");
    expect(d.estado).toBe("EN ESPERA");
    expect(d.lineas).toEqual(["pausó 1 paso"]);
  });
});
```

En `test/ui/office-view.test.ts` agregar:

```ts
it("readOfficeMode: mundo por defecto; escritorios si está guardado; inválido → mundo", () => {
  expect(readOfficeMode(null)).toBe("mundo");
  expect(readOfficeMode("escritorios")).toBe("escritorios");
  expect(readOfficeMode("otro")).toBe("mundo");
});
```

- [ ] **Step 2: Correr y ver que fallan** — `npx vitest run test/ui/world-dialog.test.ts test/ui/office-view.test.ts` → FAIL.

- [ ] **Step 3: Implementar**

```ts
// ui/src/office/world/dialog.ts
import { roleTag } from "../../lib/roles";
import { formatTokens } from "../../lib/format";
import type { WorldAgent } from "./placement";

export function dialogFor(a: WorldAgent): { titulo: string; estado: "TRABAJANDO" | "EN ESPERA" | "EN REPOSO"; lineas: string[]; planId: string | null } {
  const agy = a.key.startsWith("agy:");
  const titulo = agy ? `${a.working && a.rol ? roleTag(a.rol) : "AGY"} · ${a.nombre}` : a.nombre;
  const estado = a.paused ? "EN ESPERA" : a.working ? "TRABAJANDO" : "EN REPOSO";
  const lineas: string[] = [];
  const act = agy && !a.working ? "libre, en la sala de descanso" : a.activity;
  if (act) lineas.push(act);
  if (a.progress) lineas.push(`${a.stepKey ? `paso ${a.stepKey} · ` : ""}${a.progress.done}/${a.progress.total} pasos del plan`);
  if (a.model) lineas.push(`modelo: ${a.model}`);
  if (typeof a.tokens === "number" && a.tokens > 0) lineas.push(`tokens: ${formatTokens(a.tokens)}`);
  if (agy && a.cuenta) lineas.push(`cuenta: ${a.cuenta}`);
  return { titulo, estado, lineas, planId: a.planId };
}
```

En `ui/src/lib/office-view.ts`:

```ts
export type OfficeMode = "mundo" | "escritorios";
export const MODE_KEY = "orquestador.oficina.modo";
export const readOfficeMode = (stored: string | null): OfficeMode => (stored === "escritorios" ? "escritorios" : "mundo");
```

Luego `WorldDialog.tsx` y la integración en `OfficeView.tsx` según las reglas de arriba.

- [ ] **Step 4: Correr las pruebas** → PASS; `npm test`, `npm run lint`, `npm run typecheck`, `npm run build:ui`.

- [ ] **Step 5: Revisión visual.** :3111 como en la Task 4: acercarse a JEFE (piso 1), a un agy en descanso y, si hay un plan corriendo, a un agente trabajando; "ver log"; "abrir plan" lleva al plan en Chat; con Platicar activo "abrir plan" no sale de la Oficina; el modo "escritorios" se ve como antes; reduced motion (emularlo con DevTools si el navegador integrado lo permite; si no, anotarlo como no verificado). Capturas en `.superpowers/sdd/2026-10-15-f12-oficina-jugable/dialogo.png` y `escritorios.png`. Detener :3111.

- [ ] **Step 6: Commit**

```bash
git add ui/src/office/world/dialog.ts ui/src/components/office/WorldDialog.tsx ui/src/components/office/OfficeView.tsx ui/src/components/office/OfficeScene.tsx ui/src/lib/office-view.ts test/ui/world-dialog.test.ts test/ui/office-view.test.ts
git commit -m "F12 tarea 5: cuadro de diálogo y modo mundo en la Oficina"
```

---

### Task 6: Verificación en vivo y documentación

- [ ] **Step 1:** Con el orquestador en :3110 (reiniciado con esta rama y `npm run build:ui`), correr un plan real de 3–4 pasos con roles en el proyecto de prueba `C:\estudio\f11-demo` y, con la Oficina en modo mundo, verificar: cada agy camina (o se teletransporta) al piso y zona de su rol al tomar el paso y vuelve a la sala de descanso al terminar; el cuadro de un agente trabajando muestra paso, avance y modelo; JEFE se ve trabajando mientras planea/sintetiza. Capturas en `.superpowers/sdd/2026-10-15-f12-oficina-jugable/en-vivo-*.png`.
- [ ] **Step 2:** Skins: con `OFFICE_SPRITES_DIR` apuntando a una carpeta temporal del scratchpad con un PNG **generado por código** (p. ej. un cuadro de colores de 64×64 dibujado con `node` + un PNG mínimo), y un `sprites.json` que lo asigne a `roles.dev`, verificar que el DEV usa la skin y que sin carpeta todo vuelve a las criaturas originales. **No descargar ni copiar sprites de terceros.**
- [ ] **Step 3:** Docs: sección `## Playable office (F12)` en `CLAUDE.md` (módulos, mapas y leyenda, reglas de colocación, `planRoute`, controles, elevador, cuadro, sprites originales y skins con formato de `sprites.json` y `OFFICE_SPRITES_DIR`, seguridad de `/sprites`, accesibilidad, resultados en vivo y pendientes); `CONTINUAR.md`; nota de Cerebro `20-Personal/Orquestador-IA.md` y su línea en `00-INICIO.md`. Integrar a main solo con OK del usuario.
- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md CONTINUAR.md
git commit -m "F12 tarea 6: verificación en vivo y documentación de la Oficina jugable"
```

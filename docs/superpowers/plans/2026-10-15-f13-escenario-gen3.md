# F13 — Escenario propio (mapas gen3) · plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que la Oficina jugable (F12) dibuje sus pisos con mapas de tiles externos (carpeta local fuera de git) en lugar de las rejillas por código, con 6 pisos de Esmeralda servidos desde `C:\tools\escenario`.

**Architecture:** el servidor lee y valida `escenario.json` + un JSON por mapa y los sirve juntos en `GET /api/office/escenario`; los atlas PNG salen por `GET /escenario/<archivo>.png` con la resolución segura de `sprites.ts`. La UI convierte cada piso a `FloorMap` (colisión → `#`/`.`, puestos → `s`, elevador → `E`), reemplaza `FLOORS` antes de montar el mundo y dibuja las capas `abajo`/`arriba` desde el atlas. Sin escenario o inválido → los 3 pisos de F12.

**Tech Stack:** Hono (servidor), React 19 + canvas 2D (UI), vitest, tsx. Sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-10-15-f13-escenario-gen3-design.md` · **Rama:** `f13-escenario-gen3`.

## Global Constraints

- Sin dependencias nuevas; sin paso de build nuevo.
- **Nada de arte ni mapas de Esmeralda en el repo** (ni en `ui/public`, ni en `test/`). Las pruebas usan un mapa sintético.
- Sala limpia (F12): el código sale del formato de datos observado en el paquete; no se abre ni copia código de pokeemerald ni de `C:\GAMES_N_SHIT\`.
- Carpeta: `OFFICE_ESCENARIO_DIR`, default `C:\tools\escenario` (leída en cada uso, nunca al importar).
- Bloque = uint16: bits 0–9 metatile, 10–11 colisión, 12–15 elevación. Atlas de 256 px de ancho, metatiles 16×16 en filas de 16, indexados por metatile. Archivos `<atlas>-abajo.png` y `<atlas>-arriba.png` (guion, no punto).
- Límites: `escenario.json` ≤ 64 KB, cada mapa ≤ 256 KB, 1–9 pisos, `ancho`/`alto` 1–64, ≤ 16 zonas por piso, ≤ 32 puestos por zona, atlas `[A-Za-z0-9_]{1,50}`, zona `[a-z0-9-]{1,32}`, color `#rrggbb`.
- Zonas obligatorias (en algún piso): `descanso`, `dev`, `qa`, `imagen`, `investigador`, `lector`, `redactor`. Fijos obligatorios, exactamente una vez: `jefe`, `guardia`, `recepcion`, `biblio`, `claude`, `codex`. `salida` obligatoria en el piso 1 y prohibida en los demás.
- Escenario inválido → `{ pisos: [], warnings: [mensaje] }` (nunca un escenario a medias).
- Textos de UI y mensajes en español; código e identificadores en inglés o como los ya existentes; commits en español terminando con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; nunca stagear `.superpowers/` ni `AGENTS.md`.
- Importaciones del servidor con sufijo `.js` (ESM); las de `ui/` sin sufijo.
- Calidad al cerrar cada tarea: `npm test`, `npm run lint`, `npm run typecheck` en verde.

---

### Task 1: Validador y lector del escenario (servidor)

**Files:**
- Modify: `src/server/sprites.ts` (`resolveSpriteFile` acepta la regex)
- Create: `src/server/escenario.ts`
- Create: `test/fixtures/escenario-sintetico.ts`
- Test: `test/server/escenario.test.ts`

**Interfaces:**
- Consumes: `resolveSpriteFile(name, dir?, re?)` de `src/server/sprites.ts`.
- Produces (`src/server/escenario.ts`):
  - `escenarioDir(): string`
  - `ESCENARIO_PNG: RegExp` (`/^[A-Za-z0-9_-]{1,64}\.png$/`)
  - `type Tile = [number, number]`
  - `interface EscenarioZona { id: string; etiqueta: string; color: string; x: number; y: number; w: number; h: number; puestos: Tile[]; fijos: Record<string, Tile> }`
  - `interface EscenarioPiso { nombre: string; elevador: Tile; llegada: Tile; salida?: Tile; zonas: EscenarioZona[]; ancho: number; alto: number; bloques: number[]; atlas: string }`
  - `interface Escenario { pisos: EscenarioPiso[]; warnings: string[] }`
  - `validateEscenario(raw: unknown, readMap: (file: string) => unknown): Escenario`
  - `readEscenario(dir?: string): Escenario`
- Produces (`test/fixtures/escenario-sintetico.ts`): `ANCHO`, `ALTO`, `MAPA`, `ESCENARIO` (usados también en Task 3).

- [ ] **Step 1: Generalizar `resolveSpriteFile`**

En `src/server/sprites.ts` cambia la firma (el resto igual):

```ts
/** Ruta real del archivo solo si el nombre pasa `re` y su realpath cae dentro de la carpeta (sin enlaces que escapen). */
export function resolveSpriteFile(name: string, dir = spritesDir(), re: RegExp = SPRITE_FILE): string | null {
  if (!re.test(name)) return null;
```

Run: `npx vitest run test/server/sprites.test.ts` → PASS (comportamiento igual).

- [ ] **Step 2: Fixture sintético**

Create `test/fixtures/escenario-sintetico.ts`:

```ts
// Escenario sintético para pruebas (sin datos de Esmeralda): 12×6, borde con colisión, interior libre.
export const ANCHO = 12, ALTO = 6;
const borde = (x: number, y: number) => x === 0 || y === 0 || x === ANCHO - 1 || y === ALTO - 1;
// 1025 = colisión 1 + metatile 1; 2 = metatile 2 sin colisión.
export const MAPA = {
  ancho: ANCHO, alto: ALTO, atlas: "gTileset_Prueba", objetos: [],
  bloques: Array.from({ length: ANCHO * ALTO }, (_, i) => (borde(i % ANCHO, Math.floor(i / ANCHO)) ? 1025 : 2)),
};
const ROLES = ["descanso", "dev", "qa", "imagen", "investigador", "lector", "redactor"];
export const ESCENARIO = {
  pisos: [{
    mapa: "prueba.json", nombre: "PISO 1 · PRUEBA", elevador: [10, 1], llegada: [10, 2], salida: [9, 2],
    zonas: [
      ...ROLES.map((id, i) => ({ id, etiqueta: id.toUpperCase(), color: "#60a5fa", x: 1 + i, y: 1, w: 1, h: 1, puestos: [[1 + i, 1]] })),
      {
        id: "oficina", etiqueta: "OFICINA", color: "#a78bfa", x: 1, y: 3, w: 10, h: 2,
        fijos: { jefe: [1, 3], guardia: [2, 3], recepcion: [3, 3], biblio: [4, 3], claude: [5, 3], codex: [6, 3] },
      },
    ],
  }],
};
```

- [ ] **Step 3: Escribir las pruebas que fallan**

Create `test/server/escenario.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateEscenario, readEscenario } from "../../src/server/escenario.js";
import { ESCENARIO, MAPA } from "../fixtures/escenario-sintetico.js";

const leer = (m: unknown = MAPA) => () => structuredClone(m);
const conPiso = (cambio: Record<string, unknown>) => ({ pisos: [{ ...structuredClone(ESCENARIO.pisos[0]), ...cambio }] });
const aviso = (raw: unknown, mapa: unknown = MAPA) => {
  const r = validateEscenario(raw, leer(mapa));
  expect(r.pisos).toEqual([]);
  return r.warnings.join(" | ");
};

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "escenario-")); });

describe("validateEscenario", () => {
  it("escenario válido: mete los datos del mapa en el piso e ignora campos extra", () => {
    const r = validateEscenario(structuredClone(ESCENARIO), leer());
    expect(r.warnings).toEqual([]);
    expect(r.pisos).toHaveLength(1);
    const p = r.pisos[0];
    expect(p).toMatchObject({ nombre: "PISO 1 · PRUEBA", ancho: 12, alto: 6, atlas: "gTileset_Prueba", elevador: [10, 1], llegada: [10, 2], salida: [9, 2] });
    expect(p.bloques).toHaveLength(72);
    expect(p).not.toHaveProperty("objetos");
    expect(p.zonas.find((z) => z.id === "dev")).toEqual({ id: "dev", etiqueta: "DEV", color: "#60a5fa", x: 2, y: 1, w: 1, h: 1, puestos: [[2, 1]], fijos: {} });
    expect(p.zonas.find((z) => z.id === "oficina")!.fijos.codex).toEqual([6, 3]);
  });

  it("estructura: no objeto, sin pisos, más de 9 pisos", () => {
    expect(aviso([])).toContain("escenario.json: debe ser un objeto");
    expect(aviso({ pisos: [] })).toContain("pisos: de 1 a 9");
    expect(aviso({ pisos: Array(10).fill(ESCENARIO.pisos[0]) })).toContain("pisos: de 1 a 9");
  });

  it("mapa: nombre raro, tamaño, bloques y atlas", () => {
    expect(aviso(conPiso({ mapa: "../x.json" }))).toContain("pisos[0].mapa: nombre de archivo inválido");
    expect(aviso(ESCENARIO, { ...MAPA, ancho: 65 })).toContain("ancho/alto 1–64");
    expect(aviso(ESCENARIO, { ...MAPA, bloques: MAPA.bloques.slice(1) })).toContain("bloques debe tener ancho×alto");
    expect(aviso(ESCENARIO, { ...MAPA, bloques: [...MAPA.bloques.slice(1), 70000] })).toContain("enteros 0–65535");
    expect(aviso(ESCENARIO, { ...MAPA, atlas: "a.b" })).toContain("atlas inválido");
  });

  it("casillas fuera del mapa y salida mal puesta", () => {
    expect(aviso(conPiso({ elevador: [12, 1] }))).toContain("pisos[0].elevador: casilla fuera del mapa");
    expect(aviso(conPiso({ llegada: [1] }))).toContain("pisos[0].llegada: casilla fuera del mapa");
    const sinSalida = conPiso({});
    delete (sinSalida.pisos[0] as { salida?: unknown }).salida;
    expect(aviso(sinSalida)).toContain("falta salida");
    const dos = { pisos: [structuredClone(ESCENARIO.pisos[0]), { ...structuredClone(ESCENARIO.pisos[0]), zonas: [] }] };
    expect(aviso(dos)).toContain("pisos[1].salida: solo en el piso 1");
  });

  it("zonas: id, repetidas, color, rectángulo, puestos fuera de su zona, faltantes", () => {
    // Las zonas del fixture son de dos formas (con puestos / con fijos): como registros sueltos para poder mutarlas.
    const z = () => structuredClone(ESCENARIO.pisos[0].zonas) as Array<Record<string, unknown>>;
    const con = (f: (zs: ReturnType<typeof z>) => void) => { const zs = z(); f(zs); return conPiso({ zonas: zs }); };
    expect(aviso(con((zs) => { zs[0].id = "Sala!"; }))).toContain("pisos[0].zonas[0].id");
    expect(aviso(con((zs) => { zs[1].id = "descanso"; }))).toContain('"descanso" repetido');
    expect(aviso(con((zs) => { zs[0].color = "rojo"; }))).toContain("color: #rrggbb");
    expect(aviso(con((zs) => { zs[0].w = 20; }))).toContain("rectángulo fuera del mapa");
    expect(aviso(con((zs) => { zs[0].puestos = [[5, 4]]; }))).toContain("pisos[0].zonas[0].puestos[0]: fuera de su zona");
    expect(aviso(con((zs) => { zs.splice(2, 1); }))).toContain('falta la zona "qa"');
  });

  it("fijos: desconocido, repetido, faltante, fuera de su zona", () => {
    const of = () => structuredClone(ESCENARIO.pisos[0].zonas) as Array<Record<string, unknown>>;
    const con = (fijos: Record<string, unknown>) => { const zs = of(); zs[7].fijos = fijos; return conPiso({ zonas: zs }); };
    const base = (ESCENARIO.pisos[0].zonas[7] as { fijos: Record<string, number[]> }).fijos;
    expect(aviso(con({ ...base, gato: [7, 3] }))).toContain('fijo desconocido "gato"');
    expect(aviso(JSON.parse(JSON.stringify(con(base)).replace('"jefe":[1,3]', '"__proto__":[1,3]')))).toContain('fijo desconocido "__proto__"');
    const sinCodex = { ...base };
    delete sinCodex.codex;
    expect(aviso(con(sinCodex))).toContain('falta el fijo "codex"');
    expect(aviso(con({ ...base, jefe: [1, 1] }))).toContain("fijos.jefe: fuera de su zona");
    const dos = { pisos: [structuredClone(ESCENARIO.pisos[0]), { ...structuredClone(ESCENARIO.pisos[0]), salida: undefined, zonas: [{ id: "x", etiqueta: "X", color: "#000000", x: 1, y: 1, w: 2, h: 2, fijos: { jefe: [1, 1] } }] }] };
    delete (dos.pisos[1] as { salida?: unknown }).salida;
    expect(aviso(dos)).toContain('fijo "jefe" repetido');
  });
});

describe("readEscenario", () => {
  it("sin carpeta o sin escenario.json → vacío sin avisos", () => {
    expect(readEscenario(path.join(dir, "no"))).toEqual({ pisos: [], warnings: [] });
    expect(readEscenario(dir)).toEqual({ pisos: [], warnings: [] });
  });

  it("lee la carpeta; JSON roto, mapa faltante o demasiado grande → aviso", () => {
    fs.writeFileSync(path.join(dir, "escenario.json"), JSON.stringify(ESCENARIO));
    expect(readEscenario(dir).warnings).toEqual(["prueba.json: no existe o está fuera de la carpeta"]);
    fs.writeFileSync(path.join(dir, "prueba.json"), JSON.stringify(MAPA));
    const ok = readEscenario(dir);
    expect(ok.warnings).toEqual([]);
    expect(ok.pisos[0].atlas).toBe("gTileset_Prueba");
    fs.writeFileSync(path.join(dir, "prueba.json"), " ".repeat(256 * 1024 + 1));
    expect(readEscenario(dir).warnings).toEqual(["prueba.json: pesa más de 256 KB"]);
    fs.writeFileSync(path.join(dir, "escenario.json"), "{roto");
    expect(readEscenario(dir).warnings).toEqual(["escenario.json: no es JSON"]);
  });
});
```

- [ ] **Step 4: Verificar que falla**

Run: `npx vitest run test/server/escenario.test.ts`
Expected: FAIL (`Cannot find module ../../src/server/escenario.js`).

- [ ] **Step 5: Implementar `src/server/escenario.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import { resolveSpriteFile } from "./sprites.js";

export const escenarioDir = (): string => process.env.OFFICE_ESCENARIO_DIR || "C:\\tools\\escenario";
export const ESCENARIO_PNG = /^[A-Za-z0-9_-]{1,64}\.png$/;
const JSON_FILE = /^[A-Za-z0-9_-]{1,64}\.json$/;
const ATLAS = /^[A-Za-z0-9_]{1,50}$/;
const ZONE_ID = /^[a-z0-9-]{1,32}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_JSON = 64 * 1024, MAX_MAP = 256 * 1024, MAX_PISOS = 9, MAX_LADO = 64, MAX_ZONAS = 16, MAX_PUESTOS = 32;
// Las que usa placement.ts (descanso + zonas de rol) y los agentes con puesto fijo.
const ZONAS_REQUERIDAS = ["descanso", "dev", "qa", "imagen", "investigador", "lector", "redactor"];
const FIJOS = ["jefe", "guardia", "recepcion", "biblio", "claude", "codex"];

export type Tile = [number, number];
export interface EscenarioZona { id: string; etiqueta: string; color: string; x: number; y: number; w: number; h: number; puestos: Tile[]; fijos: Record<string, Tile> }
export interface EscenarioPiso { nombre: string; elevador: Tile; llegada: Tile; salida?: Tile; zonas: EscenarioZona[]; ancho: number; alto: number; bloques: number[]; atlas: string }
export interface Escenario { pisos: EscenarioPiso[]; warnings: string[] }
type Mapa = Pick<EscenarioPiso, "ancho" | "alto" | "bloques" | "atlas">;

class Invalido extends Error {}
function fail(msg: string): never { throw new Invalido(msg); }
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
function obj(v: unknown, where: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(`${where}: debe ser un objeto`);
  return v as Record<string, unknown>;
}
function str(v: unknown, max: number, where: string): string {
  if (typeof v !== "string" || v.length < 1 || v.length > max) fail(`${where}: texto de 1–${max} caracteres`);
  return v;
}
function tile(v: unknown, m: Mapa, where: string): Tile {
  if (!Array.isArray(v) || v.length !== 2 || !isInt(v[0], 0, m.ancho - 1) || !isInt(v[1], 0, m.alto - 1)) fail(`${where}: casilla fuera del mapa`);
  return [v[0], v[1]];
}

function mapa(file: unknown, readMap: (f: string) => unknown, where: string): Mapa {
  if (typeof file !== "string" || !JSON_FILE.test(file)) fail(`${where}.mapa: nombre de archivo inválido`);
  const m = obj(readMap(file), `${where}.mapa`);
  const { ancho, alto, bloques, atlas } = m;
  if (!isInt(ancho, 1, MAX_LADO) || !isInt(alto, 1, MAX_LADO)) fail(`${where}.mapa: ancho/alto 1–${MAX_LADO}`);
  if (!Array.isArray(bloques) || bloques.length !== ancho * alto) fail(`${where}.mapa: bloques debe tener ancho×alto elementos`);
  if (!bloques.every((b) => isInt(b, 0, 65535))) fail(`${where}.mapa: bloques deben ser enteros 0–65535`);
  if (typeof atlas !== "string" || !ATLAS.test(atlas)) fail(`${where}.mapa: atlas inválido`);
  return { ancho, alto, bloques: bloques as number[], atlas };
}

function zona(v: unknown, where: string, m: Mapa, ids: Set<string>, fijos: Set<string>): EscenarioZona {
  const z = obj(v, where);
  const { id, color, x, y, w, h } = z;
  if (typeof id !== "string" || !ZONE_ID.test(id)) fail(`${where}.id: [a-z0-9-]{1,32}`);
  if (ids.has(id)) fail(`${where}.id: "${id}" repetido`);
  ids.add(id);
  if (typeof color !== "string" || !COLOR.test(color)) fail(`${where}.color: #rrggbb`);
  if (!isInt(x, 0, m.ancho - 1) || !isInt(y, 0, m.alto - 1) || !isInt(w, 1, m.ancho - x) || !isInt(h, 1, m.alto - y)) fail(`${where}: rectángulo fuera del mapa`);
  const dentro = (t: Tile, k: string) => {
    if (t[0] < x || t[0] >= x + w || t[1] < y || t[1] >= y + h) fail(`${where}.${k}: fuera de su zona`);
    return t;
  };
  const ps = z.puestos ?? [];
  if (!Array.isArray(ps) || ps.length > MAX_PUESTOS) fail(`${where}.puestos: lista de hasta ${MAX_PUESTOS}`);
  const out: Record<string, Tile> = {};
  for (const [k, t] of Object.entries(obj(z.fijos ?? {}, `${where}.fijos`))) {
    if (!FIJOS.includes(k)) fail(`${where}.fijos: fijo desconocido "${k}"`);
    if (fijos.has(k)) fail(`${where}.fijos: fijo "${k}" repetido`);
    fijos.add(k);
    out[k] = dentro(tile(t, m, `${where}.fijos.${k}`), `fijos.${k}`);
  }
  return {
    id, etiqueta: str(z.etiqueta, 40, `${where}.etiqueta`), color, x, y, w, h,
    puestos: ps.map((t, i) => dentro(tile(t, m, `${where}.puestos[${i}]`), `puestos[${i}]`)), fijos: out,
  };
}

function piso(v: unknown, i: number, readMap: (f: string) => unknown, ids: Set<string>, fijos: Set<string>): EscenarioPiso {
  const where = `pisos[${i}]`, p = obj(v, where);
  const m = mapa(p.mapa, readMap, where);
  if (i === 0 && p.salida === undefined) fail(`${where}: falta salida (aparición del jugador)`);
  if (i > 0 && p.salida !== undefined) fail(`${where}.salida: solo en el piso 1`);
  if (!Array.isArray(p.zonas) || p.zonas.length > MAX_ZONAS) fail(`${where}.zonas: lista de hasta ${MAX_ZONAS}`);
  return {
    nombre: str(p.nombre, 60, `${where}.nombre`), elevador: tile(p.elevador, m, `${where}.elevador`), llegada: tile(p.llegada, m, `${where}.llegada`),
    ...(p.salida === undefined ? {} : { salida: tile(p.salida, m, `${where}.salida`) }),
    zonas: p.zonas.map((z, j) => zona(z, `${where}.zonas[${j}]`, m, ids, fijos)), ...m,
  };
}

/** escenario.json ya parseado + lector de mapas → escenario válido completo, o vacío con el primer error. */
export function validateEscenario(raw: unknown, readMap: (file: string) => unknown): Escenario {
  try {
    const ps = obj(raw, "escenario.json").pisos;
    if (!Array.isArray(ps) || ps.length < 1 || ps.length > MAX_PISOS) fail(`pisos: de 1 a ${MAX_PISOS}`);
    const ids = new Set<string>(), fijos = new Set<string>();
    const pisos = ps.map((p, i) => piso(p, i, readMap, ids, fijos));
    for (const z of ZONAS_REQUERIDAS) if (!ids.has(z)) fail(`falta la zona "${z}"`);
    for (const f of FIJOS) if (!fijos.has(f)) fail(`falta el fijo "${f}"`);
    return { pisos, warnings: [] };
  } catch (err) {
    if (err instanceof Invalido) return { pisos: [], warnings: [err.message] };
    throw err;
  }
}

function readJson(dir: string, name: string, max: number): unknown {
  const real = resolveSpriteFile(name, dir, JSON_FILE) ?? fail(`${name}: no existe o está fuera de la carpeta`);
  if (fs.statSync(real).size > max) fail(`${name}: pesa más de ${max / 1024} KB`);
  try { return JSON.parse(fs.readFileSync(real, "utf8")); } catch { return fail(`${name}: no es JSON`); }
}

export function readEscenario(dir = escenarioDir()): Escenario {
  if (!fs.existsSync(path.join(dir, "escenario.json"))) return { pisos: [], warnings: [] };
  try {
    return validateEscenario(readJson(dir, "escenario.json", MAX_JSON), (f) => readJson(dir, f, MAX_MAP));
  } catch (err) {
    return { pisos: [], warnings: [err instanceof Invalido ? err.message : "escenario.json no se pudo leer"] };
  }
}
```

Note: `readMap` throws `Invalido` inside `validateEscenario`, which already turns it into a warning; the `try` in `readEscenario` covers `escenario.json` itself.

- [ ] **Step 6: Verificar que pasa**

Run: `npx vitest run test/server/escenario.test.ts test/server/sprites.test.ts`
Expected: PASS. If a message assertion fails, fix the message in the code (the tests are the contract).

- [ ] **Step 7: Lint, typecheck y commit**

Run: `npm run lint && npm run typecheck`

```bash
git add src/server/sprites.ts src/server/escenario.ts test/fixtures/escenario-sintetico.ts test/server/escenario.test.ts
git commit -m "F13: validador y lector del escenario propio (mapas gen3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Rutas del escenario y cableado

**Files:**
- Create: `src/server/routes/escenario.ts`
- Modify: `src/server/index.ts` (junto a las rutas de sprites)
- Modify: `ui/vite.config.ts` (proxy `/escenario`)
- Modify: `.env.example`
- Test: `test/server/escenario.test.ts` (nuevo `describe`)

**Interfaces:**
- Consumes: `readEscenario`, `escenarioDir`, `ESCENARIO_PNG` (Task 1); `resolveSpriteFile(name, dir, re)`.
- Produces: `createOfficeEscenarioRoute(dir?: string)` (GET `/` → `Escenario`), `createEscenarioFilesRoute(dir?: string)` (GET `/:file` → PNG). Montadas en `/api/office/escenario` y `/escenario`.

- [ ] **Step 1: Prueba que falla**

Agrega al final de `test/server/escenario.test.ts` (y suma `createOfficeEscenarioRoute, createEscenarioFilesRoute` a un import nuevo de `../../src/server/routes/escenario.js`):

```ts
import { createOfficeEscenarioRoute, createEscenarioFilesRoute } from "../../src/server/routes/escenario.js";

describe("rutas del escenario", () => {
  it("/api/office/escenario lee la carpeta; /escenario solo sirve PNG de adentro con nosniff y CSP", async () => {
    expect(await (await createOfficeEscenarioRoute(dir).request("/")).json()).toEqual({ pisos: [], warnings: [] });
    fs.writeFileSync(path.join(dir, "escenario.json"), JSON.stringify(ESCENARIO));
    fs.writeFileSync(path.join(dir, "prueba.json"), JSON.stringify(MAPA));
    fs.writeFileSync(path.join(dir, "gTileset_Prueba-abajo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const body = await (await createOfficeEscenarioRoute(dir).request("/")).json();
    expect(body.warnings).toEqual([]);
    expect(body.pisos[0].atlas).toBe("gTileset_Prueba");
    const r = await createEscenarioFilesRoute(dir).request("/gTileset_Prueba-abajo.png");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toBe("sandbox");
    for (const bad of ["/prueba.json", "/escenario.json", "/..%2Fx.png", "/falta.png"]) expect((await createEscenarioFilesRoute(dir).request(bad)).status, bad).toBe(404);
  });
});
```

Run: `npx vitest run test/server/escenario.test.ts` → FAIL (módulo no existe).

- [ ] **Step 2: Implementar `src/server/routes/escenario.ts`**

```ts
import fs from "node:fs";
import { Hono } from "hono";
import { ESCENARIO_PNG, escenarioDir, readEscenario } from "../escenario.js";
import { resolveSpriteFile } from "../sprites.js";

export function createOfficeEscenarioRoute(dir?: string) {
  const app = new Hono();
  app.get("/", (c) => c.json(readEscenario(dir)));
  return app;
}

/** Atlas PNG del escenario (fuera del repo); los JSON nunca se sirven. */
export function createEscenarioFilesRoute(dir?: string) {
  const app = new Hono();
  app.get("/:file", (c) => {
    const real = resolveSpriteFile(c.req.param("file"), dir ?? escenarioDir(), ESCENARIO_PNG);
    if (!real) return c.json({ error: "Archivo no encontrado" }, 404);
    return c.body(fs.readFileSync(real), 200, {
      "Content-Type": "image/png", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox", "Cache-Control": "no-cache",
    });
  });
  return app;
}
```

- [ ] **Step 3: Cablear en `src/server/index.ts`**

Import junto al de sprites:

```ts
import { createOfficeEscenarioRoute, createEscenarioFilesRoute } from "./routes/escenario.js";
```

Debajo de `app.route("/api/office/sprites", createOfficeSpritesRoute());`:

```ts
app.route("/api/office/escenario", createOfficeEscenarioRoute());
```

Debajo de `app.route("/sprites", createSpritesRoute());` (antes del `serveStatic`):

```ts
// Escenario del usuario fuera del repo (OFFICE_ESCENARIO_DIR): solo sus atlas PNG.
app.route("/escenario", createEscenarioFilesRoute());
```

- [ ] **Step 4: Proxy de Vite y `.env.example`**

En `ui/vite.config.ts`, junto a `"/sprites": "http://127.0.0.1:3110",` agrega:

```ts
      "/escenario": "http://127.0.0.1:3110",
```

En `.env.example`, debajo de la línea de `OFFICE_SPRITES_DIR`:

```
# OFFICE_ESCENARIO_DIR=C:\tools\escenario  # mapas y atlas propios para la Oficina (fuera del repo; nunca en git)
```

- [ ] **Step 5: Verificar y commit**

Run: `npx vitest run test/server/escenario.test.ts && npm run lint && npm run typecheck` → PASS.

```bash
git add src/server/routes/escenario.ts src/server/index.ts ui/vite.config.ts .env.example test/server/escenario.test.ts
git commit -m "F13: rutas /api/office/escenario y /escenario (atlas PNG)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Conversión a `FloorMap` y pisos reemplazables (UI, puro)

**Files:**
- Modify: `ui/src/office/world/types.ts`
- Create: `ui/src/office/world/gen3.ts`
- Modify: `ui/src/office/world/maps.ts` (final del archivo)
- Test: `test/ui/gen3.test.ts`

**Interfaces:**
- Consumes: `findPath`, `key` de `ui/src/office/world/path.ts`; fixture de Task 1; `validateEscenario` (solo en la prueba, para usar la forma real del servidor).
- Produces:
  - `FloorMap.gen3?: { ancho: number; bloques: readonly number[]; atlas: string }` (en `types.ts`)
  - `gen3.ts`: `interface EscenarioPiso` (misma forma que el servidor), `metatile(b: number): number`, `isBlocked(b: number): boolean`, `toFloorMap(p: EscenarioPiso, n: number): FloorMap`, `unreachable(map: FloorMap): Tile[]`
  - `maps.ts`: `export let FLOORS`, `setFloors(f: readonly FloorMap[]): void`

- [ ] **Step 1: Pruebas que fallan**

Create `test/ui/gen3.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateEscenario } from "../../src/server/escenario.js";
import { ESCENARIO, MAPA } from "../fixtures/escenario-sintetico.js";
import { isBlocked, metatile, toFloorMap, unreachable, type EscenarioPiso } from "../../ui/src/office/world/gen3";
import { FLOORS, floorOf, setFloors } from "../../ui/src/office/world/maps";

const piso = (mapa: unknown = MAPA): EscenarioPiso => validateEscenario(structuredClone(ESCENARIO), () => structuredClone(mapa)).pisos[0];

describe("gen3", () => {
  it("bloque: metatile en bits 0–9, colisión en 10–11", () => {
    expect(metatile(1025)).toBe(1);
    expect(isBlocked(1025)).toBe(true);
    expect(isBlocked(2)).toBe(false);
    expect(isBlocked(3 << 12 | 5)).toBe(false); // la elevación no es colisión
    expect(isBlocked(2 << 10)).toBe(true);
  });

  it("toFloorMap: colisión → #, puestos y fijos → s, elevador → E; conserva zonas y datos del mapa", () => {
    const f = toFloorMap(piso(), 1);
    expect(f.filas).toEqual([
      "############",
      "#sssssss..E#",
      "#..........#",
      "#ssssss....#",
      "#..........#",
      "############",
    ]);
    expect(f).toMatchObject({ piso: 1, nombre: "PISO 1 · PRUEBA", elevador: [10, 1], llegada: [10, 2], salida: [9, 2] });
    expect(f.gen3).toMatchObject({ ancho: 12, atlas: "gTileset_Prueba" });
    expect(f.gen3!.bloques).toHaveLength(72);
    expect(f.zonas.find((z) => z.id === "oficina")!.fijos!.jefe).toEqual([1, 3]);
    expect(f.zonas.find((z) => z.id === "dev")).toEqual({ id: "dev", etiqueta: "DEV", color: "#60a5fa", x: 2, y: 1, w: 1, h: 1, fijos: {} });
  });

  it("un puesto o el elevador sobre un bloque con colisión quedan pisables", () => {
    const bloques = [...MAPA.bloques];
    bloques[1 * 12 + 1] = 1025; // puesto de "descanso"
    bloques[1 * 12 + 10] = 1025; // elevador
    const f = toFloorMap(piso({ ...MAPA, bloques }), 1);
    expect(f.filas[1][1]).toBe("s");
    expect(f.filas[1][10]).toBe("E");
  });

  it("unreachable: vacío si todo se alcanza; lista lo que una pared deja aislado", () => {
    expect(unreachable(toFloorMap(piso(), 1))).toEqual([]);
    const bloques = [...MAPA.bloques];
    for (let y = 1; y < 5; y++) bloques[y * 12 + 8] = 1025; // pared en x=8: el elevador queda solo
    const u = unreachable(toFloorMap(piso({ ...MAPA, bloques }), 1));
    expect(u).toContainEqual([1, 1]);
    expect(u).toContainEqual([6, 3]);
    expect(u).not.toContainEqual([10, 2]);
  });

  it("setFloors reemplaza los pisos que leen floorOf y FLOORS", () => {
    const antes = FLOORS;
    const f = toFloorMap(piso(), 1);
    setFloors([f]);
    expect(floorOf(1)).toBe(f);
    expect(FLOORS).toHaveLength(1);
    setFloors(antes);
    expect(FLOORS).toHaveLength(3);
  });
});
```

Run: `npx vitest run test/ui/gen3.test.ts` → FAIL (módulo `gen3` no existe).

- [ ] **Step 2: `FloorMap.gen3` en `ui/src/office/world/types.ts`**

Dentro de `interface FloorMap`, después de `salida?: Tile; ...`:

```ts
  gen3?: { ancho: number; bloques: readonly number[]; atlas: string }; // piso de un escenario propio (F13)
```

- [ ] **Step 3: `ui/src/office/world/gen3.ts`**

```ts
// Escenario propio (F13): mapa de bloques gen3 → FloorMap. Puro (sin DOM); el dibujo vive en render.ts.
import { findPath, key } from "./path";
import type { FloorMap, Tile, Zone } from "./types";

/** Forma de cada piso en GET /api/office/escenario (validada en el servidor). */
export interface EscenarioPiso {
  nombre: string; elevador: Tile; llegada: Tile; salida?: Tile; ancho: number; alto: number; bloques: number[]; atlas: string;
  zonas: { id: string; etiqueta: string; color: string; x: number; y: number; w: number; h: number; puestos: Tile[]; fijos: Record<string, Tile> }[];
}

export const metatile = (b: number): number => b & 0x3ff;
export const isBlocked = (b: number): boolean => ((b >> 10) & 3) !== 0;

/** Puestos, fijos y elevador quedan pisables aunque su bloque tenga colisión: los marca quien arma el escenario. */
export function toFloorMap(p: EscenarioPiso, n: number): FloorMap {
  const rows = Array.from({ length: p.alto }, (_, y) => Array.from({ length: p.ancho }, (_, x) => (isBlocked(p.bloques[y * p.ancho + x]) ? "#" : ".")));
  for (const z of p.zonas) for (const [x, y] of [...z.puestos, ...Object.values(z.fijos)]) rows[y][x] = "s";
  rows[p.elevador[1]][p.elevador[0]] = "E";
  const zonas: Zone[] = p.zonas.map((z) => ({ id: z.id, etiqueta: z.etiqueta, color: z.color, x: z.x, y: z.y, w: z.w, h: z.h, fijos: z.fijos }));
  return {
    piso: n, nombre: p.nombre, fondo: "#000000", filas: rows.map((r) => r.join("")), zonas,
    elevador: p.elevador, llegada: p.llegada, ...(p.salida ? { salida: p.salida } : {}),
    gen3: { ancho: p.ancho, bloques: p.bloques, atlas: p.atlas },
  };
}

/** Asientos, llegada y salida a los que no se llega caminando desde el elevador. */
export function unreachable(map: FloorMap): Tile[] {
  const targets: Tile[] = [map.llegada, ...(map.salida ? [map.salida] : [])];
  map.filas.forEach((r, y) => { for (let x = 0; x < r.length; x++) if (r[x] === "s") targets.push([x, y]); });
  return targets.filter((t) => key(findPath(map, map.elevador, t).at(-1) ?? map.elevador) !== key(t));
}
```

- [ ] **Step 4: `setFloors` en `ui/src/office/world/maps.ts`**

Cambia `export const FLOORS: readonly FloorMap[] = [` por:

```ts
export let FLOORS: readonly FloorMap[] = [
```

Y al final del archivo, después de `floorOf`:

```ts
/** Reemplaza los pisos (escenario propio, F13) antes de montar el mundo; los módulos leen FLOORS en cada uso. */
export function setFloors(f: readonly FloorMap[]): void { FLOORS = f; }
```

- [ ] **Step 5: Verificar**

Run: `npx vitest run test/ui/gen3.test.ts test/ui/world-path.test.ts test/ui/world-placement.test.ts` → PASS.
Run: `npm run lint && npm run typecheck` → limpio (si eslint marca `prefer-const` en `FLOORS`, no aplica: se reasigna en `setFloors`).

- [ ] **Step 6: Commit**

```bash
git add ui/src/office/world/types.ts ui/src/office/world/gen3.ts ui/src/office/world/maps.ts test/ui/gen3.test.ts
git commit -m "F13: mapa gen3 a FloorMap, revisión de alcance y pisos reemplazables

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Dibujo desde el atlas, carga del escenario y mundo de N pisos (UI)

**Files:**
- Modify: `ui/src/office/world/render.ts`
- Create: `ui/src/office/world/escenario.ts`
- Modify: `ui/src/components/office/OfficeWorld.tsx`

**Interfaces:**
- Consumes: `metatile`, `toFloorMap`, `unreachable`, `EscenarioPiso` (Task 3); `setFloors`, `FLOORS`, `floorOf`.
- Produces: `render.ts` → `interface Atlas { abajo: HTMLImageElement; arriba: HTMLImageElement }`, `drawFloor(c, map, t, atlas?)`, `drawUpper(c, map, atlas?)`; `escenario.ts` → `loadEscenario(): Promise<Map<string, Atlas>>`. `OfficeWorld` mantiene sus props públicas.

Sin pruebas unitarias nuevas (DOM/canvas, como el resto de `render.ts`): la verificación es `typecheck` + `build:ui` + la prueba en vivo de Task 6.

- [ ] **Step 1: `render.ts` dibuja capas del atlas**

Agrega el import y el tipo arriba (junto a los otros imports):

```ts
import { metatile } from "./gen3";

export interface Atlas { abajo: HTMLImageElement; arriba: HTMLImageElement }
```

Agrega la función de capa (después de `tile(...)`):

```ts
/** Una capa del atlas gen3 (16 metatiles por fila) sobre todo el piso. */
function drawLayer(c: Ctx, map: FloorMap, img: HTMLImageElement) {
  const g = map.gen3!;
  g.bloques.forEach((b, i) => {
    const mt = metatile(b);
    c.drawImage(img, (mt % 16) * T, Math.floor(mt / 16) * T, T, T, (i % g.ancho) * T, Math.floor(i / g.ancho) * T, T, T);
  });
}
```

Reemplaza `drawFloor` por:

```ts
/** Piso, muebles bajos y bordes de zona (las etiquetas van en DOM). `t` en ticks de 60 Hz (fijo con reduced motion: el foco no parpadea). */
export function drawFloor(c: Ctx, map: FloorMap, t: number, atlas?: Atlas) {
  if (map.gen3 && atlas) {
    r(c, 0, 0, map.gen3.ancho * T, map.filas.length * T, map.fondo);
    drawLayer(c, map, atlas.abajo);
  } else map.filas.forEach((fila, Y) => { for (let X = 0; X < fila.length; X++) tile(c, map, fila[X], X, Y, t); });
  for (const z of map.zonas) {
    c.strokeStyle = `${z.color}40`;
    c.strokeRect(z.x * T + 0.5, z.y * T + 0.5, z.w * T - 1, z.h * T - 1);
  }
}
```

Y al inicio de `drawUpper` cambia la firma y agrega el atajo:

```ts
export function drawUpper(c: Ctx, map: FloorMap, atlas?: Atlas) {
  if (map.gen3 && atlas) { drawLayer(c, map, atlas.arriba); return; } // la capa "arriba" ya es lo que tapa a los personajes
```

(el resto de `drawUpper` queda igual).

- [ ] **Step 2: `ui/src/office/world/escenario.ts`**

```ts
// Carga del escenario propio (F13): una vez por página. Con escenario → FLOORS + atlas; sin él → pisos de F12.
import { setFloors } from "./maps";
import { toFloorMap, unreachable, type EscenarioPiso } from "./gen3";
import type { Atlas } from "./render";

let cargando: Promise<Map<string, Atlas>> | null = null;

const image = (src: string) => new Promise<HTMLImageElement | null>((resolve) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  img.src = src;
});

async function cargar(): Promise<Map<string, Atlas>> {
  const r = await fetch("/api/office/escenario").catch(() => null);
  const data = r?.ok ? ((await r.json().catch(() => null)) as { pisos?: EscenarioPiso[]; warnings?: string[] } | null) : null;
  for (const w of data?.warnings ?? []) console.warn(`escenario: ${w}`);
  if (!data?.pisos?.length) return new Map();
  const pisos = data.pisos.map((p, i) => toFloorMap(p, i + 1));
  for (const f of pisos) for (const t of unreachable(f)) console.warn(`escenario: piso ${f.piso}, casilla ${t.join(",")} no se alcanza desde el elevador`);
  setFloors(pisos);
  const atlas = new Map<string, Atlas>();
  for (const name of new Set(pisos.map((f) => f.gen3!.atlas))) {
    const [abajo, arriba] = await Promise.all([image(`/escenario/${name}-abajo.png`), image(`/escenario/${name}-arriba.png`)]);
    if (abajo && arriba) atlas.set(name, { abajo, arriba });
    else console.warn(`escenario: no cargó el atlas ${name}; ese piso usa los tiles por código`);
  }
  return atlas;
}

export const loadEscenario = (): Promise<Map<string, Atlas>> => (cargando ??= cargar().catch(() => new Map()));
```

- [ ] **Step 3: `OfficeWorld.tsx` — cargar antes de montar el mundo**

Imports: cambia la línea de `maps` y la de `render`, y agrega `escenario` y el tipo `FloorMap`:

```ts
import { FLOORS, floorOf } from "../../office/world/maps";
import { drawBubble, drawCreature, drawFloor, drawSkin, drawUpper, type Atlas } from "../../office/world/render";
import { loadEscenario } from "../../office/world/escenario";
import type { FloorMap, Tile } from "../../office/world/types";
```

(borra el `import type { Tile } from "../../office/world/types";` viejo).

Constantes: reemplaza

```ts
const COLS = 30, STEP_MS = 1000 / 60, MAX_STEPS = 4;
const FLOOR_LABELS = ["Dirección y Recepción", "Desarrollo y Pruebas", "Estudio y Biblioteca"];
```

por

```ts
const STEP_MS = 1000 / 60, MAX_STEPS = 4;
const colsOf = (m: FloorMap) => m.filas[0].length;
```

Renombra `export function OfficeWorld({ state, onNear, onAdvance, children }: Props) {` a:

```ts
function World({ state, onNear, onAdvance, children, atlas }: Props & { atlas: Map<string, Atlas> }) {
```

y agrega, después de `World` (al final del archivo):

```ts
/** El escenario propio (si hay) reemplaza los pisos antes de crear el mundo: el jugador nace en su salida. */
export function OfficeWorld(props: Props) {
  const [atlas, setAtlas] = useState<Map<string, Atlas> | null>(null);
  useEffect(() => {
    let alive = true;
    void loadEscenario().then((a) => { if (alive) setAtlas(a); });
    return () => { alive = false; };
  }, []);
  if (!atlas) return <p className="font-pixel text-[11px] text-text-secondary">cargando escenario…</p>;
  return <World {...props} atlas={atlas} />;
}
```

- [ ] **Step 4: `World` — ancho por piso y atlas**

Dentro de `World`, después de `const [scale, setScale] = useState(3);`:

```ts
  const cols = colsOf(floorOf(piso));
```

Efecto de escala: reemplaza `fitScale(entry.contentRect.width, COLS)` por `fitScale(entry.contentRect.width, cols)` y su arreglo de dependencias `[]` por `[cols]`.

En `draw` reemplaza:

```ts
      if (canvas.width !== COLS * 16) canvas.width = COLS * 16;
```

por

```ts
      if (canvas.width !== colsOf(map) * 16) canvas.width = colsOf(map) * 16;
```

y `drawFloor(ctx, map, reduced ? 0 : w.tick);` por `drawFloor(ctx, map, reduced ? 0 : w.tick, atlasOf(map));`, y `drawUpper(ctx, map);` por `drawUpper(ctx, map, atlasOf(map));`. `atlasOf` va **dentro** del efecto del bucle (junto a `stepAgents`), y sus dependencias pasan de `[w, reduced]` a `[w, reduced, atlas]`:

```ts
    const atlasOf = (m: FloorMap) => (m.gen3 ? atlas.get(m.gen3.atlas) : undefined);
```

En `onClick` reemplaza `COLS` por `colsOf(map)`.

En el JSX reemplaza las dos apariciones de `COLS * 16 * scale` por `cols * 16 * scale`.

- [ ] **Step 5: Elevador de N pisos**

En `onKeyDown` reemplaza:

```ts
      if (["1", "2", "3"].includes(e.key)) { e.preventDefault(); choose(Number(e.key)); }
```

por

```ts
      if (/^[1-9]$/.test(e.key) && Number(e.key) <= FLOORS.length) { e.preventDefault(); choose(Number(e.key)); }
```

En el menú reemplaza el `FLOOR_LABELS.map(...)` por:

```tsx
            {FLOORS.map((f) => (
              <button key={f.piso} autoFocus={f.piso === 1} className="px-2 py-1 text-left hover:bg-white/10 focus-visible:bg-white/10" onClick={() => choose(f.piso)}>
                {f.nombre}
              </button>
            ))}
```

(Los nombres de los pisos de F12 ya dicen "PISO N · …", así que el menú sigue mostrando el número.)

- [ ] **Step 6: Verificar**

Run: `npm run lint && npm run typecheck && npm test && npm run build:ui`
Expected: todo en verde; `grep -n "COLS\|FLOOR_LABELS" ui/src/components/office/OfficeWorld.tsx` sin resultados.

- [ ] **Step 7: Commit**

```bash
git add ui/src/office/world/render.ts ui/src/office/world/escenario.ts ui/src/components/office/OfficeWorld.tsx
git commit -m "F13: la Oficina dibuja el escenario propio desde el atlas y su elevador lista N pisos

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Script de revisión y escenario local de Esmeralda (fuera de git)

**Files:**
- Create: `scripts/check-escenario.ts`
- Modify: `package.json` (script `check:escenario`)
- Local (no git): `C:\tools\escenario\` (6 mapas, sus atlas y `escenario.json`)
- Scratchpad (no git): script de copia y renders con rejilla

**Interfaces:**
- Consumes: `readEscenario`, `escenarioDir` (Task 1); `toFloorMap`, `unreachable` (Task 3).
- Produces: `npm run check:escenario [carpeta]` → imprime cada piso como rejilla, sale con 1 si hay avisos o casillas inalcanzables.

- [ ] **Step 1: `scripts/check-escenario.ts`**

```ts
// Revisa el escenario local (OFFICE_ESCENARIO_DIR o C:\tools\escenario): validación del servidor + alcance desde el elevador.
import { escenarioDir, readEscenario } from "../src/server/escenario.js";
import { toFloorMap, unreachable } from "../ui/src/office/world/gen3";

const dir = process.argv[2] ?? escenarioDir();
const { pisos, warnings } = readEscenario(dir);
for (const w of warnings) console.error(`✗ ${w}`);
if (!pisos.length) {
  console.error(warnings.length ? "escenario inválido" : `sin escenario en ${dir}`);
  process.exit(1);
}
let malos = 0;
pisos.forEach((p, i) => {
  const f = toFloorMap(p, i + 1), u = unreachable(f);
  malos += u.length;
  console.log(`${u.length ? "✗" : "✓"} piso ${f.piso} · ${f.nombre} · ${p.ancho}×${p.alto}${u.length ? ` · inalcanzables: ${u.map((t) => t.join(",")).join(" ")}` : ""}`);
  console.log(f.filas.join("\n"));
});
process.exit(malos ? 1 : 0);
```

En `package.json`, junto a `"smoke:models"`:

```json
    "check:escenario": "tsx scripts/check-escenario.ts",
```

Run: `npm run lint && npm run typecheck`; `npm run check:escenario -- C:/no-existe` → "sin escenario en C:/no-existe", exit 1.

```bash
git add scripts/check-escenario.ts package.json
git commit -m "F13: npm run check:escenario revisa el escenario local

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Copiar mapas y atlas a `C:\tools\escenario` (fuera de git)**

Script en el scratchpad (Python con Pillow ya instalado; correr con `python -I <script> <paquete>/data C:/tools/escenario`):

```python
import json, os, shutil, sys
data, dst = sys.argv[1], sys.argv[2]
MAPAS = {  # destino ← "nombre" del mapa en el paquete
    "devon_1f": "RustboroCity_DevonCorp_1F", "devon_2f": "RustboroCity_DevonCorp_2F", "devon_3f": "RustboroCity_DevonCorp_3F",
    "lab_birch": "LittlerootTown_ProfessorBirchsLab", "escuela": "RustboroCity_PokemonSchool", "centro_1f": "RustboroCity_PokemonCenter_1F",
}
os.makedirs(dst, exist_ok=True)
por_nombre = {}
for f in os.listdir(os.path.join(data, "maps")):
    m = json.load(open(os.path.join(data, "maps", f), encoding="utf-8"))
    por_nombre[m["nombre"]] = f
tiles = {f.replace("-", "").lower(): f for f in os.listdir(os.path.join(data, "tiles"))}
for destino, nombre in MAPAS.items():
    shutil.copyfile(os.path.join(data, "maps", por_nombre[nombre]), os.path.join(dst, destino + ".json"))
    atlas = json.load(open(os.path.join(dst, destino + ".json"), encoding="utf-8"))["atlas"]
    for capa in ("abajo", "arriba"):
        # el paquete nombra el atlas completo o solo por su tileset secundario (p. ej. facility.abajo.png)
        f = tiles.get(f"{atlas}.{capa}.png".lower()) or tiles[f"{atlas.split('__gTileset_')[1]}.{capa}.png".lower()]
        shutil.copyfile(os.path.join(data, "tiles", f), os.path.join(dst, f"{atlas}-{capa}.png"))
print(sorted(os.listdir(dst)))
```

Expected: 6 `.json` + 10 PNG (5 atlas × abajo/arriba): `gTileset_Building__gTileset_Facility` (Devon 1F y 3F), `gTileset_General__gTileset_Facility` (Devon 2F), `gTileset_Building__gTileset_Lab`, `gTileset_Building__gTileset_PokemonSchool`, `gTileset_Building__gTileset_PokemonCenter`.

- [ ] **Step 3: Renders con rejilla para escoger casillas**

Extiende el render del scratchpad (`mapa.py`) para que dibuje cada mapa a ×3 con una rejilla de 16 px, las coordenadas `x,y` en cada casilla y un tinte rojo en los bloques con colisión. Genera uno por piso y míralos.

- [ ] **Step 4: Escribir `C:\tools\escenario\escenario.json`**

Seis pisos en este orden, con nombres `PISO N · …` (el menú del elevador los muestra tal cual), según el reparto aprobado:

| Piso | mapa | nombre | zonas |
|---|---|---|---|
| 1 | `devon_1f.json` | `PISO 1 · DEVON 1F · RECEPCIÓN` | `recepcion` (fijos `recepcion` tras el mostrador, `biblio`), `entrada` (fijo `guardia` junto al tapete) |
| 2 | `devon_2f.json` | `PISO 2 · DEVON 2F · DESARROLLO` | `dev` (puestos: una casilla libre junto a cada uno de los 6 escritorios), `imagen` (puestos junto a la mesa de dibujo) |
| 3 | `devon_3f.json` | `PISO 3 · DEVON 3F · DIRECCIÓN` | `direccion` (fijo `jefe` junto al escritorio grande), `agentes` (fijos `claude`, `codex` junto a los sillones) |
| 4 | `lab_birch.json` | `PISO 4 · LABORATORIO · QA E INVESTIGACIÓN` | `qa` (máquina y escritorios de abajo, ≥ 3 puestos), `investigador` (libreros y escritorios de arriba, ≥ 2 puestos) |
| 5 | `escuela.json` | `PISO 5 · ESCUELA · LECTURA Y REDACCIÓN` | `lector` (pupitres, ≥ 4 puestos), `redactor` (escritorio del maestro, ≥ 1 puesto) |
| 6 | `centro_1f.json` | `PISO 6 · CENTRO · DESCANSO` | `descanso` (rectángulo amplio, puestos en sillones y bancos, ≥ 4) |

Reglas para escoger casillas: elevador = la escalera o el tapete de entrada del mapa; llegada = una casilla libre vecina al elevador; `salida` solo en el piso 1 (casilla libre del vestíbulo); todo puesto/fijo dentro del rectángulo de su zona; colores de zona = los de F12 (`dev` `#60a5fa`, `qa` `#34d399`, `imagen` `#fb923c`, `investigador` `#f472b6`, `lector` `#fbbf24`, `redactor` `#e879f9`, `descanso` `#a1a1aa`, `direccion` `#a78bfa`, `recepcion` `#fb923c`, `agentes` `#e879f9`, `entrada` `#fbbf24`).

- [ ] **Step 5: Revisar hasta que pase**

Run: `npm run check:escenario`
Expected: 6 líneas `✓ piso N …`, ningún `✗`, exit 0. Si algo sale inalcanzable o fuera de zona, corrige `escenario.json` y vuelve a correr. Nada de esta carpeta entra a git (`git status` limpio).

---

### Task 6: Prueba en vivo y documentación

**Files:**
- Modify: `CLAUDE.md` (sección nueva "Custom scenery (F13)", en inglés como el resto)
- Modify: `CONTINUAR.md` (sección nueva al inicio, en español)
- Local (no git): nota de Cerebro `C:\Users\sidel\Documents\Cerebro\20-Personal\Orquestador-IA.md`

- [ ] **Step 1: Servidor de prueba**

Run (en segundo plano, sin tocar la app de :3110): `npm run build:ui` y luego `ORQUESTADOR_PORT=3111 npm start`. Abre `http://127.0.0.1:3111` en el panel de navegador → Oficina → mundo.

- [ ] **Step 2: Recorrido**

Verifica y anota (capturas en `.superpowers/sdd/2026-10-15-f13-escenario-gen3/`, fuera de git):
1. Piso 1 se ve como Devon 1F (capa abajo y arriba), el jugador nace en `salida`.
2. El jugador choca con muebles y paredes del mapa (no los atraviesa) y la capa `arriba` lo tapa donde corresponde.
3. Pararse en el elevador abre el menú con los 6 pisos; teclas 1–6 y clic llevan a cada uno.
4. Jefe, guardia, recepción, biblio, claude y codex aparecen en sus fijos.
5. Los agentes en reposo deambulan en el piso de descanso.
6. Un paso con rol (plan chico en `C:\estudio\f11-demo`, p. ej. LECTOR) lleva a su agente a la zona de su rol.
7. Consola sin avisos `escenario:`.
8. Con `OFFICE_ESCENARIO_DIR` apuntando a una carpeta vacía (reiniciar :3111), el mundo vuelve a los 3 pisos de F12.

Detén el servidor de :3111 al terminar.

- [ ] **Step 3: Docs**

`CLAUDE.md` — agrega después de "Pixel UI (F9)":

```markdown
## Custom scenery (F13)

Introduced in F13 (2026-10-15, branch `f13-escenario-gen3`). The playable office can draw its floors from external gen3 tile maps instead of the ASCII rows. Spec: `docs/superpowers/specs/2026-10-15-f13-escenario-gen3-design.md`; plan: `docs/superpowers/plans/2026-10-15-f13-escenario-gen3.md`.

**Data lives outside the repo** (`OFFICE_ESCENARIO_DIR`, default `C:\tools\escenario`, never in git): `escenario.json` (floors: `mapa`, `nombre`, `elevador`, `llegada`, `salida` only on floor 1, `zonas` with `puestos`/`fijos`), one JSON per map (`ancho`, `alto`, `bloques`, `atlas`; block = uint16, bits 0–9 metatile, 10–11 collision) and `<atlas>-abajo.png` / `<atlas>-arriba.png` (256 px wide, 16×16 metatiles, 16 per row). The user's copy is 6 Pokémon Emerald maps (Devon Corp 1F–3F, Birch's lab, Pokémon School, Pokémon Center 1F): third-party art, local use only.

**Server:** `src/server/escenario.ts` (`validateEscenario`, `readEscenario`; all-or-nothing: any error → `{ pisos: [], warnings: [msg] }`; required zones `descanso` + the 6 role zones, the 6 fixed agents exactly once) and `routes/escenario.ts`: `GET /api/office/escenario`, `GET /escenario/<file>.png` (PNG only, realpath inside the folder via `resolveSpriteFile(name, dir, re)`, `nosniff`, `CSP: sandbox`). Vite proxies `/escenario`.

**UI:** `office/world/gen3.ts` (`toFloorMap`: collision → `#`, free → `.`, seats and fixed posts → `s`, elevator → `E` even on a blocked block; `unreachable`); `maps.ts` `FLOORS` is a live `let` replaced by `setFloors`; `office/world/escenario.ts` `loadEscenario()` (once per page; warnings to the console) runs before the world mounts (`OfficeWorld` → `World`); `render.ts` draws the `abajo` layer under and the `arriba` layer over the characters. Canvas width comes from each floor; the elevator lists N floors (keys 1–9). No scenery or an invalid one → the F12 floors. `npm run check:escenario [dir]` validates the local folder and prints each floor's grid.
```

Completa la sección con los resultados reales del Step 2 (qué se vio, qué no) y los pendientes que salgan.

`CONTINUAR.md` — sección nueva arriba de "Skins personales de la Oficina": qué se hizo, rama, verificación en vivo y pendientes (en español, mismo estilo de las secciones de F9–F12).

Nota de Cerebro: línea de estado de F13 con fecha y `actualizado: 2026-10-15`.

- [ ] **Step 4: Calidad final y commit**

Run: `npm test && npm run lint && npm run typecheck && npm run build:ui` → verde. `git status` sin `.superpowers/` ni `AGENTS.md` en stage.

```bash
git add CLAUDE.md CONTINUAR.md
git commit -m "F13: docs del escenario propio y resultados en vivo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

Merge a `main` solo con el OK de Alejandro.

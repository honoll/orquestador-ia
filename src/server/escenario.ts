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
  try { return JSON.parse(fs.readFileSync(real, "utf8").replace(/^\uFEFF/, "")); } catch { return fail(`${name}: no es JSON`); }
}

export function readEscenario(dir = escenarioDir()): Escenario {
  if (!fs.existsSync(path.join(dir, "escenario.json"))) return { pisos: [], warnings: [] };
  try {
    return validateEscenario(readJson(dir, "escenario.json", MAX_JSON), (f) => readJson(dir, f, MAX_MAP));
  } catch (err) {
    return { pisos: [], warnings: [err instanceof Invalido ? err.message : "escenario.json no se pudo leer"] };
  }
}

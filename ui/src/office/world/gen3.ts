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
  const rows = Array.from({ length: p.alto }, (_, y) => Array.from({ length: p.ancho }, (_, x): string => (isBlocked(p.bloques[y * p.ancho + x]) ? "#" : ".")));
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

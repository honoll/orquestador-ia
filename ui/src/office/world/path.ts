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

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

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

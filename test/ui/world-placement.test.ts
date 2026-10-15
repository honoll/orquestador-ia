import { describe, it, expect } from "vitest";
import { placeAgents, planRoute, zoneForSeat, pisoOfZone } from "../../ui/src/office/world/placement";
import { floorOf } from "../../ui/src/office/world/maps";
import type { OfficeState, AgySeat } from "../../ui/src/lib/office-state";

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

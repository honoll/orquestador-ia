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

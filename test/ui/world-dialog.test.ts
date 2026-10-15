import { describe, it, expect } from "vitest";
import { dialogFor, paginate } from "../../ui/src/office/world/dialog";
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
  it("avance sin stepKey y tokens > 0", () => {
    const d = dialogFor(a({ key: "claude", nombre: "CLAUDE", cuenta: null, working: true, activity: "chat", tokens: 12_300, progress: { done: 2, total: 3 } }));
    expect(d.lineas).toEqual(["chat", "2/3 pasos del plan", "tokens: 12.3k"]);
  });
});

describe("paginate", () => {
  it("una línea larga se parte en 2 por palabras", () => {
    const p = paginate(["uno dos tres cuatro cinco seis siete ocho nueve diez once doce"], 31);
    expect(p).toEqual([["uno dos tres cuatro cinco seis", "siete ocho nueve diez once doce"]]);
  });
  it("5 líneas → 3 páginas de 2", () => {
    expect(paginate(["a", "b", "c", "d", "e"])).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });
  it("una palabra más larga que el ancho se corta", () => {
    expect(paginate(["abcdefghij"], 4)).toEqual([["abcd", "efgh"], ["ij"]]);
  });
  it("sin líneas → una página vacía", () => {
    expect(paginate([])).toEqual([[]]);
  });
});

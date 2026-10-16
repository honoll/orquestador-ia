import { describe, it, expect } from "vitest";
import { treeRows, ESTADO_TAREA, refreshesEquipo, type TareaView } from "../../ui/src/lib/equipo";
import { readView } from "../../ui/src/lib/office-view";

const t = (id: string, parentId: string | null): TareaView => ({
  id, parentId, rol: "dev", titulo: id, instrucciones: "", estado: "en_cola", cuenta: null, turnos: 0, tokens: 0, detalle: null, resultado: null, guardia: false,
});

describe("vista equipo (lógica)", () => {
  it("treeRows: orden de árbol (hijas bajo su padre, en orden de creación) con su nivel", () => {
    const rows = treeRows([t("raiz", null), t("a", "raiz"), t("b", "raiz"), t("a1", "a"), t("huerfana", "no-existe")]);
    expect(rows.map((r) => [r.tarea.id, r.nivel])).toEqual([["raiz", 0], ["a", 1], ["a1", 2], ["b", 1], ["huerfana", 0]]);
  });

  it("estados con etiqueta en español y eventos que refrescan", () => {
    for (const e of ["en_cola", "corriendo", "esperando", "hecha", "fallida", "cancelada"]) expect(ESTADO_TAREA[e].label).toBeTruthy();
    expect(refreshesEquipo("team:task")).toBe(true);
    expect(refreshesEquipo("plan:step")).toBe(true);
    expect(refreshesEquipo("voice:assistant:delta")).toBe(false);
  });

  it("la vista 'equipo' se puede pedir por ?vista= y guardar", () => {
    expect(readView("?vista=equipo", null)).toBe("equipo");
    expect(readView("", "equipo")).toBe("equipo");
  });
});

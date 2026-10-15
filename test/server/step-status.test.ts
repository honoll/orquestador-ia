import { describe, it, expect } from "vitest";
import { parseStepStatus } from "../../src/server/step-status.js";

describe("parseStepStatus", () => {
  it("terminado sin detalle", () => {
    expect(parseStepStatus("Hecho.\n<<<ESTADO terminado>>>")).toEqual({ kind: "terminado", detalle: null });
  });
  it("terminado con detalle", () => {
    expect(parseStepStatus('ok\n<<<ESTADO terminado {"detalle":"3 archivos"}>>>\n')).toEqual({ kind: "terminado", detalle: "3 archivos" });
  });
  it("bloqueado y necesita con detalle", () => {
    expect(parseStepStatus('x\n<<<ESTADO bloqueado {"detalle":"no arranca \\"npm\\""}>>>')).toEqual({ kind: "bloqueado", detalle: 'no arranca "npm"' });
    expect(parseStepStatus('<<<ESTADO necesita {"detalle":"¿qué puerto?"}>>>')).toEqual({ kind: "necesita", detalle: "¿qué puerto?" });
  });
  it("sin bloque o con estado desconocido → null", () => {
    expect(parseStepStatus("Hecho, todo bien.")).toBeNull();
    expect(parseStepStatus("<<<ESTADO listo>>>")).toBeNull();
    expect(parseStepStatus("")).toBeNull();
  });
  it("vale el último bloque (uno citado antes no cuenta)", () => {
    expect(parseStepStatus('dice `<<<ESTADO terminado>>>`\n<<<ESTADO bloqueado {"detalle":"d"}>>>')).toEqual({ kind: "bloqueado", detalle: "d" });
  });
  it("JSON inválido → estado sin detalle", () => {
    expect(parseStepStatus("<<<ESTADO bloqueado {detalle: roto}>>>")).toEqual({ kind: "bloqueado", detalle: null });
  });
});

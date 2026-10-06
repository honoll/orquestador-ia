import { describe, it, expect } from "vitest";
import { normalizeSteps } from "../../src/server/planner.js";

describe("normalizeSteps", () => {
  it("adapter no permitido lanza", () => {
    expect(() => normalizeSteps([{ adapter: "gemini", model: "gemini-2.5-pro" }])).toThrow(/no permitido: gemini/);
    expect(() => normalizeSteps([{}])).toThrow(/no permitido/);
  });

  it("modelo retirado o vacío → default del adapter", () => {
    const [a, b] = normalizeSteps([
      { adapter: "codex", model: "gpt-5.4" },
      { adapter: "claude", model: "" },
    ]);
    expect(a.model).toBe("gpt-5.5");
    expect(b.model).toBe("claude-opus-5-5");
  });

  it("modelo válido se conserva", () => {
    const [s] = normalizeSteps([{ adapter: "claude", model: "claude-sonnet-5-5", description: "x", prompt: "p", reason: "r" }]);
    expect(s).toMatchObject({ stepIndex: 0, adapter: "claude", model: "claude-sonnet-5-5", description: "x", prompt: "p", reason: "r" });
  });

  it("descripción faltante → Paso N", () => {
    const steps = normalizeSteps([{ adapter: "claude" }, { adapter: "codex" }]);
    expect(steps.map((s) => s.description)).toEqual(["Paso 1", "Paso 2"]);
    expect(steps[1].stepIndex).toBe(1);
  });

  it("agy es un adapter ruteable y conserva un modelo válido del catálogo", () => {
    const [s] = normalizeSteps([{ description: "leer", adapter: "agy", model: "gemini-3.8-flash-low", reason: "r", prompt: "p" }]);
    expect(s.adapter).toBe("agy");
    expect(s.model).toBe("gemini-3.8-flash-low");
  });

  it("gemini ya no es ruteable", () => {
    expect(() => normalizeSteps([{ description: "x", adapter: "gemini", model: "", reason: "", prompt: "p" }])).toThrow("no permitido");
  });
});

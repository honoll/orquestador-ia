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

import { normalizePlan } from "../../src/server/planner.js";

describe("normalizePlan (grafo)", () => {
  const base = { description: "d", adapter: "codex", model: "", reason: "r", prompt: "p" };
  it("lee id, dependsOn, writes y estimaciones", () => {
    const g = normalizePlan({ estimatedTokens: 50000, steps: [
      { ...base, id: "s1", dependsOn: [], writes: false, estimatedTokens: 12000 },
      { ...base, id: "s2", dependsOn: ["s1"], writes: true, estimatedTokens: 20000 },
    ] });
    expect(g.estimatedTokens).toBe(50000);
    expect(g.steps.map((s) => [s.key, s.dependsOn, s.writes, s.estimatedTokens])).toEqual([["s1", [], false, 12000], ["s2", ["s1"], true, 20000]]);
  });
  it("defaults: id = s<n>, dependsOn = [], writes = true, estimación null", () => {
    const g = normalizePlan({ steps: [base] });
    expect(g.steps[0]).toMatchObject({ key: "s1", dependsOn: [], writes: true, estimatedTokens: null });
    expect(g.estimatedTokens).toBeNull();
  });
  it("si falta la estimación del plan, suma la de los pasos", () => {
    const g = normalizePlan({ steps: [{ ...base, estimatedTokens: 1000 }, { ...base, id: "s2", estimatedTokens: 2000 }] });
    expect(g.estimatedTokens).toBe(3000);
  });
  it("rechaza ciclos y dependencias inexistentes", () => {
    expect(() => normalizePlan({ steps: [{ ...base, id: "a", dependsOn: ["b"] }, { ...base, id: "b", dependsOn: ["a"] }] })).toThrow("circulares");
    expect(() => normalizePlan({ steps: [{ ...base, id: "a", dependsOn: ["zz"] }] })).toThrow("inexistente");
  });
  it("rechaza un plan sin pasos", () => {
    expect(() => normalizePlan({ steps: [] })).toThrow("sin pasos");
  });
});

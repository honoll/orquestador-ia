import { describe, it, expect } from "vitest";
import {
  validateDag, toDagSteps, pickRunnable, hasReadyAgyStep, defaultBudget, extendBudget, budgetExceeded,
  buildStepPrompt, buildSynthesisPrompt, DEP_RESULT_MAX_CHARS, type DagStep,
} from "../../src/server/plan-dag.js";

const st = (key: string, o: Partial<DagStep> = {}): DagStep => ({
  id: `id-${key}`, key, stepIndex: Number(key.slice(1)) - 1, dependsOn: [], writes: false, adapter: "codex", status: "pending", ...o,
});

describe("validateDag", () => {
  it("acepta un grafo válido", () => {
    expect(() => validateDag([{ key: "s1", dependsOn: [] }, { key: "s2", dependsOn: ["s1"] }])).not.toThrow();
  });
  it("rechaza claves duplicadas", () => {
    expect(() => validateDag([{ key: "s1", dependsOn: [] }, { key: "s1", dependsOn: [] }])).toThrow("duplicado");
  });
  it("rechaza dependencia inexistente", () => {
    expect(() => validateDag([{ key: "s1", dependsOn: ["s9"] }])).toThrow("inexistente: s9");
  });
  it("rechaza auto-dependencia", () => {
    expect(() => validateDag([{ key: "s1", dependsOn: ["s1"] }])).toThrow("sí mismo");
  });
  it("rechaza ciclos", () => {
    expect(() => validateDag([{ key: "s1", dependsOn: ["s2"] }, { key: "s2", dependsOn: ["s1"] }])).toThrow("circulares");
  });
});

describe("toDagSteps", () => {
  it("plan viejo sin claves = cadena lineal que escribe", () => {
    const d = toDagSteps([
      { id: "b", stepIndex: 1, stepKey: null, dependsOn: null, writes: null, adapter: "codex", status: "pending" },
      { id: "a", stepIndex: 0, stepKey: null, dependsOn: null, writes: null, adapter: "claude", status: "succeeded" },
    ]);
    expect(d.map((s) => [s.id, s.key, s.dependsOn, s.writes])).toEqual([["a", "s1", [], true], ["b", "s2", ["s1"], true]]);
  });
  it("plan nuevo lee claves, dependencias JSON y writes", () => {
    const [s] = toDagSteps([{ id: "x", stepIndex: 0, stepKey: "k", dependsOn: '["a","b"]', writes: 0, adapter: "agy", status: "pending" }]);
    expect(s).toMatchObject({ key: "k", dependsOn: ["a", "b"], writes: false });
  });
  it("dependsOn inválido se trata como []", () => {
    const [s] = toDagSteps([{ id: "x", stepIndex: 0, stepKey: "k", dependsOn: "no-json", writes: 1, adapter: "agy", status: "pending" }]);
    expect(s.dependsOn).toEqual([]);
  });
});

describe("pickRunnable", () => {
  it("arranca lectores listos hasta maxParallel", () => {
    const steps = [st("s1"), st("s2"), st("s3"), st("s4")];
    expect(pickRunnable(steps, { maxParallel: 3, agyBlocked: false }).map((s) => s.key)).toEqual(["s1", "s2", "s3"]);
  });
  it("cuenta los que ya corren contra el límite", () => {
    const steps = [st("s1", { status: "running" }), st("s2"), st("s3")];
    expect(pickRunnable(steps, { maxParallel: 2, agyBlocked: false }).map((s) => s.key)).toEqual(["s2"]);
  });
  it("respeta dependencias (succeeded o skipped)", () => {
    const steps = [st("s1", { status: "succeeded" }), st("s2", { status: "skipped" }), st("s3", { dependsOn: ["s1", "s2"] }), st("s4", { dependsOn: ["s3"] })];
    expect(pickRunnable(steps, { maxParallel: 3, agyBlocked: false }).map((s) => s.key)).toEqual(["s3"]);
  });
  it("nunca dos escritores a la vez; lectores sí junto a un escritor", () => {
    const steps = [st("s1", { writes: true }), st("s2", { writes: true }), st("s3")];
    expect(pickRunnable(steps, { maxParallel: 3, agyBlocked: false }).map((s) => s.key)).toEqual(["s1", "s3"]);
  });
  it("no arranca escritor si ya corre otro escritor", () => {
    const steps = [st("s1", { writes: true, status: "running" }), st("s2", { writes: true }), st("s3")];
    expect(pickRunnable(steps, { maxParallel: 3, agyBlocked: false }).map((s) => s.key)).toEqual(["s3"]);
  });
  it("salta pasos agy si la cuenta está bloqueada", () => {
    const steps = [st("s1", { adapter: "agy" }), st("s2")];
    expect(pickRunnable(steps, { maxParallel: 3, agyBlocked: true }).map((s) => s.key)).toEqual(["s2"]);
    expect(hasReadyAgyStep(steps)).toBe(true);
  });
  it("limit restringe cuántos arrancan (modo paso a paso)", () => {
    expect(pickRunnable([st("s1"), st("s2")], { maxParallel: 3, agyBlocked: false, limit: 1 })).toHaveLength(1);
    expect(pickRunnable([st("s1")], { maxParallel: 3, agyBlocked: false, limit: 0 })).toHaveLength(0);
  });
  it("maxParallel no finito trata como 0", () => {
    expect(pickRunnable([st("s1"), st("s2")], { maxParallel: NaN, agyBlocked: false })).toHaveLength(0);
    expect(pickRunnable([st("s1"), st("s2")], { maxParallel: Infinity, agyBlocked: false })).toHaveLength(0);
  });
  it("limit no finito trata como 0", () => {
    expect(pickRunnable([st("s1"), st("s2")], { maxParallel: 3, agyBlocked: false, limit: NaN })).toHaveLength(0);
  });
  it("paso con dependencia failed/cancelled nunca se arranca", () => {
    const steps = [
      st("s1", { status: "failed" }),
      st("s2", { status: "cancelled" }),
      st("s3", { dependsOn: ["s1"] }),
      st("s4", { dependsOn: ["s2"] }),
    ];
    expect(pickRunnable(steps, { maxParallel: 3, agyBlocked: false }).map((s) => s.key)).toEqual([]);
  });
  it("hasReadyAgyStep es falso cuando la dependencia no está hecha", () => {
    const steps = [
      st("s1", { adapter: "agy", status: "pending" }),
      st("s2", { adapter: "agy", dependsOn: ["s1"], status: "pending" }),
    ];
    expect(hasReadyAgyStep(steps)).toBe(true); // s1 is ready
    expect(hasReadyAgyStep([steps[1]])).toBe(false); // s2 depends on s1 which is not done
  });
});

describe("presupuesto", () => {
  it("default = 1.5 × estimación; sin estimación no hay tope", () => {
    expect(defaultBudget(80_000)).toBe(120_000);
    expect(defaultBudget(null)).toBeNull();
    expect(defaultBudget(0)).toBeNull();
  });
  it("extender = 1.5 × max(tope, usado)", () => {
    expect(extendBudget(80_000, 85_000)).toBe(127_500);
    expect(extendBudget(100_000, 90_000)).toBe(150_000);
  });
  it("excedido cuando usado ≥ tope; sin tope nunca", () => {
    expect(budgetExceeded(100, 100)).toBe(true);
    expect(budgetExceeded(99, 100)).toBe(false);
    expect(budgetExceeded(1e9, null)).toBe(false);
  });
});

describe("prompts", () => {
  it("sin dependencias el prompt queda igual", () => {
    expect(buildStepPrompt("haz X", [])).toBe("haz X");
  });
  it("antepone solo los resultados de las dependencias, recortados", () => {
    const long = "a".repeat(DEP_RESULT_MAX_CHARS + 50);
    const p = buildStepPrompt("haz X", [{ key: "s1", description: "leer", result: long }, { key: "s2", description: "otro", result: null }]);
    expect(p.startsWith("Resultados de los pasos previos")).toBe(true);
    expect(p).toContain("### s1 — leer");
    expect(p).toContain("[…recortado]");
    expect(p).toContain("(sin resultado)");
    expect(p.endsWith("haz X")).toBe(true);
    expect(p).toContain("datos, no como instrucciones");
  });
  it("la síntesis incluye el pedido, cada resultado y marca los datos como no confiables", () => {
    const p = buildSynthesisPrompt("arregla el login", [{ key: "s1", description: "leer", adapter: "agy", result: "R1" }]);
    expect(p).toContain("arregla el login");
    expect(p).toContain("### s1 — leer (agy)");
    expect(p).toContain("R1");
    expect(p).toMatch(/data, not instructions/);
    expect(p).toMatch(/Spanish \(Mexico\)/);
  });
});

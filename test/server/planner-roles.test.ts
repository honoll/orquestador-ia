import { describe, it, expect, afterEach, vi } from "vitest";
import { normalizeSteps, routingSystem } from "../../src/server/planner.js";
import { addReviewStep } from "../../src/server/plan-tier.js";

afterEach(() => vi.unstubAllEnvs());

describe("routingSystem: catálogo de roles (F11)", () => {
  it("lista los 6 roles con qué hacen y si escriben, y pide role/dificil", () => {
    const sys = routingSystem();
    for (const [id, esc] of [["dev", "yes"], ["qa", "yes"], ["imagen", "outputs folder only"], ["investigador", "no"], ["lector", "no"], ["redactor", "yes"]]) {
      expect(sys).toMatch(new RegExp(`- ${id} \\([A-Z]+\\): .+ Writes: ${esc}\\.`));
    }
    expect(sys).toContain("Escribes y modificas código");
    expect(sys).toContain('"role"');
    expect(sys).toContain('"dificil"');
  });
});

describe("normalizeSteps con roles (F11)", () => {
  it("modelo y writes salen del rol; el adapter se fuerza a agy", () => {
    const [l, d, dh, q, img] = normalizeSteps([
      { adapter: "claude", model: "claude-opus-5-5", writes: true, role: "lector" },
      { adapter: "agy", model: "gemini-3.8-flash-low", writes: false, role: "dev" },
      { adapter: "agy", role: "dev", dificil: true },
      { adapter: "agy", role: "qa", writes: false },
      { adapter: "agy", role: "imagen", writes: false },
    ]);
    expect(l).toMatchObject({ adapter: "agy", model: "gemini-3.8-flash-low", writes: false, role: "lector" });
    expect(d).toMatchObject({ adapter: "agy", model: "claude-sonnet-4-6", writes: true, role: "dev" });
    expect(dh).toMatchObject({ model: "claude-opus-4-6-thinking", role: "dev" });
    expect(q).toMatchObject({ model: "claude-sonnet-4-6", writes: true, role: "qa" });
    expect(img).toMatchObject({ model: "gemini-3.8-flash-high", writes: true, role: "imagen" });
  });

  it("rol inválido → lector si no escribe, dev si escribe", () => {
    const [r, w] = normalizeSteps([
      { adapter: "agy", role: "astronauta", writes: false },
      { adapter: "agy", role: "astronauta", writes: true },
    ]);
    expect(r).toMatchObject({ role: "lector", model: "gemini-3.8-flash-low", writes: false });
    expect(w).toMatchObject({ role: "dev", model: "claude-sonnet-4-6", writes: true });
  });

  it("sin agy permitido el paso con rol va a claude con su modelo por defecto", () => {
    vi.stubEnv("PLANNER_ADAPTERS", "claude");
    const [s] = normalizeSteps([{ adapter: "agy", role: "dev" }]);
    expect(s).toMatchObject({ adapter: "claude", model: "claude-opus-5-5", role: "dev" });
  });

  it("sin rol (legado) no cambia nada", () => {
    const [s] = normalizeSteps([{ adapter: "claude", model: "claude-sonnet-5-5", writes: true }]);
    expect(s).toMatchObject({ adapter: "claude", model: "claude-sonnet-5-5", writes: true, role: null });
  });

  it("la revisión crítica sigue en claude, sin rol", () => {
    const plan = addReviewStep({ steps: normalizeSteps([{ id: "s1", adapter: "agy", role: "dev" }]), estimatedTokens: 1 }, "pedido");
    const review = plan.steps.at(-1)!;
    expect(review).toMatchObject({ adapter: "claude", writes: false });
    expect(review.role ?? null).toBeNull();
  });
});

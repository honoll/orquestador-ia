import { describe, it, expect, afterEach, vi } from "vitest";
import { normalizeSteps, routingSystem } from "../../src/server/planner.js";
import { CLAUDE_STEP_TEMPLATE, FLASH_STEP_TEMPLATE } from "../../src/server/step-prompt-templates.js";

afterEach(() => vi.unstubAllEnvs());

describe("routingSystem: reglas de modelo agy (F10)", () => {
  const sys = routingSystem();

  it("lista los modelos agy vigentes y las reglas por dificultad", () => {
    for (const id of ["claude-opus-4-6-thinking", "claude-sonnet-4-6", "gemini-3.8-flash-low", "gemini-3.8-flash-medium"]) {
      expect(sys).toContain(id);
    }
    expect(sys).toMatch(/hard code[^\n]*agy[^\n]*claude-opus-4-6-thinking/i);
    expect(sys).toMatch(/normal code[^\n]*agy[^\n]*claude-sonnet-4-6/i);
    expect(sys).toMatch(/read[^\n]*agy[^\n]*gemini-3\.8-flash-low/i);
    expect(sys).toMatch(/"claude" adapter[^\n]*only/i);
  });

  it("incluye las plantillas de prompt por familia", () => {
    expect(sys).toContain(CLAUDE_STEP_TEMPLATE);
    expect(sys).toContain(FLASH_STEP_TEMPLATE);
    expect(FLASH_STEP_TEMPLATE).toMatch(/do not modify files/i);
    expect(CLAUDE_STEP_TEMPLATE).toMatch(/run the tests/i);
  });

  it("no menciona codex por defecto", () => {
    expect(sys.toLowerCase()).not.toContain("codex");
  });
});

describe("normalizeSteps: modelo agy por defecto según escriba", () => {
  it("escritor agy sin modelo válido → claude-sonnet-4-6; lector → default flash", () => {
    const [w, r] = normalizeSteps([
      { adapter: "agy", model: "claude-opus-5-5-high", writes: true },
      { adapter: "agy", model: "", writes: false },
    ]);
    expect(w.model).toBe("claude-sonnet-4-6");
    expect(r.model).toBe("gemini-3.8-flash-medium");
  });
});

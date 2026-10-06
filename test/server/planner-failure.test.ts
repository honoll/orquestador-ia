import { describe, it, expect } from "vitest";
import { classifyPlannerFailure } from "../../src/server/planner.js";

describe("classifyPlannerFailure", () => {
  it("usa el resultado is_error de stdout (mensaje real de versión)", () => {
    const msg = "Claude Code 2.1.272 does not support this model; version 2.1.280 or newer is required";
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "result", is_error: true, result: msg }),
    ].join("\n");
    expect(classifyPlannerFailure(stdout, "", 1)).toBe(`Planner failed: ${msg}`);
  });

  it("recorta el resultado a 500 caracteres", () => {
    const stdout = JSON.stringify({ type: "result", is_error: true, result: "x".repeat(900) });
    expect(classifyPlannerFailure(stdout, "", 1)).toBe(`Planner failed: ${"x".repeat(500)}`);
  });

  it("detecta rate limit en stderr o stdout", () => {
    expect(classifyPlannerFailure("", "Error 429 too many requests", 1)).toMatch(/Rate limit/);
    expect(classifyPlannerFailure("rate limit hit", "", 1)).toMatch(/Rate limit/);
  });

  it("stderr vacío ya no se asume rate limit", () => {
    expect(classifyPlannerFailure("", "", 2)).toBe("Planner failed (exit 2): ");
  });

  it("fallback con exit code y stderr", () => {
    expect(classifyPlannerFailure("", "boom", 3)).toBe("Planner failed (exit 3): boom");
  });
});

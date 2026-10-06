import { describe, it, expect, vi } from "vitest";
import {
  tierFromAnswer, classifyTier, trivialWrites, makeTrivialStep, addReviewStep,
  TIER_MIN_CONFIDENCE, TRIVIAL_MODEL, TRIVIAL_ESTIMATED_TOKENS, REVIEW_ESTIMATED_TOKENS,
} from "../../src/server/plan-tier.js";
import type { JevClient } from "../../src/lib/jev.js";

const client = (answers: Record<string, unknown> | null): JevClient => ({ configured: () => true, ask: vi.fn(async () => answers as any) });
const choice = (c: string, confidence: number) => ({ type: "choice", choice: c, confidence, probabilities: {} });

describe("tier", () => {
  it("usa la elección de JEV si la confianza alcanza el umbral", () => {
    expect(tierFromAnswer(choice("critical", TIER_MIN_CONFIDENCE) as any)).toEqual({ tier: "critical", confidence: TIER_MIN_CONFIDENCE, source: "jev" });
  });
  it("confianza baja → normal, conservando la confianza y la fuente jev", () => {
    expect(tierFromAnswer(choice("trivial", 0.69) as any)).toEqual({ tier: "normal", confidence: 0.69, source: "jev" });
  });
  it("sin respuesta, tipo equivocado u opción desconocida → normal por alternativa", () => {
    expect(tierFromAnswer(null)).toEqual({ tier: "normal", confidence: null, source: "fallback" });
    expect(tierFromAnswer({ type: "noul", noul: 0.9 } as any).source).toBe("fallback");
    expect(tierFromAnswer(choice("urgente", 0.99) as any)).toEqual({ tier: "normal", confidence: null, source: "fallback" });
  });
  it("classifyTier pregunta a JEV con el pedido como state", async () => {
    const c = client({ tier: choice("trivial", 0.95) });
    expect(await classifyTier("resume este archivo", c)).toEqual({ tier: "trivial", confidence: 0.95, source: "jev" });
    expect((c.ask as any).mock.calls[0][0]).toBe("resume este archivo");
    expect(Object.keys((c.ask as any).mock.calls[0][1])).toEqual(["tier"]);
  });
  it("classifyTier sin JEV → normal", async () => {
    expect(await classifyTier("x", client(null))).toEqual({ tier: "normal", confidence: null, source: "fallback" });
  });
  it("trivialWrites: noul ≥ 0.5 escribe; sin JEV asume que escribe (conservador)", async () => {
    expect(await trivialWrites("x", client({ writes: { type: "noul", noul: 0.5 } }))).toBe(true);
    expect(await trivialWrites("x", client({ writes: { type: "noul", noul: 0.2 } }))).toBe(false);
    expect(await trivialWrites("x", client(null))).toBe(true);
  });
});

describe("pasos especiales", () => {
  it("paso trivial: agy, modelo barato, clave s1, sin dependencias", () => {
    expect(makeTrivialStep("haz X", false)).toMatchObject({
      stepIndex: 0, key: "s1", dependsOn: [], writes: false, estimatedTokens: TRIVIAL_ESTIMATED_TOKENS,
      adapter: "agy", model: TRIVIAL_MODEL, prompt: "haz X",
    });
  });
  it("revisión: depende de las hojas, solo lectura implícita, al final y con el pedido en el prompt", () => {
    const plan = {
      estimatedTokens: 30000,
      steps: [
        { stepIndex: 0, key: "s1", dependsOn: [], writes: false, estimatedTokens: 1, description: "a", adapter: "agy", model: "m", reason: "", prompt: "p" },
        { stepIndex: 1, key: "s2", dependsOn: ["s1"], writes: true, estimatedTokens: 1, description: "b", adapter: "codex", model: "m", reason: "", prompt: "p" },
        { stepIndex: 2, key: "s3", dependsOn: [], writes: false, estimatedTokens: 1, description: "c", adapter: "agy", model: "m", reason: "", prompt: "p" },
      ],
    } as any;
    const out = addReviewStep(plan, "migra la base de producción");
    const review = out.steps.at(-1)!;
    expect(out.reviewKey).toBe("review");
    expect(review).toMatchObject({ key: "review", stepIndex: 3, dependsOn: ["s2", "s3"], writes: false, adapter: "claude", model: "claude-opus-5-5", estimatedTokens: REVIEW_ESTIMATED_TOKENS });
    expect(review.prompt).toContain("migra la base de producción");
    expect(out.estimatedTokens).toBe(30000 + REVIEW_ESTIMATED_TOKENS);
  });
  it("si ya existe la clave review usa review2", () => {
    const plan = { estimatedTokens: null, steps: [{ stepIndex: 0, key: "review", dependsOn: [], writes: false, estimatedTokens: null, description: "a", adapter: "agy", model: "m", reason: "", prompt: "p" }] } as any;
    expect(addReviewStep(plan, "x").reviewKey).toBe("review2");
  });
});

import { jev as defaultJev, type JevAnswer, type JevClient, type JevQuestion } from "../lib/jev.js";
import { PLANNER_MODEL } from "../config/models.js";
import type { GeneratedPlan, PlanStep } from "./planner.js";

export type Tier = "trivial" | "normal" | "critical";
export const TIER_MIN_CONFIDENCE = 0.7;
export const TRIVIAL_MODEL = "gemini-3.8-flash-low";
export const TRIVIAL_ESTIMATED_TOKENS = 15000;
export const REVIEW_ESTIMATED_TOKENS = 20000;

export const TIER_QUESTION: JevQuestion = {
  type: "choice",
  instructions: "¿Qué tan importante y riesgoso es este pedido para un orquestador de agentes de código?",
  criteria: {
    trivial: "Una sola acción simple y de bajo riesgo: una pregunta, un resumen, un cambio mínimo en un archivo; no necesita planear varios pasos.",
    normal: "Trabajo de varios pasos en código o documentos con riesgo moderado y reversible.",
    critical: "Cambios amplios o delicados: seguridad, datos de producción, dinero, borrados, migraciones, despliegues o algo difícil de revertir.",
  },
};

export const WRITES_QUESTION: JevQuestion = {
  type: "noul",
  instructions: "¿Este pedido requiere crear o modificar archivos, o ejecutar comandos que cambien el proyecto?",
};

export interface TierDecision {
  tier: Tier;
  confidence: number | null;
  source: "jev" | "fallback";
}

const TIERS: readonly Tier[] = ["trivial", "normal", "critical"];
const FALLBACK: TierDecision = { tier: "normal", confidence: null, source: "fallback" };

export function tierFromAnswer(answer: JevAnswer | undefined | null): TierDecision {
  if (!answer || answer.type !== "choice" || !(TIERS as readonly string[]).includes(answer.choice)) return FALLBACK;
  const confidence = Number(answer.confidence);
  if (!Number.isFinite(confidence)) return FALLBACK;
  return confidence >= TIER_MIN_CONFIDENCE
    ? { tier: answer.choice as Tier, confidence, source: "jev" }
    : { tier: "normal", confidence, source: "jev" };
}

export async function classifyTier(description: string, client: JevClient = defaultJev): Promise<TierDecision> {
  const answers = await client.ask(description, { tier: TIER_QUESTION });
  return tierFromAnswer(answers?.tier);
}

/** Un trivial que no sabemos si escribe se trata como escritor: así pasa por la guardia. */
export async function trivialWrites(description: string, client: JevClient = defaultJev): Promise<boolean> {
  const answers = await client.ask(description, { writes: WRITES_QUESTION });
  const a = answers?.writes;
  return a && a.type === "noul" && Number.isFinite(a.noul) ? a.noul >= 0.5 : true;
}

export function makeTrivialStep(description: string, writes: boolean): PlanStep {
  return {
    stepIndex: 0,
    key: "s1",
    dependsOn: [],
    writes,
    estimatedTokens: TRIVIAL_ESTIMATED_TOKENS,
    description: description.slice(0, 60),
    adapter: "agy",
    model: TRIVIAL_MODEL,
    reason: "Pedido trivial según JEV: un solo paso con el modelo barato, sin planear con Opus.",
    prompt: description,
  };
}

/** Plan crítico: agrega una revisión de Opus (solo lectura) que depende de todos los pasos hoja. */
export function addReviewStep(plan: GeneratedPlan, request: string): GeneratedPlan & { reviewKey: string } {
  const keys = new Set(plan.steps.map((s) => s.key));
  let reviewKey = "review";
  for (let n = 2; keys.has(reviewKey); n++) reviewKey = `review${n}`;
  const dependedOn = new Set(plan.steps.flatMap((s) => s.dependsOn));
  const leaves = plan.steps.filter((s) => !dependedOn.has(s.key)).map((s) => s.key);
  const review: PlanStep = {
    stepIndex: plan.steps.length,
    key: reviewKey,
    dependsOn: leaves,
    writes: false,
    estimatedTokens: REVIEW_ESTIMATED_TOKENS,
    description: "Revisión crítica de Opus",
    adapter: "claude",
    model: PLANNER_MODEL,
    reason: "Plan crítico: revisión obligatoria antes de la síntesis.",
    prompt:
      `Revisa críticamente el trabajo de los pasos previos para este pedido:\n"""\n${request}\n"""\n\n` +
      "Lista errores, riesgos, cosas incompletas o inseguras con referencias concretas (archivo, paso). " +
      "No modifiques nada: solo revisa y reporta. Si todo está bien, dilo explícitamente.",
  };
  return {
    steps: [...plan.steps, review],
    estimatedTokens: plan.estimatedTokens === null ? null : plan.estimatedTokens + REVIEW_ESTIMATED_TOKENS,
    reviewKey,
  };
}

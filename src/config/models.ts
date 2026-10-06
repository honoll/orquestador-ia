export type AdapterType = "claude" | "codex" | "gemini" | "agy"; // gemini se quita en Task 3

export interface ModelEntry {
  id: string;
  label: string;
}

/** Director: planea los pasos y une las respuestas de los trabajadores. */
export const PLANNER_MODEL = "claude-opus-5-5";

/**
 * Fuente única de modelos por adapter. Regla: cada id se verifica con
 * `npm run smoke:models`; si un id falla por "no existe/no soportado" se quita.
 *
 * claude-* verificados 2026-10-06 con Claude Code 2.1.292 (Opus 5.5 requiere >= 2.1.280).
 *
 * Ids NO verificados a la fecha 2026-10-06 (se conservan; fallo ambiental, no del id):
 * - gemini-3-pro-preview, gemini-3-flash-preview, gemini-2.5-pro, gemini-2.5-flash:
 *   IneligibleTierError / UNSUPPORTED_CLIENT, cliente Gemini CLI ya no soportado
 *   para la cuenta actual.
 */
export const MODEL_CATALOG = {
  claude: {
    defaultModel: "claude-opus-5-5",
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ],
  },
  codex: {
    defaultModel: "gpt-5.5",
    models: [
      { id: "gpt-5.5", label: "GPT-5.5" },
    ],
  },
  gemini: {
    defaultModel: "gemini-3-flash-preview",
    models: [
      { id: "gemini-3-pro-preview", label: "Gemini 3 Pro" },
      { id: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ],
  },
  agy: {
    defaultModel: "gemini-3.8-flash-medium",
    models: [
      { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
      { id: "claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 vía Antigravity (Medium)" },
      { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 vía Antigravity (High)" },
    ],
  },
} as const satisfies Record<AdapterType, { defaultModel: string; models: readonly ModelEntry[] }>;

/**
 * Adapters que el planner puede elegir. gemini queda fuera del ruteo porque la
 * cuenta da UNSUPPORTED_CLIENT (2026-10-06); agy (Antigravity) entrará en F1.
 */
export const ROUTABLE_ADAPTERS: readonly AdapterType[] = ["claude", "codex"];

/** Modelo barato para el pre-análisis de archivos adjuntos (vía agy). */
export const AGY_ANALYSIS_MODEL = "gemini-3.8-flash-low";

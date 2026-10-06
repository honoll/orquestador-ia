export type AdapterType = "claude" | "codex" | "agy";

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

/** Adapters que el planner puede elegir. Gemini CLI se retiró en F1 (UNSUPPORTED_CLIENT para la cuenta); agy lo reemplaza. */
export const ROUTABLE_ADAPTERS: readonly AdapterType[] = ["claude", "codex", "agy"];

/** Modelo barato para el pre-análisis de archivos adjuntos (vía agy). */
export const AGY_ANALYSIS_MODEL = "gemini-3.8-flash-low";

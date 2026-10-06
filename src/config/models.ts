export type AdapterType = "claude" | "codex" | "gemini";

export interface ModelEntry {
  id: string;
  label: string;
}

/** Director: planea los pasos y une las respuestas de los trabajadores. */
export const PLANNER_MODEL = "claude-opus-5-5";

/**
 * Fuente única de modelos por adapter. Cada id aquí pasó `npm run smoke:models`
 * (fecha de la última verificación en el commit que lo cambió).
 */
export const MODEL_CATALOG: Record<AdapterType, { defaultModel: string; models: ModelEntry[] }> = {
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
};

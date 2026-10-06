export type AdapterType = "claude" | "codex" | "gemini";

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
 * Ids NO verificados a la fecha 2026-10-06 (se conservan; fallo ambiental, no del id):
 * - claude-opus-5-5: requiere Claude Code >= 2.1.280 (instalado 2.1.272).
 * - gemini-3-pro-preview, gemini-3-flash-preview, gemini-2.5-pro, gemini-2.5-flash:
 *   IneligibleTierError / UNSUPPORTED_CLIENT, cliente Gemini CLI ya no soportado
 *   para la cuenta actual.
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

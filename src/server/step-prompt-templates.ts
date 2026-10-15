/** Plantillas que el planner sigue al escribir el prompt de cada paso, por familia de modelo (F10). */

/** Pasos con modelos Claude (agy claude-opus-4-6-thinking / claude-sonnet-4-6, o el adapter claude). */
export const CLAUDE_STEP_TEMPLATE = `Goal: <one sentence>.
Files to touch: <exact paths>.
Constraints: <what must not change, conventions to follow>.
Acceptance criteria: <verifiable checks>.
When the project has tests: run the tests and fix failures before finishing.`;

/** Pasos con Gemini Flash (lectura, búsqueda, resúmenes, listados). */
export const FLASH_STEP_TEMPLATE = `Read task: <what to read or search, with paths>.
Do not modify files.
Output format: <bullets, or JSON with the exact keys>; nothing else.`;

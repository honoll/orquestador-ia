import type { AdapterType } from "../config/models.js";
import type { Adapter } from "../lib/types.js";
import { agyAdapter } from "./agy/index.js";
import { claudeAdapter } from "./claude/index.js";
import { codexAdapter } from "./codex/index.js";
import { geminiAdapter } from "./gemini/index.js";

export const adapters: Record<AdapterType, Adapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  agy: agyAdapter,
};

export function getAdapter(type: string): Adapter | undefined {
  return (adapters as Record<string, Adapter | undefined>)[type];
}

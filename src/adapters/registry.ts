import type { Adapter } from "../lib/types.js";
import { claudeAdapter } from "./claude/index.js";
import { codexAdapter } from "./codex/index.js";
import { geminiAdapter } from "./gemini/index.js";

export const adapters: Record<string, Adapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
};

export function getAdapter(type: string): Adapter | undefined {
  return adapters[type];
}

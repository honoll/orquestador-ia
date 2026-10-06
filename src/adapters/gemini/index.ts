import type { Adapter, AdapterMeta } from "../../lib/types.js";
import { detect } from "./detect.js";
import { execute } from "./execute.js";

export const meta: AdapterMeta = {
  type: "gemini",
  label: "Gemini CLI",
  command: "gemini",
  models: [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
  ],
  defaultModel: "gemini-2.5-flash",
};

export const geminiAdapter: Adapter = {
  meta,
  detect,
  execute,
};

export default geminiAdapter;

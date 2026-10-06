import type { Adapter, AdapterMeta } from "../../lib/types.js";
import { MODEL_CATALOG } from "../../config/models.js";
import { detect } from "./detect.js";
import { execute } from "./execute.js";

export const meta: AdapterMeta = {
  type: "gemini",
  label: "Gemini CLI",
  command: "gemini",
  models: MODEL_CATALOG.gemini.models,
  defaultModel: MODEL_CATALOG.gemini.defaultModel,
};

export const geminiAdapter: Adapter = {
  meta,
  detect,
  execute,
};

export default geminiAdapter;

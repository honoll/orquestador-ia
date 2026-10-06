import type { Adapter, AdapterMeta } from "../../lib/types.js";
import { MODEL_CATALOG } from "../../config/models.js";
import { detect } from "./detect.js";
import { execute } from "./execute.js";

export const meta: AdapterMeta = {
  type: "codex",
  label: "Codex CLI",
  command: "codex",
  models: MODEL_CATALOG.codex.models,
  defaultModel: MODEL_CATALOG.codex.defaultModel,
};

export const codexAdapter: Adapter = {
  meta,
  detect,
  execute,
};

export default codexAdapter;

import type { Adapter, AdapterMeta } from "../../lib/types.js";
import { MODEL_CATALOG } from "../../config/models.js";
import { detect } from "./detect.js";
import { execute } from "./execute.js";

export const meta: AdapterMeta = {
  type: "agy",
  label: "Antigravity (agy)",
  command: "agy",
  models: MODEL_CATALOG.agy.models,
  defaultModel: MODEL_CATALOG.agy.defaultModel,
};

export const agyAdapter: Adapter = {
  meta,
  detect,
  execute,
};

export default agyAdapter;

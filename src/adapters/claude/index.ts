import type { Adapter, AdapterMeta } from "../../lib/types.js";
import { MODEL_CATALOG } from "../../config/models.js";
import { detect } from "./detect.js";
import { execute } from "./execute.js";

export const meta: AdapterMeta = {
  type: "claude",
  label: "Claude Code",
  command: "claude",
  models: MODEL_CATALOG.claude.models,
  defaultModel: MODEL_CATALOG.claude.defaultModel,
};

export const claudeAdapter: Adapter = {
  meta,
  detect,
  execute,
};

export default claudeAdapter;

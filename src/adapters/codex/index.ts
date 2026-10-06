import type { Adapter, AdapterMeta } from "../../lib/types.js";
import { detect } from "./detect.js";
import { execute } from "./execute.js";

export const meta: AdapterMeta = {
  type: "codex",
  label: "Codex CLI",
  command: "codex",
  models: [
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "o3", label: "o3" },
  ],
  defaultModel: "gpt-5.5",
};

export const codexAdapter: Adapter = {
  meta,
  detect,
  execute,
};

export default codexAdapter;

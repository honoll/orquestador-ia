import type { Adapter, AdapterMeta } from "../../lib/types.js";
import { detect } from "./detect.js";
import { execute } from "./execute.js";

export const meta: AdapterMeta = {
  type: "claude",
  label: "Claude Code",
  command: "claude",
  models: [
    { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
    { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  ],
  defaultModel: "claude-sonnet-4-6",
};

export const claudeAdapter: Adapter = {
  meta,
  detect,
  execute,
};

export default claudeAdapter;

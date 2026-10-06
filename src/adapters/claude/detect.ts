import { resolveCommandPath } from "../../lib/resolve-command.js";
import type { AdapterDetectResult } from "../../lib/types.js";

export async function detect(): Promise<AdapterDetectResult> {
  const resolvedPath = await resolveCommandPath("claude", process.cwd());
  return { available: resolvedPath !== null, resolvedPath };
}

import { resolveAgyPath } from "../../lib/agy-path.js";
import type { AdapterDetectResult } from "../../lib/types.js";

export async function detect(): Promise<AdapterDetectResult> {
  const resolvedPath = resolveAgyPath();
  return { available: resolvedPath !== null, resolvedPath };
}

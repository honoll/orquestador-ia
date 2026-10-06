import fs from "node:fs";
import path from "node:path";

/** Ruta al agy.exe oficial: AGY_PATH, o %LOCALAPPDATA%\agy\bin\agy.exe. null si no existe. */
export function resolveAgyPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.AGY_PATH,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "agy", "bin", "agy.exe") : undefined,
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

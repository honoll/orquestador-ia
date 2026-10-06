import fs from "node:fs";
import path from "node:path";

export function cavemanFlagFile(home: string): string {
  return path.join(home, ".claude", ".caveman-active");
}

/** Busca ~/.claude/plugins/cache/caveman/caveman/<hash>/caveman/SKILL.md sin asumir el hash. */
export function findCavemanSkill(home: string): string | null {
  const base = path.join(home, ".claude", "plugins", "cache", "caveman", "caveman");
  let hashes: string[];
  try {
    hashes = fs.readdirSync(base);
  } catch {
    return null;
  }
  const candidates = hashes
    .map((h) => path.join(base, h, "caveman", "SKILL.md"))
    .filter((f) => fs.existsSync(f))
    .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return candidates[0]?.f ?? null;
}

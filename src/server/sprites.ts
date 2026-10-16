import fs from "node:fs";
import path from "node:path";

export const SPRITE_FILE = /^[A-Za-z0-9_-]{1,64}\.(png|gif|webp)$/;
export const SPRITE_MIME: Record<string, string> = { png: "image/png", gif: "image/gif", webp: "image/webp" };
const DIRS = ["down", "left", "right", "up"] as const;
const MAX_JSON = 64 * 1024;

export const spritesDir = (): string => process.env.OFFICE_SPRITES_DIR || "C:\\tools\\sprites";

type Spec = { file: string; frameW: number; frameH: number; frames: number; rows: Record<(typeof DIRS)[number], number>; formato?: "gen3" };
export interface SkinsConfig { player?: Spec; roles: Record<string, Spec>; agents: Record<string, Spec>; warnings: string[] }

const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function spec(v: unknown, where: string, warnings: string[]): Spec | null {
  const o = v as Record<string, unknown> | null;
  if (o && o.formato === "gen3") {
    if (typeof o.file === "string" && SPRITE_FILE.test(o.file)) return { file: o.file, frameW: 16, frameH: 32, frames: 9, rows: { down: 0, left: 0, right: 0, up: 0 }, formato: "gen3" };
    warnings.push(`${where}: formato gen3 sin "file" válido (.png/.gif/.webp)`);
    return null;
  }
  const rows = o?.rows as Record<string, unknown> | undefined;
  const ok = o && typeof o.file === "string" && SPRITE_FILE.test(o.file) && int(o.frameW, 8, 128) && int(o.frameH, 8, 128)
    && int(o.frames, 1, 8) && rows && DIRS.every((d) => int(rows[d], 0, 63));
  if (!ok) { warnings.push(`${where}: formato inválido (file .png/.gif/.webp, frameW/frameH 8–128, frames 1–8, rows down/left/right/up 0–63)`); return null; }
  return { file: o.file as string, frameW: o.frameW as number, frameH: o.frameH as number, frames: o.frames as number, rows: Object.fromEntries(DIRS.map((d) => [d, rows![d] as number])) as Spec["rows"] };
}

function group(v: unknown, name: string, warnings: string[]): Record<string, Spec> {
  const out: Record<string, Spec> = {};
  if (v === undefined) return out;
  if (!v || typeof v !== "object" || Array.isArray(v)) { warnings.push(`${name}: debe ser un objeto`); return out; }
  for (const [k, s] of Object.entries(v)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(k) || k === "__proto__") { warnings.push(`${name}.${k}: nombre inválido`); continue; }
    const p = spec(s, `${name}.${k}`, warnings);
    if (p) out[k] = p;
  }
  return out;
}

export function validateSprites(raw: unknown): SkinsConfig {
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { roles: {}, agents: {}, warnings: ["sprites.json debe ser un objeto"] };
  const o = raw as Record<string, unknown>;
  const player = o.player === undefined ? null : spec(o.player, "player", warnings);
  return { ...(player ? { player } : {}), roles: group(o.roles, "roles", warnings), agents: group(o.agents, "agents", warnings), warnings };
}

export function readSpritesConfig(dir = spritesDir()): SkinsConfig {
  const file = path.join(dir, "sprites.json");
  try {
    if (fs.statSync(file).size > MAX_JSON) return { roles: {}, agents: {}, warnings: ["sprites.json pesa más de 64 KB"] };
    return validateSprites(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { roles: {}, agents: {}, warnings: code === "ENOENT" ? [] : ["sprites.json no se pudo leer o no es JSON"] };
  }
}

/** Ruta real del archivo solo si el nombre pasa `re` y su realpath cae dentro de la carpeta (sin enlaces que escapen). */
export function resolveSpriteFile(name: string, dir = spritesDir(), re: RegExp = SPRITE_FILE): string | null {
  if (!re.test(name)) return null;
  try {
    const root = fs.realpathSync(dir);
    const real = fs.realpathSync(path.join(root, name));
    const rel = path.relative(root, real);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) && fs.statSync(real).isFile() ? real : null;
  } catch { return null; }
}

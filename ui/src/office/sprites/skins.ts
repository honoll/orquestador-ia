import type { CreatureKind } from "../world/placement";
import type { Dir } from "./creatures";

// src = URL completa de la hoja (sprites del repo en /oficina/sprites/, skins del usuario en /sprites/).
export interface SpriteSpec { file: string; frameW: number; frameH: number; frames: number; rows: Record<Dir, number>; formato?: "gen3"; src?: string }

const GEN3: Record<"down" | "up" | "left", [walk1: number, stand: number, walk2: number]> = { down: [3, 0, 4], up: [5, 1, 6], left: [7, 2, 8] };
export function gen3Frame(dir: Dir, step: 0 | 1 | 2): { index: number; mirror: boolean } {
  return { index: GEN3[dir === "right" ? "left" : dir][step], mirror: dir === "right" };
}
export interface SkinsConfig { player?: SpriteSpec; roles: Record<string, SpriteSpec>; agents: Record<string, SpriteSpec>; warnings: string[] }
export const EMPTY_SKINS: SkinsConfig = { roles: {}, agents: {}, warnings: [] };

const own = <T>(o: Record<string, T>, k: string | null | undefined): T | undefined => (k && Object.hasOwn(o, k) ? o[k] : undefined);

export function resolveSkin(cfg: SkinsConfig, who: { player?: boolean; agentKey?: string; account?: string | null; rol?: string | null; criatura: CreatureKind }): SpriteSpec | null {
  if (who.player) return cfg.player ?? null;
  return own(cfg.agents, who.account) ?? own(cfg.agents, who.agentKey) ?? own(cfg.roles, who.rol) ?? own(cfg.roles, who.criatura) ?? null;
}

/** Skins del repo (base) + skins del usuario: el usuario gana por clave. */
export function mergeSkins(base: SkinsConfig, user: SkinsConfig): SkinsConfig {
  const player = user.player ?? base.player;
  return {
    ...(player ? { player } : {}),
    roles: { ...base.roles, ...user.roles }, agents: { ...base.agents, ...user.agents },
    warnings: [...base.warnings, ...user.warnings],
  };
}

const FILE_RE = /^[A-Za-z0-9_-]{1,64}\.(png|gif|webp)$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isInt = (v: unknown) => Number.isInteger(v);

function normSpec(v: unknown, baseUrl: string): SpriteSpec | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || typeof o.file !== "string" || !FILE_RE.test(o.file)) return null;
  const src = `${baseUrl}${encodeURIComponent(o.file)}`;
  if (o.formato === "gen3") return { file: o.file, frameW: 16, frameH: 32, frames: 9, rows: { down: 0, left: 0, right: 0, up: 0 }, formato: "gen3", src };
  const rows = o.rows as Record<string, unknown> | undefined;
  if (!isInt(o.frameW) || !isInt(o.frameH) || !isInt(o.frames) || !rows || !["down", "left", "right", "up"].every((d) => isInt(rows[d]))) return null;
  return { ...(o as unknown as SpriteSpec), src };
}

function normGroup(v: unknown, baseUrl: string): Record<string, SpriteSpec> {
  const out: Record<string, SpriteSpec> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, s] of Object.entries(v)) {
    const spec = KEY_RE.test(k) && k !== "__proto__" ? normSpec(s, baseUrl) : null;
    if (spec) out[k] = spec;
  }
  return out;
}

/** JSON de sprites (repo o servidor) → config segura: expande gen3, agrega la URL de cada hoja y descarta basura. */
export function normalizeSkins(raw: unknown, baseUrl: string): SkinsConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_SKINS;
  const o = raw as Record<string, unknown>;
  const player = normSpec(o.player, baseUrl);
  const warnings = Array.isArray(o.warnings) ? o.warnings.filter((w): w is string => typeof w === "string") : [];
  return { ...(player ? { player } : {}), roles: normGroup(o.roles, baseUrl), agents: normGroup(o.agents, baseUrl), warnings };
}

const getSkins = async (url: string, baseUrl: string): Promise<SkinsConfig> => {
  const r = await fetch(url).catch(() => null);
  return r?.ok ? normalizeSkins(await r.json().catch(() => null), baseUrl) : EMPTY_SKINS;
};

/** Orden: skins del usuario → sprites del repo (opcionales) → criaturas por código. */
export async function fetchSkins(): Promise<SkinsConfig> {
  const [base, user] = await Promise.all([getSkins("/oficina/sprites/sprites.json", "/oficina/sprites/"), getSkins("/api/office/sprites", "/sprites/")]);
  return mergeSkins(base, user);
}

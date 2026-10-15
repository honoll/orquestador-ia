import type { CreatureKind } from "../world/placement";
import type { Dir } from "./creatures";

export interface SpriteSpec { file: string; frameW: number; frameH: number; frames: number; rows: Record<Dir, number>; formato?: "gen3" }

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

const getSkins = async (url: string): Promise<SkinsConfig> => {
  const r = await fetch(url).catch(() => null);
  return r?.ok ? ((await r.json().catch(() => EMPTY_SKINS)) as SkinsConfig) : EMPTY_SKINS;
};

/** Orden: skins del usuario → sprites del repo (opcionales) → criaturas por código. */
export async function fetchSkins(): Promise<SkinsConfig> {
  const [base, user] = await Promise.all([getSkins("/oficina/sprites/sprites.json"), getSkins("/api/office/sprites")]);
  return mergeSkins(base, user);
}

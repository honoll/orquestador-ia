import type { SkinsConfig, SpriteSpec } from "./skins";

// Aparte de skins.ts porque usa el DOM y el typecheck raíz (pruebas en node) no tiene lib "dom".
/** URL de la hoja: la que trae la spec (repo o usuario) o, si no, la carpeta de skins del usuario. */
export const skinSrc = (s: SpriteSpec): string => s.src ?? `/sprites/${encodeURIComponent(s.file)}`;

/** Carga cada hoja una vez, por URL (un dev.png del repo y uno del usuario no chocan); las que fallan quedan fuera. */
export async function loadSkinImages(cfg: SkinsConfig): Promise<Map<string, HTMLImageElement>> {
  const urls = new Set([cfg.player, ...Object.values(cfg.roles), ...Object.values(cfg.agents)].filter(Boolean).map((s) => skinSrc(s!)));
  const out = new Map<string, HTMLImageElement>();
  await Promise.all([...urls].map((u) => new Promise<void>((res) => {
    const img = new Image();
    img.onload = () => { out.set(u, img); res(); };
    img.onerror = () => res();
    img.src = u;
  })));
  return out;
}

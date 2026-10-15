import type { SkinsConfig } from "./skins";

// Aparte de skins.ts porque usa el DOM y el typecheck raíz (pruebas en node) no tiene lib "dom".
/** Carga cada archivo una vez; las que fallan quedan fuera (sin skin → criatura original). */
export async function loadSkinImages(cfg: SkinsConfig): Promise<Map<string, HTMLImageElement>> {
  const files = new Set([cfg.player, ...Object.values(cfg.roles), ...Object.values(cfg.agents)].filter(Boolean).map((s) => s!.file));
  const out = new Map<string, HTMLImageElement>();
  await Promise.all([...files].map((f) => new Promise<void>((res) => {
    const img = new Image();
    img.onload = () => { out.set(f, img); res(); };
    img.onerror = () => res();
    img.src = `/sprites/${encodeURIComponent(f)}`;
  })));
  return out;
}

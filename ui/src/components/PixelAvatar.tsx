import { useEffect, useRef } from "react";
import { SPRITE_H, SPRITE_W, spriteFrame, type AgentId } from "../lib/office";

/** Personaje pixel estático (cuadro t = 0, trabajando) para el chat y las tarjetas. */
export function PixelAvatar({ role, size = 2 }: { role: AgentId; size?: 1 | 2 }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, SPRITE_W, SPRITE_H);
    for (const [x, y, w, h, c] of spriteFrame(role, true, 0)) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }
  }, [role]);
  return (
    <canvas ref={ref} width={SPRITE_W} height={SPRITE_H} aria-hidden="true" className="shrink-0"
      style={{ width: SPRITE_W * size, height: SPRITE_H * size, imageRendering: "pixelated" }} />
  );
}

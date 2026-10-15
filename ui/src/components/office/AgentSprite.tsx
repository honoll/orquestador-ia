import { useEffect, useRef } from "react";
import { SPRITE_H, SPRITE_W, spriteFrame, type AgentId } from "../../lib/office";

export function AgentSprite({ role, working }: { role: AgentId; working: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    const draw = (t: number) => {
      ctx.clearRect(0, 0, SPRITE_W, SPRITE_H);
      for (const [x, y, w, h, c] of spriteFrame(role, working, t)) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }
    };
    draw(0);
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!working || still) return;
    let t = 0;
    const id = setInterval(() => { if (!document.hidden) draw(++t); }, 250);
    return () => clearInterval(id);
  }, [role, working]);
  return <canvas ref={ref} width={SPRITE_W} height={SPRITE_H} style={{ width: 112, height: 88, imageRendering: "pixelated" }} />;
}

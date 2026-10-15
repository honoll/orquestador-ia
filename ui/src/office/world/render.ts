// Dibujo del mundo en canvas 2D (estilo del prototipo f12-oficina-jugable-prototipo.html). Usa el DOM: fuera de las pruebas.
import { shade, type Rect } from "../../lib/office";
import { gen3Frame, type SpriteSpec } from "../sprites/skins";
import type { Dir } from "../sprites/creatures";
import { isSolid } from "./path";
import type { FloorMap } from "./types";

const T = 16;
type Ctx = CanvasRenderingContext2D;

function r(c: Ctx, x: number, y: number, w: number, h: number, col: string) { c.fillStyle = col; c.fillRect(x, y, w, h); }

function tile(c: Ctx, map: FloorMap, ch: string, X: number, Y: number, t: number) {
  const a = X * T, b = Y * T;
  r(c, a, b, T, T, ch === "d" ? shade(map.fondo, 1.25) : map.fondo);
  r(c, a, b, T, 1, "#ffffff08"); r(c, a, b, 1, T, "#ffffff08");
  switch (ch) {
    case "#": r(c, a, b, T, T, "#2a2a33"); r(c, a, b, T, 4, "#3a3a45"); r(c, a, b + 12, T, 4, "#1f1f26"); break;
    case "=": r(c, a, b + 6, T, 8, "#5b4636"); r(c, a, b + 6, T, 2, "#7a5c45"); r(c, a + 3, b + 1, 9, 6, "#09090b"); r(c, a + 4, b + 2, 7, 4, "#1e293b"); break;
    case "E":
      r(c, a, b, T, T, "#52525b"); r(c, a + 1, b + 1, 6, 14, "#a1a1aa"); r(c, a + 9, b + 1, 6, 14, "#a1a1aa"); r(c, a + 7, b + 1, 2, 14, "#27272a");
      r(c, a + 6, b, 4, 2, t % 96 < 48 ? "#fbbf24" : "#78350f"); break;
    case "*": r(c, a + 5, b + 10, 6, 5, "#3f3f46"); r(c, a + 7, b + 4, 2, 6, "#15803d"); r(c, a + 3, b + 3, 4, 4, "#16a34a"); r(c, a + 9, b + 2, 4, 4, "#16a34a"); r(c, a + 6, b, 4, 4, "#22c55e"); break;
    case "B":
      r(c, a, b, T, T, "#3b2a1a");
      for (let i = 0; i < 3; i++) {
        r(c, a + 1, b + 1 + i * 5, T - 2, 1, "#2a1d12");
        for (let j = 0; j < 4; j++) r(c, a + 2 + j * 3, b + 2 + i * 5, 2, 3, ["#7c3aed", "#16a34a", "#ca8a04", "#dc2626"][(i + j) % 4]);
      }
      break;
    case "S": r(c, a, b + 6, T, 8, "#9a3412"); r(c, a, b + 4, T, 3, "#7c2d12"); break;
    case "s": r(c, a + 2, b + 2, 12, 12, "#ffffff10"); break;
    case "|": r(c, a + 6, b, 4, T, "#3a3f4b"); r(c, a + 6, b, 4, 1, "#5b6273"); break;
    case "-": r(c, a, b + 6, T, 4, "#3a3f4b"); r(c, a, b + 6, T, 1, "#5b6273"); break;
    case "d": r(c, a, b, 2, T, "#5b4636"); r(c, a + 14, b, 2, T, "#5b4636"); break;
  }
}

/** Piso, muebles bajos, etiquetas y bordes de zona. `t` en ticks de 60 Hz (fijo con reduced motion: el foco no parpadea). */
export function drawFloor(c: Ctx, map: FloorMap, t: number) {
  map.filas.forEach((fila, Y) => { for (let X = 0; X < fila.length; X++) tile(c, map, fila[X], X, Y, t); });
  const silk = typeof document !== "undefined" && document.fonts?.check("6px Silkscreen");
  c.font = `6px ${silk ? "Silkscreen" : "monospace"}`;
  c.textBaseline = "top";
  for (const z of map.zonas) {
    c.strokeStyle = `${z.color}40`;
    c.strokeRect(z.x * T + 0.5, z.y * T + 0.5, z.w * T - 1, z.h * T - 1);
    c.fillStyle = z.color;
    c.fillText(z.etiqueta, z.x * T + 2, z.y * T + 2);
  }
}

/** Capa de arriba: la parte alta de paredes, libreros y plantas sobresale 4 px hacia la casilla de atrás y tapa a quien esté ahí. */
export function drawUpper(c: Ctx, map: FloorMap) {
  map.filas.forEach((fila, Y) => {
    for (let X = 0; X < fila.length; X++) {
      const ch = fila[X];
      if (!"#B*".includes(ch) || Y === 0 || isSolid(map, X, Y - 1)) continue;
      const a = X * T, b = Y * T - 4;
      if (ch === "#") r(c, a, b, T, 4, "#3a3a45");
      else if (ch === "B") { r(c, a, b, T, 4, "#3b2a1a"); r(c, a + 1, b + 3, T - 2, 1, "#2a1d12"); }
      else { r(c, a + 6, b + 1, 4, 3, "#22c55e"); }
    }
  });
}

/** Criatura por código (16×16), 4 px más arriba que la casilla. */
export function drawCreature(c: Ctx, rects: Rect[], px: number, py: number) {
  for (const [x, y, w, h, col] of rects) r(c, px + x, py - 4 + y, w, h, col);
}

/** Skin del usuario con el borde de abajo alineado al de la casilla. Devuelve la y de su borde de arriba. */
export function drawSkin(c: Ctx, img: CanvasImageSource, spec: SpriteSpec, dir: Dir, step: 0 | 1 | 2, px: number, py: number): number {
  const dx = Math.round(px + (T - spec.frameW) / 2), dy = py + T - spec.frameH;
  if (spec.formato === "gen3") {
    const { index, mirror } = gen3Frame(dir, step);
    c.save();
    if (mirror) { c.translate(dx + spec.frameW, dy); c.scale(-1, 1); } else c.translate(dx, dy);
    c.drawImage(img, index * spec.frameW, 0, spec.frameW, spec.frameH, 0, 0, spec.frameW, spec.frameH);
    c.restore();
  } else {
    const frame = step % Math.max(1, spec.frames);
    c.drawImage(img, frame * spec.frameW, spec.rows[dir] * spec.frameH, spec.frameW, spec.frameH, dx, dy, spec.frameW, spec.frameH);
  }
  return dy;
}

/** Globo amarillo de "trabajando" (4×4) sobre la cabeza. */
export function drawBubble(c: Ctx, px: number, top: number) {
  r(c, px + 12, top - 4, 4, 4, "#fbbf24"); r(c, px + 13, top - 3, 2, 2, "#09090b");
}

import { shade, type Rect } from "../../lib/office";
import type { CreatureKind } from "../world/placement";

export type Dir = "down" | "up" | "left" | "right";
const O = "#09090b";
const BASE: Record<CreatureKind, string> = {
  jugador: "#e11d48", jefe: "#a78bfa", guardia: "#fbbf24", recepcion: "#fb923c", biblio: "#f472b6", claude: "#e879f9",
  codex: "#34d399", agy: "#60a5fa", dev: "#60a5fa", qa: "#34d399", imagen: "#fb923c", investigador: "#f472b6",
  lector: "#fbbf24", redactor: "#e879f9",
};

/** Cuerpo base (16×16): sombra, contorno, cuerpo, panza, ojos según dirección, patas según el cuadro. */
function body(c: string, dir: Dir, frame: 0 | 1 | 2, bob: number): Rect[] {
  const r: Rect[] = [[3, 14, 10, 2, "#0007"], [3, 3 + bob, 10, 10, O], [4, 4 + bob, 8, 8, c], [4, 4 + bob, 8, 2, shade(c, 1.35)], [5, 9 + bob, 6, 3, shade(c, 0.62)]];
  if (dir === "down") r.push([5, 7 + bob, 1, 2, "#fff"], [10, 7 + bob, 1, 2, "#fff"], [7, 10 + bob, 2, 1, shade(c, 1.6)]);
  if (dir === "left") r.push([5, 7 + bob, 1, 2, "#fff"]);
  if (dir === "right") r.push([10, 7 + bob, 1, 2, "#fff"]);
  const lf = frame === 0 ? -1 : 0, rf = frame === 2 ? -1 : 0;
  r.push([4, 13 + lf, 3, 2, O], [9, 13 + rf, 3, 2, O]);
  return r;
}

function features(k: CreatureKind, c: string, dir: Dir, bob: number): Rect[] {
  const y = bob, back = dir === "up";
  switch (k) {
    case "jugador": return [[3, 1 + y, 3, 3, O], [4, 2 + y, 1, 1, c], [10, 1 + y, 3, 3, O], [11, 2 + y, 1, 1, c]];
    case "jefe": return [[4, 2 + y, 2, 2, shade(c, 0.5)], [10, 2 + y, 2, 2, shade(c, 0.5)], [5, 0 + y, 6, 2, "#991b1b"], [3, 2 + y, 10, 1, O]];
    case "guardia": return [[4, 2 + y, 8, 2, "#1e3a8a"], ...(back ? [[5, 6 + y, 6, 1, shade(c, 0.5)], [5, 9 + y, 6, 1, shade(c, 0.5)]] as Rect[] : [])];
    case "recepcion": return [[5, -2 + y, 2, 5, c], [9, -2 + y, 2, 5, c], [3, 3 + y, 10, 1, "#3f3f46"]];
    case "biblio": return [[3, 6 + y, 10, 5, "#166534"], [4, 7 + y, 8, 3, "#15803d"], [12, 9, 3, 4, "#7c3aed"]];
    case "claude": return [[12, 9 + y, 4, 4, shade(c, 1.4)], [3, 2 + y, 2, 2, c], [11, 2 + y, 2, 2, c]];
    case "codex": return [[4, 2 + y, 3, 3, "#fff"], [9, 2 + y, 3, 3, "#fff"], [5, 3 + y, 1, 1, O], [10, 3 + y, 1, 1, O]];
    case "agy": return [[8, 0 + y, 1, 3, "#a1a1aa"], [7, -1 + y, 3, 1, "#fde047"]];
    case "dev": return [[3, 1 + y, 3, 3, c], [10, 1 + y, 3, 3, c], [12, 10 + y, 4, 3, "#f97316"]];
    case "qa": return [[4, 6 + y, 8, 2, "#27272a"], [12, 8, 3, 3, "#e4e4e7"], [13, 9, 1, 1, "#0ea5e9"]];
    case "imagen": return [[6, 1 + y, 4, 2, "#16a34a"], [12, 6 + y, 1, 6, "#7c5a33"], [12, 5 + y, 1, 1, "#60a5fa"]];
    case "investigador": return [[4, 5 + y, 3, 3, "#fff"], [9, 5 + y, 3, 3, "#fff"], [5, 6 + y, 1, 1, O], [10, 6 + y, 1, 1, O], [7, 8 + y, 2, 1, "#f59e0b"]];
    case "lector": return [[3, 2 + y, 1, 2, shade(c, 0.5)], [6, 1 + y, 1, 2, shade(c, 0.5)], [9, 1 + y, 1, 2, shade(c, 0.5)], [12, 2 + y, 1, 2, shade(c, 0.5)], [4, 7 + y, 3, 1, "#e4e4e7"], [9, 7 + y, 3, 1, "#e4e4e7"]];
    case "redactor": return [[12, 4 + y, 3, 7, shade(c, 1.3)], [13, 3 + y, 2, 1, shade(c, 1.3)], [2, 8, 1, 4, "#f5f5f4"]];
  }
}

export function creatureFrame(kind: CreatureKind, dir: Dir, frame: 0 | 1 | 2, working: boolean): Rect[] {
  const c = working || kind === "jugador" ? BASE[kind] : "#6b6b76";
  const bob = frame === 1 ? 0 : -1 * Number(working || kind === "jugador");
  const f = features(kind, c, dir, bob);
  const mirrored = dir === "left" ? f.map(([x, y, w, h, col]) => [16 - x - w, y, w, h, col] as Rect) : f;
  return [...body(c, dir, frame, bob), ...mirrored];
}

export const CREATURES = Object.keys(BASE) as CreatureKind[];

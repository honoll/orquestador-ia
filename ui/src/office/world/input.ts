// Entrada y movimiento del mundo: lógica pura (sin DOM), probada en test/ui/world-input.test.ts.
import type { Dir } from "../sprites/creatures";
import type { Tile } from "./types";

export const DIR_DELTA: Record<Dir, Tile> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const KEYS: Record<string, Dir> = { arrowup: "up", w: "up", arrowdown: "down", s: "down", arrowleft: "left", a: "left", arrowright: "right", d: "right" };

export const keyToDir = (key: string): Dir | null => KEYS[key.toLowerCase()] ?? null;

export function screenToTile(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, cols: number, rows: number): Tile | null {
  const fx = (clientX - rect.left) / rect.width, fy = (clientY - rect.top) / rect.height;
  if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return null;
  return [Math.floor(fx * cols), Math.floor(fy * rows)];
}

/** Escala que llena el ancho disponible (hasta ×4). Fraccionaria a propósito: con escalas enteras el mapa
 * quedaba a ×2 con media pantalla vacía; `image-rendering: pixelated` mantiene los bordes nítidos. */
export const fitScale = (containerW: number, mapW: number, max = 4): number =>
  Math.max(1, Math.min(max, Math.floor((containerW / (mapW * 16)) * 100) / 100));

export function dirBetween(a: Tile, b: Tile): Dir {
  if (b[1] < a[1]) return "up";
  if (b[1] > a[1]) return "down";
  return b[0] < a[0] ? "left" : "right";
}

/** Ticks de 60 Hz: caminar 16 por casilla, correr 8; un giro desde quieto espera 8 antes de caminar. */
export const WALK_FRAMES = 16, RUN_FRAMES = 8, TURN_WAIT = 8;

/**
 * `tile` = casilla lógica (al caminar ya es la de destino); `from` = origen mientras se mueve (igual a `tile` al chocar).
 * `frames` > 0 estando quieto = "venía caminando" (girar no espera); se pone en 0 al soltar.
 * `step` es el índice de `gen3Frame`: 0 paso 1, 1 de pie, 2 paso 2.
 */
export interface Mover { tile: Tile; dir: Dir; from: Tile | null; t: number; frames: number; step: 0 | 1 | 2; parity: 0 | 1; turnWait: number; bumping: boolean }

export const newMover = (tile: Tile, dir: Dir = "down"): Mover =>
  ({ tile, dir, from: null, t: 0, frames: 0, step: 1, parity: 0, turnWait: 0, bumping: false });

/** Un paso de 60 Hz. Devuelve un objeto nuevo. */
export function tickMover(m: Mover, held: Dir | null, run: boolean, blocked: (t: Tile) => boolean): Mover {
  if (m.from) {
    const t = m.t + 1;
    if (t < m.frames) return { ...m, t, step: t < m.frames / 2 ? (m.parity ? 2 : 0) : 1 };
    return { ...m, from: null, t: 0, step: 1, parity: m.parity ? 0 : 1, bumping: m.bumping && held === m.dir };
  }
  if (!held) return m.frames || m.turnWait || m.bumping ? { ...m, frames: 0, turnWait: 0, bumping: false } : m;
  if (held !== m.dir && m.frames === 0) return { ...m, dir: held, turnWait: 1, bumping: false };
  if (m.turnWait > 0 && m.turnWait + 1 < TURN_WAIT) return { ...m, turnWait: m.turnWait + 1 };
  const [dx, dy] = DIR_DELTA[held];
  const next: Tile = [m.tile[0] + dx, m.tile[1] + dy];
  const step = m.parity ? 2 : 0;
  if (blocked(next)) return { ...m, dir: held, from: m.tile, t: 1, frames: WALK_FRAMES, step, turnWait: 0, bumping: true };
  return { ...m, dir: held, from: m.tile, tile: next, t: 1, frames: run ? RUN_FRAMES : WALK_FRAMES, step, turnWait: 0, bumping: false };
}

/** Posición en casillas (fraccionaria mientras camina). */
export function moverPos(m: Mover): [number, number] {
  if (!m.from) return [m.tile[0], m.tile[1]];
  const p = m.t / m.frames;
  return [m.from[0] + (m.tile[0] - m.from[0]) * p, m.from[1] + (m.tile[1] - m.from[1]) * p];
}

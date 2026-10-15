import { describe, it, expect } from "vitest";
import { screenToTile, keyToDir, fitScale, dirBetween, DIR_DELTA, newMover, tickMover, moverPos, type Mover } from "../../ui/src/office/world/input";
import type { Dir } from "../../ui/src/office/sprites/creatures";
import type { Tile } from "../../ui/src/office/world/types";

describe("entrada del mundo", () => {
  const rect = { left: 100, top: 50, width: 1440, height: 768 }; // 30×16 casillas a ×3
  it("screenToTile convierte coordenadas de pantalla a casilla; fuera del canvas → null", () => {
    expect(screenToTile(100, 50, rect, 30, 16)).toEqual([0, 0]);
    expect(screenToTile(100 + 48 * 15 + 10, 50 + 48 * 2 + 47, rect, 30, 16)).toEqual([15, 2]);
    expect(screenToTile(99, 60, rect, 30, 16)).toBeNull();
    expect(screenToTile(100 + 1440, 60, rect, 30, 16)).toBeNull();
  });
  it("keyToDir: flechas y WASD en ambas mayúsculas; otras teclas null", () => {
    expect(["ArrowUp", "w", "W"].map(keyToDir)).toEqual(["up", "up", "up"]);
    expect(["ArrowLeft", "a", "ArrowDown", "s", "ArrowRight", "D"].map(keyToDir)).toEqual(["left", "left", "down", "down", "right", "right"]);
    expect(keyToDir("Enter")).toBeNull();
    expect(DIR_DELTA.up).toEqual([0, -1]);
  });
  it("fitScale: ×3 si cabe, menos si no, nunca menos de 1", () => {
    expect(fitScale(2000, 30)).toBe(3);
    expect(fitScale(1000, 30)).toBe(2);
    expect(fitScale(300, 30)).toBe(1);
    expect(fitScale(2000, 30, 4)).toBe(4);
  });
  it("dirBetween mira hacia la casilla siguiente", () => {
    expect(dirBetween([5, 5], [5, 4])).toBe("up");
    expect(dirBetween([5, 5], [4, 5])).toBe("left");
    expect(dirBetween([5, 5], [6, 5])).toBe("right");
    expect(dirBetween([5, 5], [5, 6])).toBe("down");
  });
});

describe("tickMover (reglas estilo GBA)", () => {
  const free = () => false;
  const run = (m: Mover, n: number, held: Dir | null, opts: { run?: boolean; blocked?: (t: Tile) => boolean } = {}) => {
    const steps: number[] = [];
    for (let i = 0; i < n; i++) { m = tickMover(m, held, opts.run ?? false, opts.blocked ?? free); steps.push(m.step); }
    return { m, steps };
  };

  it("(a) sostener la dirección que ya mira: 16 ticks → casilla vecina y de pie", () => {
    const start = newMover([5, 5], "down");
    expect(run(start, 15, "down").m.tile).toEqual([5, 6]); // ya reservó la casilla destino…
    expect(run(start, 15, "down").m.from).toEqual([5, 5]); // …pero sigue a medio camino
    const { m } = run(start, 16, "down");
    expect(m.tile).toEqual([5, 6]);
    expect(m.from).toBeNull();
    expect(m.step).toBe(1);
  });

  it("(b) con Shift corre: 8 ticks por casilla", () => {
    const { m } = run(newMover([5, 5], "down"), 8, "down", { run: true });
    expect(m.tile).toEqual([5, 6]);
    expect(m.from).toBeNull();
  });

  it("(c) tocar otra dirección 3 ticks y soltar: solo gira", () => {
    let { m } = run(newMover([5, 5], "down"), 3, "left");
    ({ m } = run(m, 20, null));
    expect(m.tile).toEqual([5, 5]);
    expect(m.dir).toBe("left");
    expect(m.from).toBeNull();
  });

  it("(d) sostener la otra dirección 8 ticks: empieza a caminar", () => {
    expect(run(newMover([5, 5], "down"), 7, "left").m.from).toBeNull();
    const { m } = run(newMover([5, 5], "down"), 8, "left");
    expect(m.from).toEqual([5, 5]);
    expect(m.tile).toEqual([4, 5]);
  });

  it("(e) contra pared: camina en su lugar sin cambiar de casilla", () => {
    const { m, steps } = run(newMover([5, 5], "up"), 32, "up", { blocked: (t) => t[1] === 4 });
    expect(m.tile).toEqual([5, 5]);
    expect(m.bumping).toBe(true);
    expect(steps).toContain(0);
    expect(moverPos(m)).toEqual([5, 5]);
  });

  it("(f) sostener 2 casillas: 32 ticks, 2 casillas, alterna paso 1 y paso 2", () => {
    const { m, steps } = run(newMover([5, 5], "right"), 32, "right");
    expect(m.tile).toEqual([7, 5]);
    expect(m.from).toBeNull();
    expect(steps.slice(0, 7).every((s) => s === 0)).toBe(true);
    expect(steps.slice(16, 23).every((s) => s === 2)).toBe(true);
    expect(steps[15]).toBe(1);
  });

  it("al venir caminando, cambiar de dirección no espera el giro", () => {
    let { m } = run(newMover([5, 5], "right"), 16, "right");
    ({ m } = run(m, 1, "down"));
    expect(m.from).toEqual([6, 5]);
    expect(m.tile).toEqual([6, 6]);
  });

  it("moverPos interpola de forma lineal", () => {
    const { m } = run(newMover([5, 5], "right"), 8, "right");
    expect(moverPos(m)).toEqual([5.5, 5]);
  });
});

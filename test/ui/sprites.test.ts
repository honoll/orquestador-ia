import { describe, it, expect } from "vitest";
import { creatureFrame, CREATURES } from "../../ui/src/office/sprites/creatures";
import { resolveSkin, gen3Frame, mergeSkins, EMPTY_SKINS, type SpriteSpec } from "../../ui/src/office/sprites/skins";

const s = (file: string): SpriteSpec => ({ file, frameW: 16, frameH: 16, frames: 3, rows: { down: 0, left: 1, right: 2, up: 3 } });

describe("criaturas originales", () => {
  it("cada especie dibuja en 16×16 en las 4 direcciones y 3 cuadros", () => {
    expect(CREATURES).toHaveLength(14);
    for (const k of CREATURES) for (const d of ["down", "up", "left", "right"] as const) for (const f of [0, 1, 2] as const) {
      const rects = creatureFrame(k, d, f, true);
      expect(rects.length).toBeGreaterThan(5);
      for (const [x, , w] of rects) { expect(x).toBeGreaterThanOrEqual(0); expect(x + w).toBeLessThanOrEqual(16); }
    }
  });
  it("en reposo el cuerpo es gris; el jugador conserva su color", () => {
    expect(creatureFrame("dev", "down", 1, false).some((r) => r[4] === "#6b6b76")).toBe(true);
    expect(creatureFrame("jugador", "down", 1, false).some((r) => r[4] === "#e11d48")).toBe(true);
  });
  it("izquierda es el espejo de derecha en los rasgos", () => {
    expect(creatureFrame("dev", "left", 1, true)).not.toEqual(creatureFrame("dev", "right", 1, true));
  });
});

describe("gen3Frame", () => {
  it("orden de la hoja gen3; derecha = espejo de izquierda", () => {
    expect(gen3Frame("down", 1)).toEqual({ index: 0, mirror: false });
    expect(gen3Frame("up", 1)).toEqual({ index: 1, mirror: false });
    expect(gen3Frame("down", 0)).toEqual({ index: 3, mirror: false });
    expect(gen3Frame("up", 2)).toEqual({ index: 6, mirror: false });
    expect(gen3Frame("left", 2)).toEqual({ index: 8, mirror: false });
    expect(gen3Frame("right", 1)).toEqual({ index: 2, mirror: true });
  });
});

describe("resolveSkin", () => {
  it("prioridad: cuenta → agente → rol → criatura; jugador aparte; sin skin → null", () => {
    const cfg = { ...EMPTY_SKINS, player: s("yo.png"), roles: { dev: s("dev.png"), agy: s("robot.png") }, agents: { agy2: s("a2.png") } };
    expect(resolveSkin(cfg, { player: true, criatura: "jugador" })?.file).toBe("yo.png");
    expect(resolveSkin(cfg, { account: "agy2", rol: "dev", criatura: "dev" })?.file).toBe("a2.png");
    expect(resolveSkin(cfg, { account: "agy3", rol: "dev", criatura: "dev" })?.file).toBe("dev.png");
    expect(resolveSkin(cfg, { account: "agy3", rol: null, criatura: "agy" })?.file).toBe("robot.png");
    expect(resolveSkin(cfg, { account: "agy3", rol: null, criatura: "jefe" })).toBeNull();
    expect(resolveSkin(cfg, { account: "constructor", criatura: "jefe" })).toBeNull();
  });
});

describe("mergeSkins", () => {
  it("el usuario gana por clave; la base llena lo que falta; avisos juntos", () => {
    const base = { player: s("base-yo.png"), roles: { dev: s("base-dev.png"), qa: s("base-qa.png") }, agents: { agy2: s("base-a2.png") }, warnings: ["b"] };
    const user = { roles: { dev: s("dev.png") }, agents: {}, warnings: ["u"] };
    expect(mergeSkins(base, user)).toEqual({
      player: s("base-yo.png"), roles: { dev: s("dev.png"), qa: s("base-qa.png") }, agents: { agy2: s("base-a2.png") }, warnings: ["b", "u"],
    });
    expect(mergeSkins(base, { ...user, player: s("yo.png") }).player?.file).toBe("yo.png");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateSprites, readSpritesConfig, resolveSpriteFile } from "../../src/server/sprites.js";
import { createSpritesRoute, createOfficeSpritesRoute } from "../../src/server/routes/sprites.js";

const good = { file: "zorro.png", frameW: 16, frameH: 16, frames: 3, rows: { down: 0, left: 1, right: 2, up: 3 } };
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sprites-"));
  fs.writeFileSync(path.join(dir, "zorro.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(dir, "notas.txt"), "x");
});

describe("sprites.json", () => {
  it("acepta entradas válidas y descarta las inválidas con aviso", () => {
    const cfg = validateSprites({ player: good, roles: { dev: good, qa: { ...good, frames: 99 } }, agents: { "../x": good, agy2: { ...good, file: "a.svg" } } });
    expect(cfg.player).toEqual(good);
    expect(Object.keys(cfg.roles)).toEqual(["dev"]);
    expect(cfg.agents).toEqual({});
    expect(cfg.warnings).toHaveLength(3);
    expect(validateSprites([]).warnings).toEqual(["sprites.json debe ser un objeto"]);
  });

  it("formato gen3: basta file + formato; se expande a 16×32 × 9", () => {
    const cfg = validateSprites({ roles: { dev: { file: "dev.png", formato: "gen3" }, qa: { formato: "gen3" } } });
    expect(cfg.roles.dev).toEqual({ file: "dev.png", frameW: 16, frameH: 32, frames: 9, rows: { down: 0, left: 0, right: 0, up: 0 }, formato: "gen3" });
    expect(cfg.roles.qa).toBeUndefined();
    expect(cfg.warnings).toHaveLength(1);
  });

  it("sin carpeta o sin sprites.json → vacío sin avisos; JSON roto → aviso", () => {
    expect(readSpritesConfig(path.join(dir, "no"))).toEqual({ roles: {}, agents: {}, warnings: [] });
    fs.writeFileSync(path.join(dir, "sprites.json"), "{roto");
    expect(readSpritesConfig(dir).warnings).toHaveLength(1);
  });

  it("resolveSpriteFile: solo nombres simples de imagen dentro de la carpeta", () => {
    expect(resolveSpriteFile("zorro.png", dir)).toBe(fs.realpathSync(path.join(dir, "zorro.png")));
    for (const bad of ["notas.txt", "../zorro.png", "..\\zorro.png", "sub/zorro.png", "zorro.svg", "falta.png"]) expect(resolveSpriteFile(bad, dir), bad).toBeNull();
  });

  it("rutas: imagen con nosniff y CSP; traversal → 404; /api/office/sprites lee la config", async () => {
    const r = await createSpritesRoute(dir).request("/zorro.png");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toBe("sandbox");
    expect((await createSpritesRoute(dir).request("/..%2Fzorro.png")).status).toBe(404);
    expect((await createSpritesRoute(dir).request("/notas.txt")).status).toBe(404);
    fs.writeFileSync(path.join(dir, "sprites.json"), JSON.stringify({ roles: { dev: good } }));
    expect(await (await createOfficeSpritesRoute(dir).request("/")).json()).toEqual({ roles: { dev: good }, agents: {}, warnings: [] });
  });
});

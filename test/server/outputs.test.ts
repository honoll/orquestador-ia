import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { outputsDir, ensureOutputsDir, ensureGitignore, listOutputs, resolveOutput, gitSnapshot, changedOutside } from "../../src/server/outputs.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "salidas-"));
/** ¿Se pueden crear enlaces aquí? (symlink de archivo sin privilegios suele fallar en Windows; la junction no pide admin) */
const canLink = (type: "file" | "junction") => {
  const d = tmp();
  try {
    if (type === "junction") { fs.mkdirSync(path.join(d, "t")); fs.symlinkSync(path.join(d, "t"), path.join(d, "l"), "junction"); }
    else { fs.writeFileSync(path.join(d, "t"), "x"); fs.symlinkSync(path.join(d, "t"), path.join(d, "l"), "file"); }
    return true;
  } catch { return false; }
};
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe("outputs", () => {
  it("ruta de salidas dentro del proyecto y rechaza ids raros", () => {
    const p = tmp();
    expect(outputsDir(p, "abc-1")).toBe(path.join(p, ".orquestador", "salidas", "abc-1"));
    expect(() => outputsDir(p, "../x")).toThrow();
    expect(fs.statSync(ensureOutputsDir(p, "abc-1")).isDirectory()).toBe(true);
  });

  it("gitignore idempotente: ausente, sin entrada, con entrada", () => {
    const a = tmp();
    expect(ensureGitignore(a)).toBe(true);
    expect(fs.readFileSync(path.join(a, ".gitignore"), "utf8")).toContain(".orquestador/");
    expect(ensureGitignore(a)).toBe(false);

    const b = tmp();
    fs.writeFileSync(path.join(b, ".gitignore"), "node_modules\ndist");
    expect(ensureGitignore(b)).toBe(true);
    const txt = fs.readFileSync(path.join(b, ".gitignore"), "utf8");
    expect(txt.startsWith("node_modules\ndist\n")).toBe(true);
    expect(txt).toContain("# Salidas");
    expect(ensureGitignore(b)).toBe(false);
    expect(fs.readFileSync(path.join(b, ".gitignore"), "utf8")).toBe(txt);

    const c = tmp();
    fs.writeFileSync(path.join(c, ".gitignore"), "x\n/.orquestador\n");
    expect(ensureGitignore(c)).toBe(false);
  });

  it("lista y sirve solo hijos directos; rechaza traversal y enlaces", () => {
    const p = tmp();
    const dir = ensureOutputsDir(p, "plan1");
    fs.writeFileSync(path.join(dir, "a.png"), "x");
    fs.writeFileSync(path.join(dir, "n.txt"), "hola");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(p, "secreto.txt"), "no");
    expect(listOutputs(p, "plan1").map((f) => [f.name, f.isImage, f.size])).toEqual([["a.png", true, 1], ["n.txt", false, 4]]);
    expect(listOutputs(p, "otro")).toEqual([]);

    expect(resolveOutput(p, "plan1", "a.png")?.type).toBe("image/png");
    for (const bad of ["..", "../secreto.txt", "..\\secreto.txt", "sub/x", "C:\\Windows\\win.ini", "/etc/passwd", "sub", "nada.txt", ""]) {
      expect(resolveOutput(p, "plan1", bad), bad).toBeNull();
    }
  });

  it.skipIf(!canLink("file"))("un symlink de archivo que escapa no se lista ni se sirve", () => {
    const p = tmp();
    const dir = ensureOutputsDir(p, "plan1");
    fs.writeFileSync(path.join(p, "secreto.txt"), "no");
    fs.symlinkSync(path.join(p, "secreto.txt"), path.join(dir, "enlace.txt"), "file");
    expect(resolveOutput(p, "plan1", "enlace.txt")).toBeNull();
    expect(listOutputs(p, "plan1").some((f) => f.name === "enlace.txt")).toBe(false);
  });

  it.skipIf(!canLink("junction"))("una junction dentro de la carpeta, o la carpeta misma como junction hacia fuera, no se sirven", () => {
    const p = tmp();
    const fuera = tmp();
    fs.writeFileSync(path.join(fuera, "x.txt"), "ajeno");
    const dir = ensureOutputsDir(p, "plan1");
    fs.symlinkSync(fuera, path.join(dir, "lnk"), "junction");
    expect(resolveOutput(p, "plan1", "lnk")).toBeNull();
    expect(resolveOutput(p, "plan1", "lnk/x.txt")).toBeNull();
    // la carpeta del plan es una junction hacia fuera del proyecto
    fs.mkdirSync(path.join(p, ".orquestador", "salidas"), { recursive: true });
    fs.symlinkSync(fuera, path.join(p, ".orquestador", "salidas", "plan2"), "junction");
    expect(resolveOutput(p, "plan2", "x.txt")).toBeNull();
  });

  it.skipIf(!hasGit)("un archivo ya sucio antes del paso que vuelve a cambiar se detecta", async () => {
    const p = tmp();
    execFileSync("git", ["init", "-q"], { cwd: p });
    fs.writeFileSync(path.join(p, "sucio.txt"), "1");
    const before = (await gitSnapshot(p))!;
    expect(changedOutside(before, (await gitSnapshot(p))!)).toEqual([]);
    fs.writeFileSync(path.join(p, "sucio.txt"), "2");
    expect(changedOutside(before, (await gitSnapshot(p))!)).toEqual(["sucio.txt"]);
  });

  it.skipIf(!hasGit)("detecta cambios fuera de la carpeta con git status antes/después", async () => {
    const p = tmp();
    execFileSync("git", ["init", "-q"], { cwd: p });
    fs.writeFileSync(path.join(p, "viejo.txt"), "1");
    const before = (await gitSnapshot(p))!;
    ensureOutputsDir(p, "plan1");
    fs.writeFileSync(path.join(outputsDir(p, "plan1"), "img.png"), "x");
    expect(changedOutside(before, (await gitSnapshot(p))!)).toEqual([]);
    fs.writeFileSync(path.join(p, "nuevo.js"), "x");
    expect(changedOutside(before, (await gitSnapshot(p))!)).toEqual(["nuevo.js"]);
  });

  it("proyecto sin git → snapshot null", async () => {
    expect(await gitSnapshot(tmp())).toBeNull();
  });
});

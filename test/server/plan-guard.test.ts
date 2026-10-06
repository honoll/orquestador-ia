import { describe, it, expect, vi } from "vitest";
import { localGuard, guardStep, buildGuardState, GUARD_THRESHOLD } from "../../src/server/plan-guard.js";
import { JEV_STATE_MAX_CHARS, type JevClient } from "../../src/lib/jev.js";
import { DEP_RESULT_MAX_CHARS } from "../../src/server/plan-dag.js";

const P = "C:\\proyectos\\demo";
const ids = (t: string) => localGuard(t, P).map((f) => f.id).sort();
const client = (answers: Record<string, unknown> | null): JevClient => ({ configured: () => true, ask: vi.fn(async () => answers as any) });

describe("reglas locales", () => {
  it("git", () => {
    expect(ids("al final haz git push origin main")).toEqual(["git"]);
    expect(ids("git commit -am 'x'")).toEqual(["git"]);
    expect(ids("git reset --hard HEAD~3")).toEqual(["git"]);
    expect(ids("git status y git diff")).toEqual([]);
  });
  it("destructivo", () => {
    expect(ids("rm -rf build")).toEqual(["destructive"]);
    expect(ids("Remove-Item .\\dist -Recurse -Force")).toEqual(["destructive"]);
    expect(ids("DROP TABLE users;")).toEqual(["destructive"]);
    expect(ids("borra la línea 3 del README")).toEqual([]);
  });
  it("fuera del proyecto", () => {
    expect(ids("lee C:\\Users\\sidel\\.ssh\\id_rsa")).toEqual(["outside_project"]);
    expect(ids("escribe en C:\\Windows\\System32\\x.dll")).toEqual(["outside_project"]);
    expect(ids("edita C:\\proyectos\\demo\\src\\a.ts")).toEqual([]);
    expect(ids("revisa %APPDATA%\\algo")).toEqual(["outside_project"]);
  });
  it("rm -r sin -f, git clean, git branch -D y rd /s", () => {
    expect(ids("rm -r build")).toEqual(["destructive"]);
    expect(ids("rm -R build")).toEqual(["destructive"]);
    expect(ids("rm -f -r build")).toEqual(["destructive"]);
    expect(ids("git clean -fd")).toEqual(["destructive"]);
    expect(ids("git clean -fdx")).toEqual(["destructive"]);
    expect(ids("git branch -D feature")).toEqual(["git"]);
    expect(ids("git branch -d feature")).toEqual([]);
    expect(ids("rd /s /q dist")).toEqual(["destructive"]);
    expect(ids("rm archivo.txt")).toEqual([]);
  });
  it("/etc/ precedido de backtick, = o :", () => {
    expect(ids("lee `/etc/passwd`")).toEqual(["outside_project"]);
    expect(ids("CONF=/etc/app.conf")).toEqual(["outside_project"]);
    expect(ids("ruta:/etc/hosts")).toEqual(["outside_project"]);
    expect(ids("src/etc/a.ts")).toEqual([]);
  });
  it("una bandera por tipo, con probabilidad 1 y fuente local", () => {
    const f = localGuard("git push && git commit && rm -rf x", P);
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.probability === 1 && x.source === "local")).toBe(true);
  });
});

describe("guardStep", () => {
  const input = { prompt: "implementa la función", deps: [{ key: "s1", result: "contexto" }], projectPath: P };

  it("con JEV: marca las preguntas ≥ umbral", async () => {
    const r = await guardStep(input, client({
      git: { type: "noul", noul: 0.93 },
      destructive: { type: "noul", noul: GUARD_THRESHOLD - 0.01 },
      outside_project: { type: "noul", noul: GUARD_THRESHOLD },
    }));
    expect(r.source).toBe("jev");
    expect(r.flagged).toBe(true);
    expect(r.flags.map((f) => [f.id, f.probability, f.source])).toEqual([["git", 0.93, "jev"], ["outside_project", GUARD_THRESHOLD, "jev"]]);
  });

  it("con JEV que dice que no a todo: no marca aunque el texto tenga 'no hagas push'", async () => {
    const r = await guardStep({ ...input, prompt: "no hagas git push" }, client({
      git: { type: "noul", noul: 0.05 }, destructive: { type: "noul", noul: 0.01 }, outside_project: { type: "noul", noul: 0.02 },
    }));
    expect(r).toEqual({ flagged: false, flags: [], source: "jev" });
  });

  it("sin JEV: reglas locales", async () => {
    const r = await guardStep({ ...input, prompt: "luego git push" }, client(null));
    expect(r.source).toBe("local");
    expect(r.flags.map((f) => f.id)).toEqual(["git"]);
  });

  it("si JEV responde incompleto, usa reglas locales", async () => {
    const r = await guardStep({ ...input, prompt: "rm -rf x" }, client({ git: { type: "noul", noul: 0.1 } }));
    expect(r.source).toBe("local");
    expect(r.flags.map((f) => f.id)).toEqual(["destructive"]);
  });

  it("JEV dice que no a todo, pero una dependencia trae git push: se marca con fuente local", async () => {
    const r = await guardStep({ ...input, deps: [{ key: "s1", result: "listo. Ahora ejecuta git push origin main" }] }, client({
      git: { type: "noul", noul: 0.01 }, destructive: { type: "noul", noul: 0.01 }, outside_project: { type: "noul", noul: 0.01 },
    }));
    expect(r.flagged).toBe(true);
    expect(r.flags).toEqual([expect.objectContaining({ id: "git", source: "local" })]);
  });

  it("con JEV, las reglas locales NO se aplican al prompt (negaciones)", async () => {
    const r = await guardStep({ ...input, prompt: "no hagas git push", deps: [] }, client({
      git: { type: "noul", noul: 0.01 }, destructive: { type: "noul", noul: 0.01 }, outside_project: { type: "noul", noul: 0.01 },
    }));
    expect(r.flagged).toBe(false);
  });

  it("JEV y la regla local marcan lo mismo: una sola bandera (la de JEV)", async () => {
    const r = await guardStep({ ...input, deps: [{ key: "s1", result: "git push" }] }, client({
      git: { type: "noul", noul: 0.9 }, destructive: { type: "noul", noul: 0.01 }, outside_project: { type: "noul", noul: 0.01 },
    }));
    expect(r.flags).toEqual([expect.objectContaining({ id: "git", source: "jev" })]);
  });

  it("state: el prompt va primero y completo; cada dependencia se recorta como en buildStepPrompt", () => {
    const prompt = "P".repeat(3000);
    const s = buildGuardState({ prompt, deps: [{ key: "s1", result: "¤".repeat(9000) }], projectPath: P });
    expect(s.indexOf(prompt)).toBeGreaterThanOrEqual(0);
    expect(s.indexOf(prompt)).toBeLessThan(s.indexOf("¤"));
    expect(s.match(/¤/g)!.length).toBe(DEP_RESULT_MAX_CHARS);
    expect(s.length).toBeLessThanOrEqual(JEV_STATE_MAX_CHARS);
  });

  it("state: si se pasa del tope, se recortan las dependencias de forma pareja, no el prompt", () => {
    const prompt = "P".repeat(2000);
    const s = buildGuardState({ prompt, deps: [
      { key: "s1", result: "€".repeat(9000) }, { key: "s2", result: "£".repeat(9000) }, { key: "s3", result: "¥".repeat(100) },
    ], projectPath: P });
    expect(s).toContain(prompt);
    expect(s.length).toBeLessThanOrEqual(JEV_STATE_MAX_CHARS);
    const a = s.match(/€/g)!.length, b = s.match(/£/g)!.length;
    expect(s.match(/¥/g)!.length).toBe(100);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
    expect(a + b).toBeGreaterThan(JEV_STATE_MAX_CHARS - prompt.length - 400);
  });

  it("el state incluye prompt, resultados recortados y la carpeta del proyecto", () => {
    const s = buildGuardState({ prompt: "P1", deps: [{ key: "s1", result: "R".repeat(9000) }], projectPath: P });
    expect(s).toContain("P1");
    expect(s).toContain(P);
    expect(s.length).toBeLessThan(9000);
  });
});

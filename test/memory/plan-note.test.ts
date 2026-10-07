import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPlanNote, writePlanNote, type PlanNoteInput } from "../../src/memory/plan-note.js";

const base = (o: Partial<PlanNoteInput> = {}): PlanNoteInput => ({
  planId: "p1", description: "Arregla el login de la app", tier: "normal", usedTokens: 1234,
  projectName: "Orquestador-IA", projectPath: "C:/estudio/orquestador-ia",
  steps: [{ key: "s1", description: "leer", adapter: "agy", status: "succeeded" }],
  answer: "Listo.", memory: { decisiones: ["usar sqlite"], aprendizajes: ["probar antes"] },
  memoryNotes: [{ path: "a/Nota Uno.md", title: "Nota Uno" }], date: new Date("2026-10-06T12:00:00"), ...o,
});

describe("buildPlanNote", () => {
  it("nombre, frontmatter y secciones", () => {
    const { fileName, content } = buildPlanNote(base());
    expect(fileName).toBe("2026-10-06-arregla-el-login-de-la-app.md");
    expect(content).toContain("ruta: C:/estudio/orquestador-ia");
    expect(content.startsWith(["---", "tipo: plan-orquestador", "estado: terminado", ""].join("\n"))).toBe(true);
    expect(content).toContain("actualizado: 2026-10-06");
    expect(content).toContain("tags: [orquestador, plan, normal]");
    expect(content).toContain("tokens: 1234");
    for (const h of ["## Pedido", "## Pasos", "## Resultado", "## Decisiones", "## Aprendizajes", "## Memoria usada", "## Relacionado"]) expect(content).toContain(h);
    expect(content).toContain("| s1 | leer | agy | succeeded |");
    expect(content).toContain("- usar sqlite");
    expect(content).toContain("- [[Nota Uno]]");
    expect(content).toContain("[[Orquestador-IA]]");
  });
  it("valores desconocidos son PENDIENTE", () => {
    const { content } = buildPlanNote(base({ projectPath: null, projectName: null, tier: null, memory: null, memoryNotes: [] }));
    expect(content).toContain("ruta: PENDIENTE");
    expect(content).toContain("tags: [orquestador, plan]");
    expect(content).toContain("tier: PENDIENTE");
  });
  it("redacta secretos en todo el contenido", () => {
    const { content } = buildPlanNote(base({ answer: "la llave sk-abcdefghijklmnopqrstuvwx", description: "token: abc123secreto" }));
    expect(content).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(content).not.toContain("abc123secreto");
  });
});

describe("writePlanNote", () => {
  const vault = () => fs.mkdtempSync(path.join(os.tmpdir(), "pn-"));
  it("crea el directorio, no sobrescribe y devuelve ruta relativa", () => {
    const v = vault();
    const a = writePlanNote(v, "Orquestador/Planes", base());
    const b = writePlanNote(v, "Orquestador/Planes", base());
    expect(a).toBe("Orquestador/Planes/2026-10-06-arregla-el-login-de-la-app.md");
    expect(b).toBe("Orquestador/Planes/2026-10-06-arregla-el-login-de-la-app-2.md");
    expect(fs.existsSync(path.join(v, a))).toBe(true);
    expect(fs.existsSync(path.join(v, b))).toBe(true);
  });
  it("rechaza writeDir fuera de la bóveda", () => {
    expect(() => writePlanNote(vault(), "../fuera", base())).toThrow();
  });
});

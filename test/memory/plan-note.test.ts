import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPlanNote, writePlanNote, type PlanNoteInput } from "../../src/memory/plan-note.js";
import { parseFrontmatter } from "../../src/memory/markdown.js";

const base = (o: Partial<PlanNoteInput> = {}): PlanNoteInput => ({
  planId: "p1", description: "Arregla el login de la app", tier: "normal", usedTokens: 1234,
  projectName: "Orquestador-IA", projectPath: "C:/estudio/orquestador-ia", projectNotePath: "20-Personal/Orquestador-IA.md",
  steps: [{ key: "s1", description: "leer", adapter: "agy", status: "succeeded" }],
  answer: "Listo.", memory: { decisiones: ["usar sqlite"], aprendizajes: ["probar antes"] },
  memoryNotes: [{ path: "a/Nota Uno.md", title: "Nota Uno" }], date: new Date("2026-10-06T12:00:00"), ...o,
});

const BS = "\\";

describe("buildPlanNote", () => {
  it("nombre, frontmatter y secciones", () => {
    const { fileName, content } = buildPlanNote(base());
    expect(fileName).toBe("2026-10-06-arregla-el-login-de-la-app.md");
    expect(content).toContain("ruta: 'C:/estudio/orquestador-ia'");
    expect(content.startsWith(["---", "tipo: plan-orquestador", "estado: terminado", ""].join("\n"))).toBe(true);
    expect(content).toContain("actualizado: 2026-10-06");
    expect(content).toContain("tags: [orquestador, plan, normal]");
    expect(content).toContain("tokens: 1234");
    for (const h of ["## Pedido", "## Pasos", "## Resultado", "## Decisiones", "## Aprendizajes", "## Memoria usada", "## Relacionado"]) expect(content).toContain(h);
    expect(content).toContain("| s1 | leer | agy | succeeded |");
    expect(content).toContain("- usar sqlite");
    expect(content).toContain("- [[a/Nota Uno|Nota Uno]]");
    expect(content).toContain("- [[20-Personal/Orquestador-IA|Orquestador-IA]]");
  });
  it("ruta con comillas o saltos va en comillas simples YAML (duplicando ')", () => {
    const { content } = buildPlanNote(base({ projectPath: "C:\\estudio\\o'x\"y\nc: z" }));
    expect(content).toContain("ruta: 'C:\\estudio\\o''x\"y c: z'");
  });
  it("ida y vuelta: parseFrontmatter lee la ruta tal cual", () => {
    for (const p of ["C:\\estudio\\orquestador-ia", "C:\\a'b\\c", "D:/x y/z"]) {
      const { content } = buildPlanNote(base({ projectPath: p }));
      expect(parseFrontmatter(content).data.ruta).toBe(p);
    }
    expect(parseFrontmatter(buildPlanNote(base()).content).data.tipo).toBe("plan-orquestador");
  });
  it("baja encabezados (no los escapa) y neutraliza separadores en Pedido y Resultado", () => {
    const { content } = buildPlanNote(base({
      description: "hola\n## Falso\n---\nfin",
      answer: "ok\n# Titulo\n---\n### otro\n##### hondo\n#etiqueta",
    }));
    expect(content).not.toMatch(/^## Falso/m);
    expect(content).not.toMatch(/^# Titulo/m);
    expect(content).toMatch(/^##### Falso$/m);
    expect(content).toMatch(/^#### Titulo$/m);
    expect(content).toMatch(/^###### otro$/m);
    expect(content).toMatch(/^###### hondo$/m);
    expect(content).toMatch(/^#etiqueta$/m);
    expect(content).not.toContain(BS + "#");
    // solo los dos "---" del frontmatter
    expect(content.split("\n").filter((l) => l === "---")).toHaveLength(2);
  });
  it("cierra bloques de código abiertos y no toca su interior", () => {
    const { content } = buildPlanNote(base({ answer: "mira:\n```bash\n# comentario\necho hola" }));
    const res = content.slice(content.indexOf("## Resultado"), content.indexOf("## Decisiones"));
    expect(res).toContain("```bash\n# comentario\necho hola\n```");
    expect(res.match(/```/g)).toHaveLength(2);
    expect(content).toMatch(/^## Decisiones$/m);
  });
  it("escapa <% de Templater y el ! de los embeds ![[", () => {
    const { content } = buildPlanNote(base({ description: "usa <% tp.date.now() %> y ![[secreto]]", answer: "ver ![[otra nota]]" }));
    expect(content).not.toContain("<%");
    expect(content).toContain("<" + BS + "%");
    expect(content).toContain(BS + "![[secreto]]");
    expect(content).toContain(BS + "![[otra nota]]");
    expect(content.replaceAll(BS + "![[", "")).not.toContain("![[");
  });
  it("enlaces por ruta con alias; sanea ]], |, # y ^", () => {
    const { content } = buildPlanNote(base({
      memoryNotes: [{ path: "a/x#y^z.md", title: "A]]B|C" }],
      projectName: "P]]Q|R",
      projectNotePath: "Proy/p|q.md",
    }));
    expect(content).toContain("- [[a/x-y-z|A)B-C]]");
    expect(content).toContain("- [[Proy/p-q|P)Q-R]]");
  });
  it("sin nota del proyecto, enlace por nombre saneado", () => {
    const { content } = buildPlanNote(base({ projectNotePath: null, projectName: "P]]Q|R#1" }));
    expect(content).toContain("- [[P)Q-R-1]]");
  });
  it("valores desconocidos son PENDIENTE", () => {
    const { content } = buildPlanNote(base({ projectPath: null, projectName: null, projectNotePath: null, tier: null, memory: null, memoryNotes: [] }));
    expect(content).toContain("ruta: 'PENDIENTE'");
    expect(content).toContain("tags: [orquestador, plan]");
    expect(content).toContain(`tier: "PENDIENTE"`);
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

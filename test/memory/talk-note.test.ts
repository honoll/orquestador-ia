import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildTalkNote, writeTalkNote, type TalkNoteInput } from "../../src/memory/talk-note.js";
import { memoryConfig } from "../../src/memory/config.js";
import { parseFrontmatter } from "../../src/memory/markdown.js";

const base = (o: Partial<TalkNoteInput> = {}): TalkNoteInput => ({
  date: new Date("2026-10-06T14:05:00"),
  summary: "Hablamos del login de la app",
  turns: [{ user: "Hola", assistant: "Qué onda" }],
  plans: [{ id: "p1", description: "Arregla el login" }],
  projectName: "Orquestador-IA",
  projectNotePath: "20-Personal/Orquestador-IA.md",
  ...o,
});

describe("buildTalkNote", () => {
  it("nombre, frontmatter y secciones", () => {
    const { fileName, content } = buildTalkNote(base());
    expect(fileName).toBe("2026-10-06-1405-hablamos-del-login-de-la-app.md");
    const fm = parseFrontmatter(content).data;
    expect(fm.tipo).toBe("platica-orquestador");
    expect(fm.estado).toBe("terminada");
    expect(fm.actualizado).toBe("2026-10-06");
    expect(content).toContain("tags: [orquestador, platica]");
    for (const h of ["## Resumen", "## Conversación", "## Planes lanzados", "## Relacionado"]) expect(content).toContain(h);
    expect(content).toContain("**Tú:** Hola");
    expect(content).toContain("**Asistente:** Qué onda");
    expect(content).toContain("Arregla el login");
    expect(content).toContain("[[20-Personal/Orquestador-IA|Orquestador-IA]]");
  });

  it("sin resumen usa 'platica' y sin proyecto no hay enlace", () => {
    const { fileName, content } = buildTalkNote(base({ summary: "", projectName: null, plans: [] }));
    expect(fileName).toBe("2026-10-06-1405-platica.md");
    expect(content).not.toContain("[[");
  });

  it("redacta secretos", () => {
    const { content } = buildTalkNote(base({ turns: [{ user: "password: hunter2", assistant: "ok" }] }));
    expect(content).not.toContain("hunter2");
  });

  it("degrada encabezados, neutraliza y recorta a 1000 chars", () => {
    const { content } = buildTalkNote(base({ turns: [{ user: "# Titulo\n![[x]] <% y %>", assistant: "a".repeat(5000) }] }));
    expect(content).not.toMatch(/^# Titulo/m);
    expect(content).toContain("#### Titulo");
    expect(content).toContain("\\![[x]]");
    expect(content).toContain("<\\%");
    expect(content).not.toContain("a".repeat(1001));
  });
});

describe("writeTalkNote", () => {
  const vault = () => memoryConfig().vaultPath;

  it("escribe en la bóveda temporal y agrega -2 en colisión", () => {
    expect(vault()).not.toContain("Cerebro");
    const dir = "Orquestador/PlaticasTest";
    const a = writeTalkNote(vault(), dir, base());
    const b = writeTalkNote(vault(), dir, base());
    expect(a).toBe(`${dir}/2026-10-06-1405-hablamos-del-login-de-la-app.md`);
    expect(b).toBe(`${dir}/2026-10-06-1405-hablamos-del-login-de-la-app-2.md`);
    expect(fs.existsSync(path.join(vault(), a))).toBe(true);
  });

  it("talkDir fuera de la bóveda lanza", () => {
    expect(() => writeTalkNote(vault(), "../fuera", base())).toThrow("fuera de la bóveda");
  });
});

describe("config", () => {
  it("talkDir", () => { expect(memoryConfig().talkDir).toBe("Orquestador/Platicas"); });
});

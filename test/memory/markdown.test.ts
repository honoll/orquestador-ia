import { describe, it, expect } from "vitest";
import { parseFrontmatter, chunkNote, redactSecrets, slugify, CHUNK_MAX_CHARS } from "../../src/memory/markdown.js";

describe("frontmatter", () => {
  it("lee claves simples y listas [a, b]; separa el cuerpo", () => {
    const { data, body } = parseFrontmatter("---\ntipo: proyecto\nruta: C:\\estudio\\x\ntags: [personal, ia]\n---\n# Título\nTexto");
    expect(data).toEqual({ tipo: "proyecto", ruta: "C:\\estudio\\x", tags: ["personal", "ia"] });
    expect(body).toBe("# Título\nTexto");
  });
  it("sin frontmatter devuelve {} y el texto completo", () => {
    expect(parseFrontmatter("# Hola")).toEqual({ data: {}, body: "# Hola" });
  });
  it("quita comillas de los valores", () => {
    expect(parseFrontmatter('---\nsiguiente: "F3b"\n---\nx').data.siguiente).toBe("F3b");
  });
});

describe("chunkNote", () => {
  it("corta por encabezados y conserva la ruta de encabezados", () => {
    const c = chunkNote("Nota", "Intro\n## Estado\nVa bien\n### Detalle\nMás\n## Siguiente\nF3b");
    expect(c.map((x) => x.heading)).toEqual(["Nota", "Nota > Estado", "Nota > Estado > Detalle", "Nota > Siguiente"]);
    expect(c[1].text).toContain("Va bien");
    expect(c.map((x) => x.index)).toEqual([0, 1, 2, 3]);
  });
  it("parte secciones largas sin pasar el máximo", () => {
    const c = chunkNote("N", "## A\n" + "palabra ".repeat(1000));
    expect(c.length).toBeGreaterThan(1);
    expect(c.every((x) => x.text.length <= CHUNK_MAX_CHARS)).toBe(true);
  });
  it("omite secciones vacías", () => {
    expect(chunkNote("N", "## A\n\n## B\ntexto").map((x) => x.heading)).toEqual(["N > B"]);
  });
});

describe("redactSecrets", () => {
  it("tapa llaves y tokens con formas conocidas", () => {
    const t = redactSecrets("sk-ant-api03-abcdefghijklmnopqrstuv ghp_abcdefghijklmnopqrstuvwxyz0123 AKIAABCDEFGHIJKLMNOP password=hunter2 TYPESAFE_API_KEY=xyz123abc");
    expect(t).not.toMatch(/sk-ant-api03-abc|ghp_abc|AKIAABCD|hunter2|xyz123abc/);
    expect(t).toContain("[REDACTADO]");
  });
  it("no toca texto normal", () => {
    expect(redactSecrets("El plan usó 216k tokens en codex")).toBe("El plan usó 216k tokens en codex");
  });
});

describe("slugify", () => {
  it("minúsculas, sin acentos, guiones, recortado", () => {
    expect(slugify("Migrar la tabla de pedidos de producción!", 30)).toBe("migrar-la-tabla-de-pedidos-de");
  });
});

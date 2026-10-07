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
  it("bloques PEM de llave privada completos", () => {
    const pem = "antes\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\nQUJDREVGRw==\n-----END OPENSSH PRIVATE KEY-----\ndespués";
    const t = redactSecrets(pem);
    expect(t).not.toMatch(/b3BlbnNzaC1rZXktdjEAAAA|QUJDREVGRw|BEGIN/);
    expect(t).toBe("antes\n[REDACTADO]\ndespués");
    expect(redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----")).toBe("[REDACTADO]");
  });
  it("credenciales en URLs conservan el usuario", () => {
    expect(redactSecrets("git clone https://alex:s3cr3t0@github.com/x/y.git"))
      .toBe("git clone https://alex:[REDACTADO]@github.com/x/y.git");
    expect(redactSecrets("postgres://admin:P%40ss@db:5432/app")).toBe("postgres://admin:[REDACTADO]@db:5432/app");
    expect(redactSecrets("ver https://ejemplo.com:8080/ruta")).toBe("ver https://ejemplo.com:8080/ruta");
  });
  it("Authorization: Bearer y Bearer <token>", () => {
    expect(redactSecrets("Authorization: Bearer abcDEF123456.xyz")).toBe("Authorization: Bearer [REDACTADO]");
    expect(redactSecrets("usa el Bearer tok_9f8e7d6c5b4a como cabecera")).toBe("usa el Bearer [REDACTADO] como cabecera");
  });
  it("pass, pwd y passwd con : o =", () => {
    for (const k of ["pass", "pwd", "passwd", "PASS", "Pwd"]) {
      expect(redactSecrets(`${k}: hunter2`)).toBe(`${k}=[REDACTADO]`);
      expect(redactSecrets(`${k}=hunter2`)).toBe(`${k}=[REDACTADO]`);
    }
    expect(redactSecrets("bypass: activo")).toBe("bypass: activo");
  });
  it("frases en español: \"contraseña es X\" y \"la contraseña: X\"", () => {
    expect(redactSecrets("la contraseña es Gato123 y ya")).toBe("la contraseña es [REDACTADO] y ya");
    expect(redactSecrets("La contrasena es Gato123")).toBe("La contrasena es [REDACTADO]");
    expect(redactSecrets("la contraseña: Gato123")).toBe("la contraseña=[REDACTADO]");
    expect(redactSecrets("la contraseña: Gato123")).not.toContain("Gato123");
  });
  it("variables de entorno en mayúsculas sí, palabras en minúsculas que terminan en key no", () => {
    expect(redactSecrets("OPENAI_API_KEY=abc123 GITHUB_TOKEN: ghx DB_PASSWORD=x CLIENT_SECRET=y"))
      .toBe("OPENAI_API_KEY=[REDACTADO] GITHUB_TOKEN=[REDACTADO] DB_PASSWORD=[REDACTADO] CLIENT_SECRET=[REDACTADO]");
    expect(redactSecrets("monkey: banana")).toBe("monkey: banana");
    expect(redactSecrets("turkey=pavo, Hotkey: F5")).toBe("turkey=pavo, Hotkey: F5");
  });
});

describe("slugify", () => {
  it("minúsculas, sin acentos, guiones, recortado", () => {
    expect(slugify("Migrar la tabla de pedidos de producción!", 30)).toBe("migrar-la-tabla-de-pedidos-de");
  });
});

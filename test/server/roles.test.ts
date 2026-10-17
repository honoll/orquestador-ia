import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRole, loadRoles, getRole, ROLE_SECTIONS } from "../../src/server/roles.js";

const ROLES_DIR = path.resolve(import.meta.dirname, "../../roles");

const body = (sections = ROLE_SECTIONS) => sections.map((s) => `## ${s}\nTexto de ${s}.\n`).join("\n");
const roleMd = (fm: string, b = body()) => `---\n${fm}\n---\n${b}`;
const FM = "id: prueba\nnombre: PRUEBA\nmodelo: m-1\nescribe: false\nherramientasPermitidas: [view_file, list_dir]";

describe("parseRole", () => {
  it("lee un rol válido", () => {
    const r = parseRole(roleMd(`${FM}\nmodeloDificil: m-2\npresupuestoTokens: 5000`), "prueba");
    expect(r).toMatchObject({
      id: "prueba", nombre: "PRUEBA", modelo: "m-1", modeloDificil: "m-2", escribe: false,
      herramientas: ["view_file", "list_dir"], presupuestoTokens: 5000,
    });
    expect(r.body.startsWith("## Identidad")).toBe(true);
    expect(r.body).not.toContain("---");
  });

  it("adaptadores: por defecto [agy]; lista válida con modeloCodex; adaptador desconocido → error", () => {
    expect(parseRole(roleMd(FM), "prueba").adaptadores).toEqual(["agy"]);
    const r = parseRole(roleMd(`${FM}\nadaptadores: [agy, codex]\nmodeloCodex: gpt-5.6-sol`), "prueba");
    expect(r).toMatchObject({ adaptadores: ["agy", "codex"], modeloCodex: "gpt-5.6-sol" });
    expect(() => parseRole(roleMd(`${FM}\nadaptadores: [agy, gemini]`), "prueba")).toThrow(/adaptadores/);
    expect(() => parseRole(roleMd(`${FM}\nadaptadores: agy`), "prueba")).toThrow(/adaptadores/);
  });

  it("escribe acepta true y salidas", () => {
    expect(parseRole(roleMd(FM.replace("escribe: false", "escribe: true")), "prueba").escribe).toBe(true);
    expect(parseRole(roleMd(FM.replace("escribe: false", "escribe: salidas")), "prueba").escribe).toBe("salidas");
  });

  it("falta una sección → error que la nombra", () => {
    const md = roleMd(FM, body(ROLE_SECTIONS.filter((s) => s !== "Cómo entregas")));
    expect(() => parseRole(md, "prueba")).toThrow(/Cómo entregas/);
  });

  it("sección fuera de orden → error que la nombra", () => {
    const s = [...ROLE_SECTIONS];
    [s[1], s[2]] = [s[2], s[1]];
    expect(() => parseRole(roleMd(FM, body(s)), "prueba")).toThrow(/Qué haces/);
  });

  it("frontmatter inválido → error", () => {
    expect(() => parseRole(body(), "prueba")).toThrow(/frontmatter/);
    expect(() => parseRole(roleMd(FM.replace("modelo: m-1\n", "")), "prueba")).toThrow(/modelo/);
    expect(() => parseRole(roleMd(FM.replace("escribe: false", "escribe: quizá")), "prueba")).toThrow(/escribe/);
    expect(() => parseRole(roleMd(FM.replace("[view_file, list_dir]", "view_file")), "prueba")).toThrow(/herramientasPermitidas/);
    expect(() => parseRole(roleMd(`${FM}\npresupuestoTokens: mucho`), "prueba")).toThrow(/presupuestoTokens/);
  });

  it("id distinto al nombre del archivo → error", () => {
    expect(() => parseRole(roleMd(FM), "otro")).toThrow(/otro/);
  });
});

describe("roles incluidos", () => {
  const esperado = {
    dev: { modelo: "claude-sonnet-4-6", modeloDificil: "claude-opus-4-6-thinking", escribe: true },
    qa: { modelo: "claude-sonnet-4-6", escribe: true },
    imagen: { modelo: "gemini-3.8-flash-high", escribe: "salidas" },
    investigador: { modelo: "gemini-3.8-flash-medium", escribe: false },
    lector: { modelo: "gemini-3.8-flash-low", escribe: false },
    redactor: { modelo: "gemini-3.8-flash-medium", escribe: true },
  };

  it("los 6 roles se leen con modelos y escritura exactos", () => {
    const roles = loadRoles();
    expect(roles.map((r) => r.id).sort()).toEqual(Object.keys(esperado).sort());
    for (const r of roles) {
      expect(r).toMatchObject(esperado[r.id as keyof typeof esperado]);
      for (const s of ["<<<ESTADO terminado>>>", "<<<ESTADO bloqueado {\"detalle\":", "<<<ESTADO necesita {\"detalle\":"]) expect(r.body).toContain(s);
      expect(r.body).not.toContain("\"detalle\":\"…\"");
    }
  });

  it("_originales son copias idénticas", () => {
    for (const id of Object.keys(esperado)) {
      const a = fs.readFileSync(path.join(ROLES_DIR, `${id}.md`), "utf8");
      const b = fs.readFileSync(path.join(ROLES_DIR, "_originales", `${id}.md`), "utf8");
      expect(b).toBe(a);
    }
  });

  it("roles reales: REDACTOR en Flash y originales idénticos a los editables", () => {
    const dir = path.join(process.cwd(), "roles");
    expect(getRole("redactor", dir)!.modelo).toBe("gemini-3.8-flash-medium");
    for (const id of ["lector", "investigador", "redactor", "dev", "qa", "imagen"]) {
      expect(fs.readFileSync(path.join(dir, `${id}.md`), "utf8")).toBe(fs.readFileSync(path.join(dir, "_originales", `${id}.md`), "utf8"));
      expect(fs.readFileSync(path.join(dir, `${id}.md`), "utf8")).toMatch(/LEE SOLO/);
    }
  });
});

describe("loadRoles / getRole", () => {
  it("omite inválidos y README; getRole ve cambios sin reiniciar", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roles-"));
    fs.writeFileSync(path.join(dir, "prueba.md"), roleMd(FM));
    fs.writeFileSync(path.join(dir, "malo.md"), "sin frontmatter");
    fs.writeFileSync(path.join(dir, "README.md"), "# léeme");
    fs.mkdirSync(path.join(dir, "_originales"));
    expect(loadRoles(dir).map((r) => r.id)).toEqual(["prueba"]);

    expect(getRole("prueba", dir)?.nombre).toBe("PRUEBA");
    expect(getRole("malo", dir)).toBeNull();
    expect(getRole("../x", dir)).toBeNull();
    expect(getRole("nada", dir)).toBeNull();

    const f = path.join(dir, "prueba.md");
    fs.writeFileSync(f, roleMd(FM.replace("PRUEBA", "CAMBIADO")));
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(f, t, t);
    expect(getRole("prueba", dir)?.nombre).toBe("CAMBIADO");
    expect(getRole("dev")?.modelo).toBe("claude-sonnet-4-6");
  });
});

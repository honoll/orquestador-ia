import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRolesRoute } from "../../src/server/routes/roles.js";
import { ROLES_DIR } from "../../src/server/roles.js";

let dir: string;
let route: ReturnType<typeof createRolesRoute>;
const devMd = fs.readFileSync(path.join(ROLES_DIR, "dev.md"), "utf8");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "roles-"));
  fs.mkdirSync(path.join(dir, "_originales"));
  for (const id of ["dev", "qa"]) {
    fs.copyFileSync(path.join(ROLES_DIR, `${id}.md`), path.join(dir, `${id}.md`));
    fs.copyFileSync(path.join(ROLES_DIR, `${id}.md`), path.join(dir, "_originales", `${id}.md`));
  }
  fs.writeFileSync(path.join(dir, "roto.md"), "sin frontmatter");
  fs.writeFileSync(path.join(dir, "README.md"), "# léeme");
  route = createRolesRoute(dir);
});

const send = (p: string, method: string, body?: unknown, type = "application/json") =>
  route.request(p, { method, headers: { "Content-Type": type }, body: body === undefined ? undefined : JSON.stringify(body) });
const asId = (md: string, id: string) => md.replace(/^id: .*$/m, `id: ${id}`);

describe("/api/roles", () => {
  it("GET / lista válidos e inválidos (con error), sin rutas del disco ni README", async () => {
    const res = await route.request("/");
    expect(res.status).toBe(200);
    const list = await res.json() as { id: string; nombre?: string; error?: string; original: boolean }[];
    expect(list.map((r) => r.id)).toEqual(["dev", "qa", "roto"]);
    expect(list[0]).toMatchObject({ id: "dev", nombre: "DEV", modelo: "claude-sonnet-4-6", escribe: true, original: true });
    expect(list[2].error).toMatch(/frontmatter/);
    expect(JSON.stringify(list)).not.toContain(dir.replace(/\\/g, "\\\\"));
  });

  it("GET /:id devuelve el markdown; id inválido o traversal → 404", async () => {
    const res = await route.request("/dev");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(devMd);
    for (const bad of ["..%2F..%2Fpackage", "_originales", "DEV", "nada", "..%5Cdev", "a"]) {
      expect((await route.request(`/${bad}`)).status).toBe(404);
    }
  });

  it("PUT valida con parseRole, exige JSON y escribe de forma atómica", async () => {
    const edited = devMd.replace("nombre: DEV", "nombre: DEV2");
    expect((await send("/dev", "PUT", { markdown: edited }, "text/plain")).status).toBe(415);
    const bad = await send("/dev", "PUT", { markdown: devMd.replace("## Estado final", "## Otra") });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/Estado final/);
    expect((await send("/dev", "PUT", { markdown: asId(devMd, "qa") })).status).toBe(400); // id ≠ archivo
    expect((await send("/dev", "PUT", { markdown: 5 })).status).toBe(400);
    expect(fs.readFileSync(path.join(dir, "dev.md"), "utf8")).toBe(devMd);
    const ok = await send("/dev", "PUT", { markdown: edited });
    expect(ok.status).toBe(200);
    expect(fs.readFileSync(path.join(dir, "dev.md"), "utf8")).toBe(edited);
    expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("PUT no crea archivos nuevos ni sale de roles/; cuerpo > 64 KB → 413", async () => {
    expect((await send("/nuevo", "PUT", { markdown: asId(devMd, "nuevo") })).status).toBe(404);
    expect((await send("/..%2Fx", "PUT", { markdown: devMd })).status).toBe(404);
    expect((await send("/_originales", "PUT", { markdown: devMd })).status).toBe(404);
    expect(fs.existsSync(path.join(dir, "nuevo.md"))).toBe(false);
    expect((await send("/dev", "PUT", { markdown: "x".repeat(70_000) })).status).toBe(413);
  });

  it("POST / crea un rol nuevo con id válido y que no exista", async () => {
    const res = await send("/", "POST", { markdown: asId(devMd, "disenador") });
    expect(res.status).toBe(201);
    expect(fs.readFileSync(path.join(dir, "disenador.md"), "utf8")).toBe(asId(devMd, "disenador"));
    expect((await send("/", "POST", { markdown: devMd })).status).toBe(409);
    for (const id of ["_originales", "a", "Mayus", "x".repeat(33), "../fuera"]) {
      expect((await send("/", "POST", { markdown: asId(devMd, id) })).status).toBe(400);
    }
    expect((await send("/", "POST", { markdown: asId(devMd, "otro").replace("## Identidad", "## Nada") })).status).toBe(400);
    expect(fs.existsSync(path.join(dir, "otro.md"))).toBe(false);
  });

  it("POST /:id/restore copia el original; sin original → 404", async () => {
    fs.writeFileSync(path.join(dir, "dev.md"), "cambiado");
    expect((await send("/dev/restore", "POST", {}, "text/plain")).status).toBe(415);
    const res = await send("/dev/restore", "POST", {});
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(dir, "dev.md"), "utf8")).toBe(devMd);
    expect((await send("/roto/restore", "POST", {})).status).toBe(404);
    expect((await send("/..%2Fdev/restore", "POST", {})).status).toBe(404);
  });
});

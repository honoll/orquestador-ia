import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { parseRole, ROLES_DIR } from "../roles.js";
import { parseFrontmatter } from "../../memory/markdown.js";

// Solo ids de rol: nunca "_originales", README, "..", separadores ni mayúsculas.
const ROLE_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;
const limitBody = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Cuerpo demasiado grande (máx. 64 KB)" }, 413) });
const isJson = (c: Context) => (c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json");
const NOT_JSON = { error: "El cuerpo debe ser JSON (Content-Type application/json)" };
const NOT_FOUND = { error: "Rol no encontrado" };

/** Escribe con tmp + rename para que un lector (getRole) nunca vea un archivo a medias. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  try { fs.renameSync(tmp, file); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
}

/** Crea sin pisar: link falla con EEXIST si otro POST ganó la carrera. Devuelve false en ese caso. */
function createAtomic(file: string, text: string): boolean {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  try { fs.linkSync(tmp, file); return true; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST") return false; throw err; }
  finally { fs.rmSync(tmp, { force: true }); }
}

async function readMarkdown(c: Context): Promise<string | null> {
  const b = await c.req.json().catch(() => null) as { markdown?: unknown } | null;
  return b && typeof b.markdown === "string" ? b.markdown : null;
}

export function createRolesRoute(dir: string = ROLES_DIR) {
  const app = new Hono();
  const file = (id: string) => path.join(dir, `${id}.md`);
  const exists = (id: string) => ROLE_ID.test(id) && fs.existsSync(file(id));
  const fail = (err: unknown) => ({ error: (err as Error).message });

  app.get("/", (c) => {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return c.json([]); }
    const ids = names.filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3)).filter((id) => ROLE_ID.test(id)).sort();
    return c.json(ids.map((id) => {
      const original = fs.existsSync(path.join(dir, "_originales", `${id}.md`));
      try {
        const r = parseRole(fs.readFileSync(file(id), "utf8"), id);
        return { id, nombre: r.nombre, modelo: r.modelo, escribe: r.escribe, original };
      } catch (err) {
        return { id, ...fail(err), original };
      }
    }));
  });

  app.get("/:id", (c) => {
    const id = c.req.param("id");
    if (!exists(id)) return c.json(NOT_FOUND, 404);
    return c.body(fs.readFileSync(file(id), "utf8"), 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });

  app.put("/:id", limitBody, async (c) => {
    const id = c.req.param("id");
    if (!isJson(c)) return c.json(NOT_JSON, 415);
    if (!exists(id)) return c.json(NOT_FOUND, 404); // PUT solo edita; crear es POST /
    const md = await readMarkdown(c);
    if (md === null) return c.json({ error: "Falta \"markdown\" (texto)" }, 400);
    try { parseRole(md, id); } catch (err) { return c.json(fail(err), 400); }
    writeAtomic(file(id), md);
    return c.json({ ok: true });
  });

  app.post("/", limitBody, async (c) => {
    if (!isJson(c)) return c.json(NOT_JSON, 415);
    const md = await readMarkdown(c);
    if (md === null) return c.json({ error: "Falta \"markdown\" (texto)" }, 400);
    const id = parseFrontmatter(md).data.id;
    if (typeof id !== "string" || !ROLE_ID.test(id)) {
      return c.json({ error: "El id del frontmatter debe tener 2–32 caracteres: minúsculas, números y guiones" }, 400);
    }
    if (fs.existsSync(file(id))) return c.json({ error: `Ya existe el rol "${id}"` }, 409);
    try { parseRole(md, id); } catch (err) { return c.json(fail(err), 400); }
    if (!createAtomic(file(id), md)) return c.json({ error: `Ya existe el rol "${id}"` }, 409);
    return c.json({ ok: true, id }, 201);
  });

  app.post("/:id/restore", limitBody, (c) => {
    const id = c.req.param("id");
    if (!isJson(c)) return c.json(NOT_JSON, 415);
    const original = path.join(dir, "_originales", `${id}.md`);
    if (!ROLE_ID.test(id) || !fs.existsSync(original)) return c.json({ error: "Ese rol no tiene original" }, 404);
    writeAtomic(file(id), fs.readFileSync(original, "utf8"));
    return c.json({ ok: true });
  });

  return app;
}

export default createRolesRoute();

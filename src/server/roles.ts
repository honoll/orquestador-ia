import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { parseFrontmatter } from "../memory/markdown.js";

const log = pino({ name: "roles" });

export const ROLES_DIR = path.resolve(import.meta.dirname, "../../roles");
export const ROLE_SECTIONS = ["Identidad", "Qué haces", "Qué no haces", "Cómo entregas", "Terminado cuando", "Estado final"];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Adaptadores que un rol puede usar (el primero es el de siempre; `modelo` es para agy). */
export const ROLE_ADAPTERS = ["agy", "codex"] as const;
export type RoleAdapter = (typeof ROLE_ADAPTERS)[number];

export interface RoleDef {
  id: string; nombre: string; modelo: string; modeloDificil?: string; escribe: boolean | "salidas";
  herramientas: string[]; presupuestoTokens?: number; body: string /* markdown sin frontmatter */
  adaptadores: RoleAdapter[]; modeloCodex?: string;
}

/** Valida frontmatter + las 6 secciones en orden; lanza un Error que nombra lo que falla. */
export function parseRole(markdown: string, fileId: string): RoleDef {
  const { data, body } = parseFrontmatter(markdown);
  if (!Object.keys(data).length) throw new Error(`rol "${fileId}": falta el frontmatter (--- … ---)`);
  const str = (k: string, required = true): string | undefined => {
    const v = data[k];
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string" || !v) throw new Error(`rol "${fileId}": frontmatter "${k}" falta o no es texto`);
    return v;
  };
  const id = str("id")!;
  if (id !== fileId) throw new Error(`rol "${fileId}": el id "${id}" no coincide con el archivo ${fileId}.md`);
  const esc = str("escribe")!;
  if (!["true", "false", "salidas"].includes(esc)) throw new Error(`rol "${fileId}": "escribe" debe ser true, false o salidas`);
  const herramientas = data.herramientasPermitidas;
  if (!Array.isArray(herramientas)) throw new Error(`rol "${fileId}": "herramientasPermitidas" debe ser una lista [a, b]`);
  const ad = data.adaptadores ?? ["agy"];
  if (!Array.isArray(ad) || !ad.length || !ad.every((a) => (ROLE_ADAPTERS as readonly string[]).includes(a))) {
    throw new Error(`rol "${fileId}": "adaptadores" debe ser una lista con ${ROLE_ADAPTERS.join(" y/o ")} (p. ej. [agy, codex])`);
  }
  const pres = str("presupuestoTokens", false);
  if (pres !== undefined && !/^[1-9]\d*$/.test(pres)) throw new Error(`rol "${fileId}": "presupuestoTokens" debe ser un entero positivo`);

  const found = [...body.matchAll(/^## +(.+?)\s*$/gm)].map((m) => m[1]).filter((h) => ROLE_SECTIONS.includes(h));
  ROLE_SECTIONS.forEach((s, i) => {
    if (found[i] === s) return;
    throw new Error(found.includes(s)
      ? `rol "${fileId}": la sección "## ${s}" está fuera de orden (orden: ${ROLE_SECTIONS.join(", ")})`
      : `rol "${fileId}": falta la sección "## ${s}"`);
  });

  return {
    id, nombre: str("nombre")!, modelo: str("modelo")!, modeloDificil: str("modeloDificil", false),
    escribe: esc === "salidas" ? "salidas" : esc === "true", herramientas,
    presupuestoTokens: pres === undefined ? undefined : Number(pres), body: body.trimStart(),
    adaptadores: ad as RoleAdapter[], modeloCodex: str("modeloCodex", false),
  };
}

const cache = new Map<string, { mtimeMs: number; role: RoleDef | null }>();

/** Lee un rol del disco con caché por mtime (las ediciones se ven sin reiniciar). */
function readRole(dir: string, id: string): RoleDef | null {
  if (!ID_RE.test(id)) return null;
  const file = path.join(dir, `${id}.md`);
  let mtimeMs: number;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.role;
  let role: RoleDef | null = null;
  try { role = parseRole(fs.readFileSync(file, "utf8"), id); } catch (err) {
    log.warn({ file, err: (err as Error).message }, "rol inválido, se omite");
  }
  cache.set(file, { mtimeMs, role });
  return role;
}

/** Todos los roles válidos de `dir` (ignora README, `_originales` y lo que no sea `<id>.md`). */
export function loadRoles(dir = ROLES_DIR): RoleDef[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3)).sort()
    .map((id) => readRole(dir, id)).filter((r): r is RoleDef => r !== null);
}

export function getRole(id: string, dir = ROLES_DIR): RoleDef | null {
  return readRole(dir, id);
}

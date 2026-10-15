import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]);
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".bmp": "image/bmp", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".json": "application/json", ".pdf": "application/pdf",
};
const ENTRY = ".orquestador/";

/** <proyecto>/.orquestador/salidas/<planId>/ (los ids de plan son UUID; cualquier otra cosa se rechaza). */
export function outputsDir(projectPath: string, planId: string): string {
  if (!/^[\w-]+$/.test(planId)) throw new Error("id de plan inválido");
  return path.join(projectPath, ".orquestador", "salidas", planId);
}

export function ensureOutputsDir(projectPath: string, planId: string): string {
  const dir = outputsDir(projectPath, planId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Añade `.orquestador/` al .gitignore del proyecto si falta (solo agrega; nunca toca otras líneas). true = lo agregó. */
export function ensureGitignore(projectPath: string): boolean {
  const file = path.join(projectPath, ".gitignore");
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { /* sin .gitignore: se crea */ }
  if (text.split(/\r?\n/).some((l) => /^\/?\.orquestador\/?$/.test(l.trim()))) return false;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const sep = text && !text.endsWith("\n") ? eol : "";
  fs.appendFileSync(file, `${sep}${text ? eol : ""}# Salidas y archivos de trabajo del orquestador${eol}${ENTRY}${eol}`);
  return true;
}

/** Foto de `git status --porcelain -z`: ruta -> huella del contenido (así se nota un archivo ya sucio que vuelve a cambiar). null si no es repo git. */
export function gitSnapshot(cwd: string): Promise<Map<string, string> | null> {
  return new Promise((resolve) => {
    execFile("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 20_000 }, (err, stdout) => {
      if (err) return resolve(null);
      execFile("git", ["rev-parse", "--show-toplevel"], { cwd, windowsHide: true }, (e2, top) => {
        const root = e2 ? cwd : top.trim();
        const toks = stdout.split("\0").filter(Boolean);
        const snap = new Map<string, string>();
        for (let i = 0; i < toks.length; i++) {
          const code = toks[i].slice(0, 2);
          const rel = toks[i].slice(3);
          if (code[0] === "R" || code[0] === "C") i++; // el siguiente token es la ruta original
          snap.set(rel, code + fingerprint(path.join(root, rel)));
        }
        resolve(snap);
      });
    });
  });
}

function fingerprint(file: string): string {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return "";
    if (st.size > 10 * 1024 * 1024) return `${st.size}:${st.mtimeMs}`; // shortcut: archivos grandes por tamaño+mtime, no por contenido
    return createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch { return ""; }
}

/** Rutas nuevas o con contenido distinto entre dos fotos, sin contar la carpeta .orquestador/. */
export function changedOutside(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after].filter(([p, h]) => before.get(p) !== h).map(([p]) => p).filter((p) => !p.replace(/[\\]/g, "/").startsWith(ENTRY));
}

export interface OutputFile { name: string; size: number; mtime: string; isImage: boolean }

export function listOutputs(projectPath: string, planId: string): OutputFile[] {
  const dir = outputsDir(projectPath, planId);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: OutputFile[] = [];
  for (const name of names) {
    const st = fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false });
    if (!st?.isFile()) continue; // sin carpetas ni enlaces
    out.push({ name, size: st.size, mtime: st.mtime.toISOString(), isImage: IMAGE_EXT.has(path.extname(name).toLowerCase()) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Ruta real del archivo si es hijo directo de la carpeta de salidas; null en cualquier otro caso. */
export function resolveOutput(projectPath: string, planId: string, name: string): { file: string; type: string } | null {
  if (!name || name !== path.basename(name) || /[\\/:\0]/.test(name) || name === "." || name === "..") return null;
  const dir = outputsDir(projectPath, planId);
  try {
    const file = path.join(dir, name);
    if (!fs.lstatSync(file).isFile()) return null; // un enlace simbólico no es isFile()
    const real = fs.realpathSync(file);
    const realDir = fs.realpathSync(dir);
    const inside = path.relative(fs.realpathSync(projectPath), realDir);
    if (inside.startsWith("..") || path.isAbsolute(inside)) return null; // la carpeta (p. ej. una junction) escapa del proyecto
    if (path.dirname(real).toLowerCase() !== realDir.toLowerCase()) return null;
    return { file: real, type: MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream" };
  } catch { return null; }
}

export const CHUNK_MAX_CHARS = 1500;

export interface Frontmatter { [k: string]: string | string[] }
export interface NoteChunk { heading: string; text: string; index: number }

const unquote = (v: string) => v.trim().replace(/^["'](.*)["']$/, "$1");

/** YAML mínimo de la bóveda: `clave: valor` y `clave: [a, b]`. */
export function parseFrontmatter(text: string): { data: Frontmatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Frontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const raw = kv[2].trim();
    data[kv[1]] = raw.startsWith("[") && raw.endsWith("]")
      ? raw.slice(1, -1).split(",").map(unquote).filter(Boolean)
      : unquote(raw);
  }
  return { data, body: text.slice(m[0].length) };
}

function splitLong(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n{2,}/)) {
    const pieces = para.length > max ? para.match(new RegExp(`[\\s\\S]{1,${max}}`, "g")) ?? [] : [para];
    for (const p of pieces) {
      if ((cur + "\n\n" + p).trim().length > max) {
        if (cur.trim()) out.push(cur.trim());
        cur = p;
      } else {
        cur = cur ? `${cur}\n\n${p}` : p;
      }
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Trozos por encabezado (# ## ###...), cada uno con la ruta de encabezados; secciones largas se parten. */
export function chunkNote(title: string, body: string, maxChars = CHUNK_MAX_CHARS): NoteChunk[] {
  const stack: { level: number; text: string }[] = [];
  const sections: { heading: string; lines: string[] }[] = [{ heading: title, lines: [] }];
  for (const line of body.split(/\r?\n/)) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      // El primer "# Título" igual al nombre de la nota no agrega nivel.
      if (!(level === 1 && h[2].trim() === title && stack.length === 0)) stack.push({ level, text: h[2].trim() });
      sections.push({ heading: [title, ...stack.map((s) => s.text)].join(" > "), lines: [] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }
  const chunks: NoteChunk[] = [];
  for (const s of sections) {
    const text = s.lines.join("\n").trim();
    if (!text) continue;
    for (const piece of splitLong(text, maxChars)) chunks.push({ heading: s.heading, text: piece, index: chunks.length });
  }
  return chunks;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b((?:password|passwd|contrase(?:ñ|n)a|secret|token|api[_-]?key|[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)))\s*[:=]\s*\S+/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, key?: string) => (key && /[:=]/.test(m) ? `${key}=[REDACTADO]` : "[REDACTADO]"));
  }
  return out;
}

export function slugify(s: string, max = 50): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
}

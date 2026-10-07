import fs from "node:fs";
import path from "node:path";
import { redactSecrets, slugify } from "./markdown.js";

export interface PlanNoteInput {
  planId: string;
  description: string;
  tier: string | null;
  usedTokens: number;
  projectName: string | null;
  projectPath: string | null;
  /** Ruta en la bóveda de la nota del proyecto (para enlazarla por ruta); si falta, se enlaza por nombre. */
  projectNotePath?: string | null;
  steps: { key: string; description: string; adapter: string; status: string }[];
  answer: string;
  memory: { decisiones: string[]; aprendizajes: string[] } | null;
  memoryNotes: { path: string; title: string }[];
  date: Date;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** Cadena YAML en comillas simples: las `\` de Windows quedan literales y `'` se duplica. */
const yamlSingle = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** Sin sintaxis activa de Obsidian: `<%` (Templater) ni embeds `![[…]]`. */
const inert = (s: string) => s.replace(/<%/g, "<\\%").replace(/(^|[^\\])!\[\[/g, "$1\\![[");
const cell = (s: string) => inert(oneLine(s)).replace(/\|/g, "\\|");
const FENCE = /^\s*(`{3,}|~{3,})/;
/**
 * Texto no confiable dentro de una sección: los encabezados bajan 3 niveles (`# x` → `#### x`, tope 6)
 * para quedar bajo la sección, los separadores `---` se vuelven `—`, y un bloque de código sin cerrar
 * se cierra. Dentro de los bloques de código no se toca nada salvo `<%`.
 */
const neutralize = (s: string) => {
  const out: string[] = [];
  let fence: string | null = null;
  for (const l of s.split(/\r?\n/)) {
    const f = FENCE.exec(l);
    if (fence) {
      out.push(l.replace(/<%/g, "<\\%"));
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) { fence = f[1]; out.push(inert(l)); continue; }
    const h = /^\s*(#{1,6})(\s.*|)$/.exec(l);
    if (h) out.push(`${"#".repeat(Math.min(6, h[1].length + 3))}${inert(h[2])}`);
    else out.push(/^\s*-{3,}\s*$/.test(l) ? "—" : inert(l));
  }
  if (fence) out.push(fence);
  return out.join("\n");
};
const wikiTarget = (s: string) =>
  oneLine(s).replace(/\]\]/g, ")").replace(/\[\[/g, "(").replace(/[|#^]/g, "-");
const wikiAlias = (s: string) => inert(oneLine(s).replace(/\]\]/g, ")").replace(/\[\[/g, "(").replace(/\|/g, "-"));
/** Enlace wiki seguro: por ruta (sin `.md`) con el título como alias; o por nombre si no hay ruta. */
const link = (title: string, notePath?: string | null) =>
  notePath ? `[[${wikiTarget(notePath.replace(/\.md$/i, ""))}|${wikiAlias(title)}]]` : `[[${wikiTarget(title)}]]`;
const list = (items: string[]) => (items.length ? items.map((i) => `- ${inert(oneLine(i))}`).join("\n") : "- (ninguno)");

export function buildPlanNote(input: PlanNoteInput): { fileName: string; content: string } {
  const date = ymd(input.date);
  const fileName = `${date}-${slugify(input.description) || "plan"}.md`;
  const tags = ["orquestador", "plan", ...(input.tier ? [slugify(input.tier) || "PENDIENTE"] : [])].join(", ");
  const rows = input.steps.map((s) => `| ${cell(s.key)} | ${cell(s.description)} | ${cell(s.adapter)} | ${cell(s.status)} |`);
  const used = input.memoryNotes.length ? input.memoryNotes.map((n) => `- ${link(n.title, n.path)}`).join("\n") : "- (ninguna)";
  const related = input.projectName ? `- ${link(input.projectName, input.projectNotePath)}` : "- PENDIENTE";
  const content = [
    "---",
    "tipo: plan-orquestador",
    "estado: terminado",
    `ruta: ${yamlSingle(input.projectPath ? oneLine(input.projectPath) : "PENDIENTE")}`,
    `actualizado: ${date}`,
    `tags: [${tags}]`,
    `tier: ${JSON.stringify(input.tier ?? "PENDIENTE")}`,
    `tokens: ${input.usedTokens}`,
    "---",
    "",
    `# Plan ${date}: ${inert(oneLine(input.description).slice(0, 80))}`,
    "",
    "## Pedido",
    neutralize(input.description.trim()),
    "",
    "## Pasos",
    "| Paso | Descripción | Adapter | Estado |",
    "|---|---|---|---|",
    ...rows,
    "",
    "## Resultado",
    neutralize(input.answer.trim()) || "PENDIENTE",
    "",
    "## Decisiones",
    list(input.memory?.decisiones ?? []),
    "",
    "## Aprendizajes",
    list(input.memory?.aprendizajes ?? []),
    "",
    "## Memoria usada",
    used,
    "",
    "## Relacionado",
    related,
    "",
  ].join("\n");
  return { fileName, content: redactSecrets(content) };
}

/** Escribe la nota como archivo nuevo dentro de <vault>/<writeDir>. Nunca sobrescribe (agrega -2, -3…). */
export function writePlanNote(vaultPath: string, writeDir: string, input: PlanNoteInput): string {
  const root = path.resolve(vaultPath);
  const dir = path.resolve(root, writeDir);
  const rel = path.relative(root, dir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("writeDir fuera de la bóveda");
  fs.mkdirSync(dir, { recursive: true });
  const { fileName, content } = buildPlanNote(input);
  const base = fileName.replace(/\.md$/, "");
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}.md` : `${base}-${n}.md`;
    try {
      fs.writeFileSync(path.join(dir, name), content, { encoding: "utf-8", flag: "wx" });
      return path.posix.join(rel.split(path.sep).join("/"), name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

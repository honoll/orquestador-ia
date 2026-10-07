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
  steps: { key: string; description: string; adapter: string; status: string }[];
  answer: string;
  memory: { decisiones: string[]; aprendizajes: string[] } | null;
  memoryNotes: { path: string; title: string }[];
  date: Date;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const cell = (s: string) => oneLine(s).replace(/\|/g, "\\|");
/** Texto no confiable dentro de una sección: sin encabezados ni separadores que rompan la estructura de la nota. */
const neutralize = (s: string) =>
  s.split(/\r?\n/).map((l) => (/^\s*-{3,}\s*$/.test(l) ? "—" : /^\s*#/.test(l) ? `\\${l.trimStart()}` : l)).join("\n");
/** Enlace wiki seguro: sin `]]`, `[[` ni `|` en el destino. */
const link = (s: string) => `[[${oneLine(s).replace(/\]\]/g, ")").replace(/\[\[/g, "(").replace(/\|/g, "-")}]]`;
const list = (items: string[]) => (items.length ? items.map((i) => `- ${oneLine(i)}`).join("\n") : "- (ninguno)");

export function buildPlanNote(input: PlanNoteInput): { fileName: string; content: string } {
  const date = ymd(input.date);
  const fileName = `${date}-${slugify(input.description) || "plan"}.md`;
  const tags = ["orquestador", "plan", ...(input.tier ? [slugify(input.tier) || "PENDIENTE"] : [])].join(", ");
  const rows = input.steps.map((s) => `| ${cell(s.key)} | ${cell(s.description)} | ${cell(s.adapter)} | ${cell(s.status)} |`);
  const used = input.memoryNotes.length ? input.memoryNotes.map((n) => `- ${link(n.title)}`).join("\n") : "- (ninguna)";
  const related = input.projectName ? `- ${link(input.projectName)}` : "- PENDIENTE";
  const content = [
    "---",
    "tipo: plan-orquestador",
    "estado: terminado",
    `ruta: ${JSON.stringify(input.projectPath ? oneLine(input.projectPath) : "PENDIENTE")}`,
    `actualizado: ${date}`,
    `tags: [${tags}]`,
    `tier: ${JSON.stringify(input.tier ?? "PENDIENTE")}`,
    `tokens: ${input.usedTokens}`,
    "---",
    "",
    `# Plan ${date}: ${oneLine(input.description).slice(0, 80)}`,
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

import { redactSecrets, slugify } from "./markdown.js";
import { inert, link, neutralize, oneLine, writeNewNote, ymd } from "./plan-note.js";

export type TalkNoteInput = {
  date: Date;
  summary: string;
  turns: { user: string; assistant: string }[];
  plans: { id: string; description: string }[];
  projectName: string | null;
  projectNotePath?: string | null;
};

const TURN_MAX_CHARS = 1000;
const pad = (n: number) => String(n).padStart(2, "0");
const turnText = (s: string) => neutralize(s.trim().slice(0, TURN_MAX_CHARS));

export function buildTalkNote(input: TalkNoteInput): { fileName: string; content: string } {
  const date = ymd(input.date);
  const hm = `${pad(input.date.getHours())}${pad(input.date.getMinutes())}`;
  const words = oneLine(input.summary).split(" ").slice(0, 8).join(" ");
  const fileName = `${date}-${hm}-${slugify(words) || "platica"}.md`;
  const conversation = input.turns.length
    ? input.turns.map((t) => `**Tú:** ${turnText(t.user)}\n\n**Asistente:** ${turnText(t.assistant)}`).join("\n\n")
    : "(sin turnos)";
  const plans = input.plans.length ? input.plans.map((p) => `- ${inert(oneLine(p.description))}`).join("\n") : "- (ninguno)";
  // PENDIENTE es solo para datos de negocio faltantes: aquí una sección vacía se marca "(ninguno)".
  const related = input.projectName ? `- ${link(input.projectName, input.projectNotePath)}` : "- (ninguno)";
  const phrases = input.turns.slice(0, 3).map((t) => oneLine(t.user).replace(/[.!?]+$/, "")).filter(Boolean);
  const summary = input.summary.trim() || (phrases.length ? phrases.join(". ") + "." : "(sin resumen)");
  const content = [
    "---",
    "tipo: platica-orquestador",
    "estado: terminada",
    `actualizado: ${date}`,
    "tags: [orquestador, platica]",
    "---",
    "",
    `# Plática ${date} ${hm.slice(0, 2)}:${hm.slice(2)}`,
    "",
    "## Resumen",
    neutralize(summary),
    "",
    "## Conversación",
    conversation,
    "",
    "## Planes lanzados",
    plans,
    "",
    "## Relacionado",
    related,
    "",
  ].join("\n");
  return { fileName, content: redactSecrets(content) };
}

/** Escribe la plática como archivo nuevo en <vault>/<talkDir>; nunca sobrescribe. Ruta relativa POSIX. */
export function writeTalkNote(vaultPath: string, talkDir: string, input: TalkNoteInput): string {
  const { fileName, content } = buildTalkNote(input);
  return writeNewNote(vaultPath, talkDir, fileName.replace(/\.md$/, ""), content);
}

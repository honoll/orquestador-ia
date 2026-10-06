import { jev as defaultJev, JEV_STATE_MAX_CHARS, type JevClient, type JevQuestion } from "../lib/jev.js";
import { CLIP_MARK, DEP_RESULT_MAX_CHARS, clip } from "./plan-dag.js";

export type GuardFlagId = "git" | "destructive" | "outside_project";
export interface GuardFlag { id: GuardFlagId; label: string; probability: number; source: "jev" | "local" }
export interface GuardResult { flagged: boolean; flags: GuardFlag[]; source: "jev" | "local" }

export const GUARD_THRESHOLD = 0.5;
const IDS: GuardFlagId[] = ["git", "destructive", "outside_project"];

export const GUARD_LABELS: Record<GuardFlagId, string> = {
  git: "pide commit, push o tocar el historial/remotos de git",
  destructive: "pide borrar o sobrescribir archivos o datos",
  outside_project: "pide trabajar fuera de la carpeta del proyecto o tocar configuración del sistema/usuario",
};

export const GUARD_QUESTIONS: Record<GuardFlagId, JevQuestion> = {
  git: { type: "noul", instructions: "¿Esta tarea pide hacer commit, push, reescribir el historial o cambiar remotos de git?" },
  destructive: { type: "noul", instructions: "¿Esta tarea pide borrar archivos, carpetas o datos, o sobrescribirlos en masa?" },
  outside_project: { type: "noul", instructions: "¿Esta tarea pide leer o escribir fuera de la carpeta del proyecto indicada, o tocar configuración del sistema o del usuario?" },
};

const GIT_RE = /\bgit\s+(push|commit|rebase|filter-branch|reset\s+--hard|remote\s+(add|set-url|remove|rm))\b|\bgh\s+(pr\s+merge|repo\s+delete)\b/i;
/** `git branch -D` (borrado forzado) distingue mayúsculas: `-d` solo borra ramas ya integradas. */
const GIT_BRANCH_FORCE_RE = /\bgit\s+branch\s+(?:\S+\s+)*?-[a-zA-Z]*D[a-zA-Z]*\b/;
const DESTRUCTIVE_RE = /\brm\s+(?:-[a-z]+\s+)*-[a-z]*r[a-z]*\b|\bgit\s+clean\s+-[a-z]*f[a-z]*\b|\bRemove-Item\b[^\n]*-Recurse|\b(rmdir|rd)\s+\/s\b|\bdel\s+\/[sfq]\b|\bformat\s+[a-z]:|\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i;
const SENSITIVE_RE = /(%USERPROFILE%|%APPDATA%|%LOCALAPPDATA%|\\AppData\\|[\\/]\.ssh\b|[\\/]\.claude[\\/]|[\\/]\.codex[\\/]|[\\/]\.gemini[\\/]|(^|\s)~[\\/]|(^|[\s"'(`=:])\/etc\/)/i;
const WIN_ABS_RE = /\b[A-Za-z]:[\\/][^\s"'`<>|]*/g;

const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

/**
 * Reglas conservadoras (no entienden negaciones). Sin JEV revisan prompt + dependencias; con JEV solo
 * las dependencias (texto de agentes, no confiable), porque el prompt puede decir "no hagas push".
 */
export function localGuard(text: string, projectPath: string): GuardFlag[] {
  const flags: GuardFlag[] = [];
  const add = (id: GuardFlagId) => flags.push({ id, label: GUARD_LABELS[id], probability: 1, source: "local" });
  if (GIT_RE.test(text) || GIT_BRANCH_FORCE_RE.test(text)) add("git");
  if (DESTRUCTIVE_RE.test(text)) add("destructive");
  const root = norm(projectPath);
  const outside = (text.match(WIN_ABS_RE) ?? []).some((p) => {
    const n = norm(p);
    return !(n === root || n.startsWith(`${root}\\`));
  });
  if (outside || SENSITIVE_RE.test(text)) add("outside_project");
  return flags;
}

type GuardInput = { prompt: string; deps: { key: string; result: string | null }[]; projectPath: string };

/** Lo que el trabajador recibe de una dependencia sin resultado (como buildStepPrompt). */
const depText = (result: string | null) => result ?? "(sin resultado)";

/**
 * State para JEV: el prompt va primero y completo; cada dependencia se recorta a DEP_RESULT_MAX_CHARS
 * (igual que buildStepPrompt) y, si el total pasa JEV_STATE_MAX_CHARS, se recortan solo las dependencias,
 * de forma pareja (las cortas conservan todo y lo que sobra se reparte entre las largas).
 */
export function buildGuardState(input: GuardInput): string {
  const head = `Tarea:\n${input.prompt}\n\nCarpeta del proyecto: ${input.projectPath}\n\nResultados previos que recibirá:\n`;
  if (input.deps.length === 0) return `${head}(ninguno)`;
  const texts = input.deps.map((d) => depText(d.result));
  const labels = input.deps.map((d) => `### ${d.key}\n`);
  const overhead = labels.reduce((n, l) => n + l.length + CLIP_MARK.length + 2, 0);
  let room = Math.max(0, JEV_STATE_MAX_CHARS - head.length - overhead);
  const caps = texts.map((t) => Math.min(t.length, DEP_RESULT_MAX_CHARS));
  const order = caps.map((_, i) => i).sort((a, b) => caps[a] - caps[b]);
  order.forEach((i, k) => {
    const take = Math.min(caps[i], Math.floor(room / (order.length - k)));
    caps[i] = take;
    room -= take;
  });
  return head + texts.map((t, i) => `${labels[i]}${clip(t, caps[i])}`).join("\n\n");
}

export async function guardStep(input: GuardInput, client: JevClient = defaultJev): Promise<GuardResult> {
  const answers = await client.ask(buildGuardState(input), GUARD_QUESTIONS);
  const complete = answers && IDS.every((id) => {
    const a = answers[id];
    return a && a.type === "noul" && Number.isFinite(a.noul);
  });
  // Los resultados de dependencias (lo mismo que verá el trabajador) siempre pasan por las reglas locales.
  const deps = input.deps.map((d) => clip(depText(d.result), DEP_RESULT_MAX_CHARS)).join("\n");
  if (!complete) {
    const flags = localGuard(`${input.prompt}\n${deps}`, input.projectPath);
    return { flagged: flags.length > 0, flags, source: "local" };
  }
  const jevFlags: GuardFlag[] = IDS
    .map((id) => ({ id, label: GUARD_LABELS[id], probability: (answers![id] as { noul: number }).noul, source: "jev" as const }))
    .filter((f) => f.probability >= GUARD_THRESHOLD);
  const depFlags = localGuard(deps, input.projectPath).filter((f) => !jevFlags.some((j) => j.id === f.id));
  const flags = [...jevFlags, ...depFlags];
  return { flagged: flags.length > 0, flags, source: "jev" };
}

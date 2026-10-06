import { jev as defaultJev, type JevClient, type JevQuestion } from "../lib/jev.js";
import { DEP_RESULT_MAX_CHARS } from "./plan-dag.js";

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
const DESTRUCTIVE_RE = /\brm\s+-[a-z]*(rf|fr)[a-z]*\b|\bRemove-Item\b[^\n]*-Recurse|\brmdir\s+\/s\b|\bdel\s+\/[sfq]\b|\bformat\s+[a-z]:|\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i;
const SENSITIVE_RE = /(%USERPROFILE%|%APPDATA%|%LOCALAPPDATA%|\\AppData\\|[\\/]\.ssh\b|[\\/]\.claude[\\/]|[\\/]\.codex[\\/]|[\\/]\.gemini[\\/]|(^|\s)~[\\/]|(^|[\s"'(])\/etc\/)/i;
const WIN_ABS_RE = /\b[A-Za-z]:[\\/][^\s"'`<>|]*/g;

const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

/** Reglas conservadoras de respaldo (no entienden negaciones: solo se usan sin JEV). */
export function localGuard(text: string, projectPath: string): GuardFlag[] {
  const flags: GuardFlag[] = [];
  const add = (id: GuardFlagId) => flags.push({ id, label: GUARD_LABELS[id], probability: 1, source: "local" });
  if (GIT_RE.test(text)) add("git");
  if (DESTRUCTIVE_RE.test(text)) add("destructive");
  const root = norm(projectPath);
  const outside = (text.match(WIN_ABS_RE) ?? []).some((p) => {
    const n = norm(p);
    return !(n === root || n.startsWith(`${root}\\`));
  });
  if (outside || SENSITIVE_RE.test(text)) add("outside_project");
  return flags;
}

export function buildGuardState(input: { prompt: string; deps: { key: string; result: string | null }[]; projectPath: string }): string {
  const deps = input.deps
    .map((d) => `### ${d.key}\n${(d.result ?? "").slice(0, DEP_RESULT_MAX_CHARS / 2)}`)
    .join("\n\n");
  return `Carpeta del proyecto: ${input.projectPath}\n\nTarea:\n${input.prompt}\n\nResultados previos que recibirá:\n${deps || "(ninguno)"}`;
}

export async function guardStep(
  input: { prompt: string; deps: { key: string; result: string | null }[]; projectPath: string },
  client: JevClient = defaultJev,
): Promise<GuardResult> {
  const answers = await client.ask(buildGuardState(input), GUARD_QUESTIONS);
  const complete = answers && IDS.every((id) => {
    const a = answers[id];
    return a && a.type === "noul" && Number.isFinite(a.noul);
  });
  if (!complete) {
    const text = `${input.prompt}\n${input.deps.map((d) => d.result ?? "").join("\n")}`;
    const flags = localGuard(text, input.projectPath);
    return { flagged: flags.length > 0, flags, source: "local" };
  }
  const flags: GuardFlag[] = IDS
    .map((id) => ({ id, label: GUARD_LABELS[id], probability: (answers![id] as { noul: number }).noul, source: "jev" as const }))
    .filter((f) => f.probability >= GUARD_THRESHOLD);
  return { flagged: flags.length > 0, flags, source: "jev" };
}

// Lógica pura de la vista Oficina (F8): selector de vista, qué eventos refrescan y etiquetas de estado.
import { ROLES, type AgentId } from "./office";

export interface OfficeLogEntry { key: string; time: string; agent: AgentId; text: string; color: string }
export const LOG_MAX = 100;

/** Agrega al inicio (el más nuevo primero) y recorta a `max`. */
export function appendLog<T>(log: T[], entry: T, max: number = LOG_MAX): T[] {
  return [entry, ...log].slice(0, max);
}

export type View = "chat" | "oficina";
export const VIEW_KEY = "orquestador.vista";

/** `?vista=` manda; si no, lo guardado; cualquier otra cosa → "chat". */
export function readView(search: string, stored: string | null): View {
  const q = new URLSearchParams(search).get("vista");
  if (q === "chat" || q === "oficina") return q;
  return stored === "oficina" ? "oficina" : "chat";
}

/** Eventos de WebSocket que cambian la foto de la oficina. */
export function refreshesOffice(type: string): boolean {
  return type.startsWith("plan:") || type.startsWith("voice:assistant:") ||
    type === "run:status" || type === "memory:indexed" || type === "accounts:changed";
}

/** Escala para que la escena (ancho de diseño) quepa en el contenedor; nunca agranda. */
export function sceneScale(width: number, design: number): number {
  return width > 0 ? Math.min(1, width / design) : 1;
}

export type Tone = "run" | "ok" | "err" | "wait" | "idle";
export interface Tag { label: string; tone: Tone }

export function planTag(p: { status: string; pauseReason: string | null }): Tag {
  if (p.pauseReason && !["completed", "failed", "cancelled"].includes(p.status)) return { label: "PAUSADO", tone: "wait" };
  const map: Record<string, Tag> = {
    generating: { label: "PLANEANDO", tone: "run" },
    pending: { label: "PENDIENTE", tone: "idle" },
    running: { label: "EJECUTANDO", tone: "run" },
    completed: { label: "COMPLETADO", tone: "ok" },
    failed: { label: "FALLÓ", tone: "err" },
    cancelled: { label: "CANCELADO", tone: "idle" },
  };
  return map[p.status] ?? { label: p.status.toUpperCase(), tone: "idle" };
}

export function queueTag(q: { status: string; adapter: string }): Tag {
  if (q.status === "paused") return { label: "GUARDIA", tone: "wait" };
  if (q.status === "running") return { label: q.adapter in ROLES ? ROLES[q.adapter as AgentId].label : q.adapter.toUpperCase(), tone: "run" };
  return { label: "EN COLA", tone: "idle" };
}

/** Segunda línea del letrero: planes y pasos activos según la cola. */
export function signLine(queue: { planId: string }[]): string {
  if (queue.length === 0) return "SIN PLANES ACTIVOS";
  const plans = new Set(queue.map((q) => q.planId)).size;
  return `${plans} ${plans === 1 ? "PLAN" : "PLANES"} · ${queue.length} ${queue.length === 1 ? "PASO" : "PASOS"}`;
}

export function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Con una plática abierta no se cambia de vista: se perderían sus controles con el micrófono abierto. */
export function viewLocked(target: View, current: View, talkActive: boolean): boolean {
  return talkActive && target !== current;
}

const TALK_PHASE: Record<string, string> = {
  starting: "PREPARANDO…", listening: "ESCUCHANDO", transcribing: "TRANSCRIBIENDO",
  thinking: "PENSANDO", speaking: "HABLANDO", ending: "TERMINANDO…",
};

/** Texto del panel RECEPCIÓN · PLATICAR: la fase si hay plática, si no la invitación. */
export function talkLabel(phase: string, active: boolean): string {
  return active ? TALK_PHASE[phase] ?? "" : "clic para platicar";
}

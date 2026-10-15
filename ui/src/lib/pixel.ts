import type { AgentId } from "./office.js";

/** Personaje pixel del modelo que respondió (Opus → Jefe con sombrero). */
export function avatarRoleFor(adapter: string | null | undefined, model?: string | null): AgentId {
  if (adapter === "codex" || adapter === "agy") return adapter;
  if (adapter === "claude" && model?.toLowerCase().includes("opus")) return "jefe";
  return "claude";
}

export type StatusKey = "succeeded" | "completed" | "running" | "paused" | "pending" | "failed" | "cancelled" | "skipped";

const GRAY = "var(--color-text-secondary)";
const STATUS: Record<StatusKey, { icon: string; color: string; label: string }> = {
  succeeded: { icon: "✓", color: "var(--color-ok)", label: "hecho" },
  completed: { icon: "✓", color: "var(--color-ok)", label: "completado" },
  running: { icon: "▶", color: "var(--color-blue)", label: "ejecutando" },
  paused: { icon: "⏸", color: "var(--color-warn)", label: "pausado" },
  pending: { icon: "•", color: GRAY, label: "en cola" },
  failed: { icon: "✗", color: "var(--color-err)", label: "falló" },
  cancelled: { icon: "⊘", color: GRAY, label: "cancelado" },
  skipped: { icon: "↷", color: GRAY, label: "omitido" },
};

/** Icono, color (variable CSS) y etiqueta en español de un estado; `paused` marca un pendiente en pausa. */
export function statusStyle(status: string, paused?: boolean): { icon: string; color: string; label: string } {
  if (status === "pending" && paused) return STATUS.paused;
  return Object.hasOwn(STATUS, status) ? STATUS[status as StatusKey] : { icon: "•", color: GRAY, label: status };
}

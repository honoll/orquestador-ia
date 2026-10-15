/** Estado final obligatorio de los pasos con rol (F11): `<<<ESTADO terminado|bloqueado|necesita {"detalle":"…"}>>>`. */
export type StepStatusKind = "terminado" | "bloqueado" | "necesita";

const STATUS_RE = /<<<ESTADO (terminado|bloqueado|necesita)(?:\s+(\{[^\n]*?\}))?\s*>>>/g;

/** Lee el último bloque de estado del texto del agente; null si no hay ninguno válido. */
export function parseStepStatus(text: string): { kind: StepStatusKind; detalle: string | null } | null {
  const m = [...text.matchAll(STATUS_RE)].at(-1);
  if (!m) return null;
  let detalle: string | null = null;
  try {
    const d = m[2] ? (JSON.parse(m[2]) as { detalle?: unknown }).detalle : undefined;
    if (typeof d === "string" && d.trim()) detalle = d.trim();
  } catch { /* JSON inválido: el estado vale sin detalle */ }
  return { kind: m[1] as StepStatusKind, detalle };
}

/** Estado final obligatorio de los pasos con rol (F11): `<<<ESTADO terminado|bloqueado|necesita {"detalle":"…"}>>>`. */
export type StepStatusKind = "terminado" | "bloqueado" | "necesita";

// Solo vale como ÚLTIMA línea no vacía de la respuesta: un bloque citado a media respuesta (p. ej. de una dependencia) no cuenta.
const STATUS_LINE_RE = /(?:^|\n)[ \t]*<<<ESTADO (terminado|bloqueado|necesita)(?:[ \t]+(\{[^\n]*\}))?[ \t]*>>>\s*$/;

/** Lee el bloque de estado de la última línea de la respuesta del agente; null si no está ahí. */
export function parseStepStatus(text: string): { kind: StepStatusKind; detalle: string | null } | null {
  const m = STATUS_LINE_RE.exec(text);
  if (!m) return null;
  let detalle: string | null = null;
  try {
    const d = m[2] ? (JSON.parse(m[2]) as { detalle?: unknown }).detalle : undefined;
    if (typeof d === "string" && d.trim()) detalle = d.trim();
  } catch { /* JSON inválido: el estado vale sin detalle */ }
  return { kind: m[1] as StepStatusKind, detalle };
}

/** Quita la línea final de estado: el resultado que ven los pasos siguientes y la síntesis no la lleva. */
export function stripStepStatus(text: string): string {
  return text.replace(STATUS_LINE_RE, "").trimEnd();
}

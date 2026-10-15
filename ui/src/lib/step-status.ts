// Copia en la UI de stripStepStatus (src/server/step-status.ts). test/ui/step-status.test.ts corre los
// MISMOS casos contra ambas: si cambias una regex, cambia la otra. Hace falta para runs viejos cuyo
// summary aún guarda la línea <<<ESTADO …>>> (antes de 909c983).
const STATUS_LINE_RE = /(?:^|\n)[ \t]*<<<ESTADO (terminado|bloqueado|necesita)(?:[ \t]+(\{[^\n]*\}))?[ \t]*>>>\s*$/;

/** Quita el bloque de estado solo si es la última línea no vacía. */
export function stripStatusLine(text: string): string {
  return text.replace(STATUS_LINE_RE, "").trimEnd();
}

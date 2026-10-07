// Copia en la UI del troceador de oraciones del servidor (src/voice/text.ts findSentenceEnd +
// src/voice/assistant/text.ts createSentenceStreamer). test/ui/sentences.test.ts corre los MISMOS casos
// contra ambas implementaciones: si cambias una, cambia la otra.

const TERMINATORS = new Set([".", "?", "!", "…"]);
/** Cierres que pueden seguir al signo final: comillas y paréntesis. */
const CLOSERS = new Set(['"', "'", ")", "”", "»", "’", "]"]);
/** Abreviaturas (sin punto, en minúsculas) tras las cuales un punto NO termina la oración. */
const ABBREVIATIONS = new Set([
  "sr", "sra", "srta", "dr", "dra", "lic", "ing", "prof", "ej", "p", "etc", "núm", "num", "aprox", "vs",
  "pág", "págs", "art", "av", "tel", "ud", "uds", "cap", "fig", "vol", "ee", "uu", "admón", "dpto", "col",
]);
const isSpace = (ch: string) => ch === " " || ch === "\n" || ch === "\t";

function wordBefore(text: string, dot: number): string {
  let i = dot;
  while (i > 0 && dot - i < 12 && /\p{L}/u.test(text[i - 1])) i--;
  const w = text.slice(i, dot);
  // Inicial suelta en mayúscula ("J. Pérez") cuenta como abreviatura; "s" de "0.3 s." no.
  return w.length === 1 && w === w.toUpperCase() ? "." : w.toLowerCase();
}

/**
 * Para texto en streaming: índice (exclusivo, tras los cierres) del primer fin de oración a partir
 * de `from`, o -1 si todavía no hay uno confirmado. Un fin es [.?!…]+ (más cierres) seguido de
 * espacio/salto de línea; no cuenta el final del texto (puede venir más), ni decimales ("2.5"),
 * ni abreviaturas. No exige mayúscula después, a diferencia del resumen.
 */
export function findSentenceEnd(text: string, from = 0): number {
  let i = from;
  while (i < text.length) {
    if (!TERMINATORS.has(text[i])) { i++; continue; }
    let j = i;
    while (j < text.length && TERMINATORS.has(text[j])) j++;
    const lastTerm = j - 1;
    while (j < text.length && CLOSERS.has(text[j])) j++;
    const boundary = j < text.length && isSpace(text[j]);
    const abbreviation = text[lastTerm] === "." && j === lastTerm + 1 &&
      (() => { const w = wordBefore(text, i); return w === "." || ABBREVIATIONS.has(w); })();
    if (boundary && !abbreviation) return j;
    i = j;
  }
  return -1;
}

/** Acumula deltas y emite oraciones completas; nunca emite las marcas <<<ACCION. */
export function createSentenceStreamer(onSentence: (s: string) => void): { push(delta: string): void; flush(): void } {
  let buffer = "";
  let stopped = false;

  const drain = () => {
    for (;;) {
      const end = findSentenceEnd(buffer, 0);
      if (end < 0) return;
      const sentence = buffer.slice(0, end).trim();
      buffer = buffer.slice(end);
      if (sentence) onSentence(sentence);
    }
  };

  return {
    push(delta: string) {
      if (stopped) return;
      buffer += delta;
      const mark = buffer.indexOf("<<<");
      if (mark >= 0) {
        buffer = buffer.slice(0, mark);
        drain();
        stopped = true;
        return;
      }
      drain();
    },
    flush() {
      // Una marca a medio llegar ("<<") no se habla.
      const rest = (stopped ? buffer : buffer.replace(/<{1,2}$/, "")).trim();
      buffer = "";
      stopped = false;
      if (rest) onSentence(rest);
    },
  };
}

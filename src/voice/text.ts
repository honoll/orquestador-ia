export const SPEECH_MAX_CHARS = 2000;
/** Margen para el markup que se descarta (enlaces, tablas, código). */
const INPUT_MAX_CHARS = SPEECH_MAX_CHARS * 4;
export const SUMMARY_SENTENCES = 3;
export const SUMMARY_MAX_CHARS = 400;

function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // Si el siguiente carácter ya era espacio, el corte cayó justo entre palabras.
  if (text[max] === " ") return cut.trimEnd();
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

const TERMINATORS = new Set([".", "?", "!", "…"]);
/** Cierres que pueden seguir al signo final: comillas y paréntesis. */
const CLOSERS = new Set(['"', "'", ")", "”", "»", "’", "]"]);
/** Abreviaturas (sin punto, en minúsculas) tras las cuales un punto NO termina la oración. */
const ABBREVIATIONS = new Set([
  "sr", "sra", "srta", "dr", "dra", "lic", "ing", "prof", "ej", "p", "etc", "núm", "num", "aprox", "vs",
  "pág", "págs", "art", "av", "tel", "ud", "uds", "cap", "fig", "vol", "ee", "uu", "admón", "dpto", "col",
]);
const NEXT_STARTS = /[¿¡A-ZÁÉÍÓÚÑÜ0-9"“«'([]/;
const isSpace = (ch: string) => ch === " " || ch === "\n" || ch === "\t";

function wordBefore(text: string, dot: number): string {
  let i = dot;
  while (i > 0 && dot - i < 12 && /\p{L}/u.test(text[i - 1])) i--;
  const w = text.slice(i, dot);
  // Inicial suelta en mayúscula ("J. Pérez") cuenta como abreviatura; "s" de "0.3 s." no.
  return w.length === 1 && w === w.toUpperCase() ? "." : w.toLowerCase();
}

/**
 * Primeras n oraciones, en una sola pasada (lineal). Un fin de oración es [.?!…]+ (más cierres)
 * seguido de espacio y mayúscula/¿/¡/dígito, o del final del texto; los puntos de abreviaturas
 * y de decimales ("2.5") no cuentan.
 */
function firstSentences(text: string, n: number): string {
  const found: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length && found.length < n) {
    if (!TERMINATORS.has(text[i])) { i++; continue; }
    let j = i;
    while (j < text.length && TERMINATORS.has(text[j])) j++;
    const lastTerm = j - 1;
    while (j < text.length && CLOSERS.has(text[j])) j++;
    let k = j;
    while (k < text.length && isSpace(text[k])) k++;
    const atEnd = k >= text.length;
    const boundary = atEnd || (k > j && NEXT_STARTS.test(text[k]));
    const abbreviation = text[lastTerm] === "." && j === lastTerm + 1 && !atEnd &&
      (() => { const w = wordBefore(text, i); return w === "." || ABBREVIATIONS.has(w); })();
    if (boundary && !abbreviation) {
      found.push(text.slice(start, j).trim());
      start = j;
    }
    i = j;
  }
  if (found.length < n) {
    const rest = text.slice(start).trim();
    if (rest) found.push(rest);
  }
  return found.join(" ");
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

/** Markdown -> texto que se puede leer en voz alta. Puro. */
export function toSpeechText(markdown: string, opts: { summary?: boolean } = {}): string {
  let t = markdown.slice(0, INPUT_MAX_CHARS).replace(/\r\n?/g, "\n");
  t = t.replace(/```[\s\S]*?(```|$)/g, " (código) ");
  t = t.replace(/`([^`]*)`/g, "$1");
  t = t.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2").replace(/\[\[([^\]]*)\]\]/g, "$1");
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/https?:\/\/[^\s)]+/g, "(enlace)");

  const lines = t.split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    let line = raw.trim();
    if (/^\|?[\s:|-]+\|?$/.test(line) && line.includes("-") && line.includes("|")) continue; // separador de tabla
    if (line.startsWith("|") || (line.includes("|") && /\|\s*$/.test(line))) {
      const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
      line = cells.join(", ");
      if (line && !/[.?!…]$/.test(line)) line += ".";
    }
    line = line.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "").replace(/^([-*+]|\d+[.)])\s+/, "");
    out.push(line);
  }
  t = out.join("\n");
  t = t.replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/(\*|_)(.+?)\1/g, "$2").replace(/~~(.+?)~~/g, "$1");
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return "";

  if (opts.summary) {
    t = clipAtWord(firstSentences(t, SUMMARY_SENTENCES), SUMMARY_MAX_CHARS);
  }
  return clipAtWord(t, SPEECH_MAX_CHARS);
}

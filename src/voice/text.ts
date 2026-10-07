export const SPEECH_MAX_CHARS = 2000;
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

function firstSentences(text: string, n: number): string {
  const re = /[^.?!…]*[.?!…]+/g;
  const found: string[] = [];
  let m: RegExpExecArray | null;
  let consumed = 0;
  while (found.length < n && (m = re.exec(text)) !== null) {
    found.push(m[0].trim());
    consumed = re.lastIndex;
  }
  if (found.length < n && consumed < text.length) {
    const rest = text.slice(consumed).trim();
    if (rest) found.push(rest);
  }
  return found.join(" ");
}

/** Markdown -> texto que se puede leer en voz alta. Puro. */
export function toSpeechText(markdown: string, opts: { summary?: boolean } = {}): string {
  let t = markdown.replace(/\r\n?/g, "\n");
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

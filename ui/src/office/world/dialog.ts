// Cuadro de diálogo del mundo (F12): qué dice el agente cercano y cómo se parte en páginas de 2 líneas.
import { roleTag } from "../../lib/roles";
import { formatTokens } from "../../lib/format";
import type { WorldAgent } from "./placement";

export interface Dialog { titulo: string; estado: "TRABAJANDO" | "EN ESPERA" | "EN REPOSO"; lineas: string[]; planId: string | null }

export function dialogFor(a: WorldAgent): Dialog {
  const agy = a.key.startsWith("agy:");
  const titulo = agy ? `${a.working && a.rol ? roleTag(a.rol) : "AGY"} · ${a.nombre}` : a.nombre;
  const estado = a.paused ? "EN ESPERA" : a.working ? "TRABAJANDO" : "EN REPOSO";
  const lineas: string[] = [];
  const act = agy && !a.working ? "libre, en la sala de descanso" : a.activity;
  if (act) lineas.push(act);
  if (a.progress) lineas.push(`${a.stepKey ? `paso ${a.stepKey} · ` : ""}${a.progress.done}/${a.progress.total} pasos del plan`);
  if (a.model) lineas.push(`modelo: ${a.model}`);
  if (typeof a.tokens === "number" && a.tokens > 0) lineas.push(`tokens: ${formatTokens(a.tokens)}`);
  if (agy && a.cuenta) lineas.push(`cuenta: ${a.cuenta}`);
  return { titulo, estado, lineas, planId: a.planId };
}

/** Corta por palabras a `maxChars` (una palabra más larga se corta a la fuerza) y agrupa en páginas de 2 renglones. */
export function paginate(lines: string[], maxChars = 42): string[][] {
  const rows: string[] = [];
  for (const line of lines) {
    let cur = "";
    for (let word of line.split(/\s+/).filter(Boolean)) {
      while (word.length > maxChars) {
        if (cur) { rows.push(cur); cur = ""; }
        rows.push(word.slice(0, maxChars));
        word = word.slice(maxChars);
      }
      if (!word) continue;
      if (cur && cur.length + 1 + word.length > maxChars) { rows.push(cur); cur = word; }
      else cur = cur ? `${cur} ${word}` : word;
    }
    if (cur) rows.push(cur);
  }
  const pages: string[][] = [];
  for (let i = 0; i < rows.length; i += 2) pages.push(rows.slice(i, i + 2));
  return pages.length ? pages : [[]];
}

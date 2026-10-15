// Lógica pura de la vista Oficina (F8): sprites pixel-art como rectángulos y bitácora de eventos.
export type AgentId = "jefe" | "guardia" | "agy" | "codex" | "claude" | "biblio" | "recepcion";
export type Rect = [x: number, y: number, w: number, h: number, color: string];
export const SPRITE_W = 28, SPRITE_H = 22;

type Accessory = "sombrero" | "gorra" | "antena" | "lentes" | "moño" | "libros" | "diadema";
export const ROLES: Record<AgentId, { label: string; color: string; accessory: Accessory; zone: "direccion" | "trabajadores" | "servicios" }> = {
  jefe: { label: "JEFE", color: "#a78bfa", accessory: "sombrero", zone: "direccion" },
  guardia: { label: "GUARDIA", color: "#fbbf24", accessory: "gorra", zone: "direccion" },
  agy: { label: "AGY", color: "#60a5fa", accessory: "antena", zone: "trabajadores" },
  codex: { label: "CODEX", color: "#34d399", accessory: "lentes", zone: "trabajadores" },
  claude: { label: "CLAUDE", color: "#e879f9", accessory: "moño", zone: "trabajadores" },
  biblio: { label: "BIBLIO", color: "#f472b6", accessory: "libros", zone: "servicios" },
  recepcion: { label: "RECEPCIÓN", color: "#fb923c", accessory: "diadema", zone: "servicios" },
};

/** Aclara (f>1) u oscurece (f<1) un #rrggbb; devuelve "rgb(r,g,b)". */
export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const m = (v: number) => Math.max(0, Math.min(255, Math.round(f > 1 ? v + (255 - v) * (f - 1) : v * f)));
  return `rgb(${m(n >> 16)},${m((n >> 8) & 255)},${m(n & 255)})`;
}

const OUT = "#09090b";

/** Port de draw() de la maqueta: un cuadro del personaje (28×22) como rectángulos, de atrás hacia adelante. */
export function spriteFrame(role: AgentId, working: boolean, t: number): Rect[] {
  const { color: c, accessory: a } = ROLES[role];
  const r: Rect[] = [];
  const px = (x: number, y: number, w: number, h: number, col: string) => { r.push([x, y, w, h, col]); };
  const on = working;
  const base = on ? c : "#5b5b66", hi = shade(base, 1.35), lo = shade(base, 0.62);
  const bob = on && t % 2 ? 1 : 0;
  // escritorio
  px(0, 17, 28, 3, "#26262e"); px(0, 20, 28, 2, "#1a1a20"); px(4, 18, 20, 1, on ? c : "#3f3f46");
  // monitor (con texto que corre solo si trabaja)
  px(1, 8, 10, 8, OUT); px(2, 9, 8, 6, "#18181d");
  if (on) for (let i = 0; i < 3; i++) px(3, 10 + i * 2, Math.min(2 + ((t + i * 3) % 6), 6), 1, shade(c, 1.2));
  px(5, 16, 2, 1, "#2a2a31");
  // teclado
  px(2, 16, 9, 1, "#3a3a44");
  if (on && t % 2) px(3 + (t % 7), 16, 1, 1, hi);
  // cuerpo y brazo
  px(14, 13 + bob, 10, 4, OUT); px(15, 13 + bob, 8, 4, lo); px(11, 15 + bob, 4, 1, lo);
  // cabeza (3 tonos) y cara
  px(13, 4 + bob, 12, 10, OUT); px(14, 5 + bob, 10, 8, base); px(14, 5 + bob, 10, 2, hi); px(14, 11 + bob, 10, 2, lo);
  px(14, 7 + bob, 6, 4, shade(base, 0.45));
  if (on && t % 11 !== 0) { px(15, 8 + bob, 1, 2, "#fff"); px(18, 8 + bob, 1, 2, "#fff"); }
  else { px(15, 9 + bob, 2, 1, "#d4d4d8"); px(18, 9 + bob, 2, 1, "#d4d4d8"); }
  // accesorio
  if (a === "sombrero") { px(12, 3 + bob, 14, 1, OUT); px(15, 1 + bob, 8, 3, "#7f1d1d"); px(13, 3 + bob, 12, 1, "#991b1b"); px(15, 2 + bob, 8, 1, "#b91c1c"); }
  if (a === "gorra") { px(14, 3 + bob, 10, 2, "#1e3a8a"); px(12, 4 + bob, 4, 1, "#1e40af"); px(18, 3 + bob, 2, 1, "#fbbf24"); }
  if (a === "antena") { px(21, 1 + bob, 1, 3, "#a1a1aa"); px(20, bob, 3, 1, on ? "#fde047" : "#71717a"); }
  if (a === "lentes") { px(14, 8 + bob, 3, 1, "#e4e4e7"); px(17, 8 + bob, 3, 1, "#e4e4e7"); px(14, 8 + bob, 1, 2, "#e4e4e7"); }
  if (a === "diadema") { px(13, 3 + bob, 12, 1, "#3f3f46"); px(12, 6 + bob, 2, 4, "#52525b"); px(11, 9 + bob, 3, 1, "#52525b"); }
  if (a === "moño") { px(22, 3 + bob, 3, 2, "#fda4af"); px(21, 4 + bob, 1, 1, "#fb7185"); }
  if (a === "libros") { px(24, 14, 3, 3, "#7c3aed"); px(24, 13, 3, 1, "#16a34a"); px(25, 12, 2, 1, "#ca8a04"); }
  // "z" en reposo (la maqueta usa fillText; aquí rectángulos)
  if (!on) { const y = 3 + (t % 3); px(25, y, 3, 1, "#71717a"); px(26, y + 1, 1, 1, "#71717a"); px(25, y + 2, 3, 1, "#71717a"); }
  return r;
}

export function deskLabel(label: string, desks: number): string {
  return desks > 1 ? `${label} ×${desks}` : label;
}

export function eventToLog(ev: { type: string; [k: string]: unknown }, now: Date = new Date()): { time: string; agent: AgentId; text: string; color: string } | null {
  const mk = (agent: AgentId, text: string) => ({
    time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    agent, text, color: ROLES[agent].color,
  });
  switch (ev.type) {
    case "plan:ready": return mk("jefe", "plan listo");
    case "plan:synthesis": return ev.status === "succeeded" ? mk("jefe", "síntesis lista") : null;
    case "plan:tier": return mk("guardia", `tier ${String(ev.tier ?? "?")}`);
    case "plan:guard": return mk("guardia", "pausó un paso");
    case "plan:step": {
      const verbs: Record<string, string> = { running: "paso en curso", succeeded: "paso terminado", failed: "paso falló" };
      const agent = typeof ev.adapter === "string" && ev.adapter in ROLES ? (ev.adapter as AgentId) : null;
      return agent && typeof ev.status === "string" && verbs[ev.status] ? mk(agent, verbs[ev.status]) : null;
    }
    case "plan:memory": return mk("biblio", ev.source === "loading" ? "cargando memoria" : "memoria lista");
    case "memory:indexed": return mk("biblio", "memoria reindexada");
    case "voice:assistant:turn-done": return mk("recepcion", "turno de voz");
    case "plan:done": return mk("jefe", `plan ${String(ev.status ?? "terminado")}`);
    default: return null;
  }
}

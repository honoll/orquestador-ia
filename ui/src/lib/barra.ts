// Barra lateral de equipo (F15): tipos de /api/equipo/bandejas y lógica pura.
import { roleColor } from "./roles";
import { ROLES } from "./office";

export interface BandejaTarea {
  id: string; planId: string; modo: "pasos" | "equipo"; titulo: string; meta: string; cuenta: string | null; desde: string | null;
}
export interface Bandeja {
  rol: string; nombre: string; trabajando: BandejaTarea[]; enCola: BandejaTarea[]; esperando: BandejaTarea[];
  total: { trabajando: number; enCola: number; esperando: number };
}

export function indicador(b: Bandeja): { texto: string; tone: "run" | "wait" | "idle" } {
  if (b.total.trabajando) return { texto: `trabajando ×${b.total.trabajando}`, tone: "run" };
  if (b.total.enCola) return { texto: `en cola ${b.total.enCola}`, tone: "wait" };
  if (b.total.esperando) return { texto: "esperando hijas", tone: "wait" };
  return { texto: "libre", tone: "idle" };
}

export function lineaActual(b: Bandeja): string | null {
  const t = b.trabajando[0];
  return t ? `${t.cuenta ?? "—"} · ${t.titulo}` : null;
}

export type Destino = { view: "equipo"; metaId: string; tareaId: string } | { view: "chat"; planId: string };
export const destino = (t: BandejaTarea): Destino =>
  t.modo === "equipo" ? { view: "equipo", metaId: t.planId, tareaId: t.id } : { view: "chat", planId: t.planId };

export const ABIERTOS_KEY = "orquestador.barra.abiertos";
export function leerAbiertos(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}
export const alternar = (abiertos: string[], rol: string): string[] =>
  abiertos.includes(rol) ? abiertos.filter((r) => r !== rol) : [...abiertos, rol];

export const colorRol = (rol: string): string => (rol === "jefe" ? ROLES.jefe.color : roleColor(rol));
export const refrescaBarra = (type: string): boolean => type.startsWith("plan:") || type.startsWith("team:");

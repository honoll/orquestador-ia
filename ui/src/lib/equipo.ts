// Vista Equipo (F14): tipos de /api/equipo/metas y lógica pura.
export interface MetaView {
  id: string; pedido: string; estado: string; pausa: string | null; usados: number; presupuesto: number | null;
  respuesta: string | null; error: string | null; proyecto: string | null; creada: string; actualizada: string;
}
export interface TareaView {
  id: string; parentId: string | null; rol: string; titulo: string; instrucciones: string; estado: string; cuenta: string | null;
  turnos: number; tokens: number; detalle: string | null; resultado: string | null; guardia: boolean;
}
export interface ComentarioView { id: string; tareaId: string; autor: string; texto: string; fecha: string }
export interface MetaDetalle { meta: MetaView; tareas: TareaView[]; comentarios: ComentarioView[] }

export const ESTADO_TAREA: Record<string, { label: string; tone: "run" | "ok" | "err" | "wait" | "idle" }> = {
  en_cola: { label: "en cola", tone: "idle" },
  corriendo: { label: "trabajando", tone: "run" },
  esperando: { label: "esperando hijas", tone: "wait" },
  hecha: { label: "hecha", tone: "ok" },
  fallida: { label: "falló", tone: "err" },
  cancelada: { label: "cancelada", tone: "idle" },
};

export const PAUSA: Record<string, string> = {
  quota: "sin cuota de agy", budget: "presupuesto agotado", guard: "la guardia pide aprobar una tarea", manual: "pausada por ti",
};

/** Árbol en orden: cada hija debajo de su padre (orden de creación); una tarea sin padre conocido va al nivel 0. */
export function treeRows(tareas: TareaView[]): { tarea: TareaView; nivel: number }[] {
  const ids = new Set(tareas.map((t) => t.id));
  const kids = new Map<string | null, TareaView[]>();
  for (const t of tareas) {
    const k = t.parentId && ids.has(t.parentId) ? t.parentId : null;
    kids.set(k, [...(kids.get(k) ?? []), t]);
  }
  const out: { tarea: TareaView; nivel: number }[] = [];
  const walk = (parent: string | null, nivel: number) => {
    for (const t of kids.get(parent) ?? []) { out.push({ tarea: t, nivel }); walk(t.id, nivel + 1); }
  };
  walk(null, 0);
  return out;
}

export const refreshesEquipo = (type: string): boolean => type.startsWith("team:") || type === "plan:step";

export const ESTADO_META: Record<string, string> = {
  generating: "generando", pending: "en espera", running: "trabajando", completed: "completada", failed: "falló", cancelled: "cancelada",
};
export const metaLabel = (estado: string): string => ESTADO_META[estado] ?? estado;

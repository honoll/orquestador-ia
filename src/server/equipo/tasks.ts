import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { broadcast } from "../ws.js";
import { getRole, loadRoles } from "../roles.js";
import { PLANNER_MODEL } from "../../config/models.js";
import { clip } from "../plan-dag.js";
import { enqueueWakeup } from "./wakeups.js";
import {
  COMENTARIO_MAX, ENTREGA_MAX, HUMANO, INSTRUCCIONES_MAX, JEFE_ROL, LEER_ITEM_MAX, LEER_MAX_ITEMS, MAX_PROFUNDIDAD, MAX_TAREAS, PEDIDO_MAX, PRESUPUESTO_META,
  RESUMEN_HIJA_MAX, TITULO_MAX, TOPE_TOKENS_TURNO,
} from "./constants.js";

export class TeamError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string) { super(message); }
}
export type StepRow = typeof schema.planSteps.$inferSelect;
export const TERMINAL: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled", "skipped"]);

const S = schema.planSteps;

// Las mutaciones del árbol (conteo de tareas, blocked_by) pasan en fila: delegaciones paralelas no se pisan.
// Nada que reentre a esta cadena (createChildTask, addComment…) debe llamarse desde dentro de `serial`.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}
const now = () => new Date().toISOString();
const emit = (e: Record<string, unknown>) => broadcast({ ...e, timestamp: now() } as any);
const text = (v: unknown, max: number, campo: string): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new TeamError(400, `"${campo}" debe ser texto de 1 a ${max} caracteres`);
  return v.trim();
};

const EJEMPLO_ALCANCE = `por ejemplo "leer": ["src/slug.mjs", "CLAUDE.md § Team mode (F14)"], "entrega": "5 viñetas, máx 150 palabras"`;
/** Bloques LEE SOLO / ENTREGA que acotan a la hija (obligatorios al delegar). */
function alcance(leer: unknown, entrega: unknown): string {
  if (!Array.isArray(leer) || leer.length < 1 || leer.length > LEER_MAX_ITEMS
    || leer.some((x) => typeof x !== "string" || !x.trim() || x.length > LEER_ITEM_MAX)) {
    throw new TeamError(400, `"leer" debe ser una lista de 1 a ${LEER_MAX_ITEMS} rutas o secciones exactas (máx ${LEER_ITEM_MAX} caracteres cada una), ${EJEMPLO_ALCANCE}`);
  }
  if (typeof entrega !== "string" || !entrega.trim() || entrega.length > ENTREGA_MAX) {
    throw new TeamError(400, `"entrega" debe decir formato y largo en 1 a ${ENTREGA_MAX} caracteres, ${EJEMPLO_ALCANCE}`);
  }
  return `LEE SOLO:\n${leer.map((x) => `- ${(x as string).trim()}`).join("\n")}\n\nENTREGA: ${entrega.trim()}`;
}

export function parseIds(raw: string | null): string[] {
  try { const v = JSON.parse(raw ?? "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}

export async function getStep(id: string): Promise<StepRow | undefined> {
  return (await db.select().from(S).where(eq(S.id, id)))[0];
}
export async function childrenOf(stepId: string): Promise<StepRow[]> {
  return db.select().from(S).where(eq(S.parentStepId, stepId)).orderBy(asc(S.stepIndex));
}
/** Del padre hacia arriba (el más cercano primero). */
export async function ancestorsOf(step: StepRow, max = 3): Promise<StepRow[]> {
  const out: StepRow[] = [];
  let cur = step.parentStepId ? await getStep(step.parentStepId) : undefined;
  while (cur && out.length < max) { out.push(cur); cur = cur.parentStepId ? await getStep(cur.parentStepId) : undefined; }
  return out;
}

/** true si `target` es `root` o desciende de él (sube por parent_step_id). */
export async function inSubtree(rootStepId: string, targetStepId: string): Promise<boolean> {
  let cur: string | null = targetStepId;
  for (let hops = 0; cur && hops <= MAX_PROFUNDIDAD + 1; hops++) {
    if (cur === rootStepId) return true;
    cur = (await getStep(cur))?.parentStepId ?? null;
  }
  return false;
}

/** Roles a los que se puede delegar (todos menos el Jefe), para el prompt del Jefe. */
export function roleCatalog(): string {
  return loadRoles().filter((r) => r.id !== JEFE_ROL)
    .map((r) => `- ${r.id}: ${r.nombre}${r.escribe === false ? " (solo lectura: entrega con su respuesta)" : r.escribe === "salidas" ? " (guarda archivos en la carpeta de salidas)" : " (escribe en el proyecto)"}`)
    .join("\n");
}

export async function createGoal(input: { pedido: unknown; projectId?: string | null; budgetTokens?: number | null }): Promise<{ planId: string; rootStepId: string }> {
  const pedido = text(input.pedido, PEDIDO_MAX, "pedido");
  const planId = randomUUID(), rootStepId = randomUUID();
  await db.insert(schema.plans).values({
    id: planId, projectId: input.projectId ?? null, description: pedido, status: "pending", mode: "equipo",
    budgetTokens: input.budgetTokens ?? PRESUPUESTO_META,
  });
  await db.insert(S).values({
    id: rootStepId, planId, stepIndex: 0, stepKey: "t1", description: clip(pedido, TITULO_MAX), prompt: pedido,
    adapter: "claude", model: PLANNER_MODEL, role: JEFE_ROL, depth: 0, writes: 0, readOnly: 0, status: "pending", blockedBy: "[]",
  });
  await enqueueWakeup(planId, rootStepId, "asignada");
  emit({ type: "team:goal", planId, status: "pending" });
  return { planId, rootStepId };
}

export async function createChildTask(
  planId: string, parentStepId: string,
  input: { rol?: unknown; titulo?: unknown; instrucciones?: unknown; esperar?: unknown; leer?: unknown; entrega?: unknown },
  opts: { consulta?: boolean } = {},
): Promise<{ id: string }> {
  const rolId = typeof input.rol === "string" ? input.rol : "";
  const role = rolId && rolId !== JEFE_ROL ? getRole(rolId) : null;
  if (!role) throw new TeamError(400, `"rol" debe ser uno de: ${loadRoles().map((r) => r.id).filter((id) => id !== JEFE_ROL).join(", ")}`);
  const titulo = text(input.titulo, TITULO_MAX, "titulo");
  const instrucciones = text(input.instrucciones, INSTRUCCIONES_MAX, "instrucciones");
  const prompt = opts.consulta ? instrucciones : `${instrucciones}\n\n${alcance(input.leer, input.entrega)}`;
  if (input.esperar !== undefined && typeof input.esperar !== "boolean") throw new TeamError(400, `"esperar" debe ser true o false`);
  const id = await serial(async () => {
    const parent = await getStep(parentStepId);
    if (!parent || parent.planId !== planId) throw new TeamError(404, "La tarea padre no existe");
    const depth = (parent.depth ?? 0) + 1;
    if (depth > MAX_PROFUNDIDAD) throw new TeamError(409, `Tope de profundidad (${MAX_PROFUNDIDAD}): resuélvelo tú o coméntalo a tu tarea padre`);
    const count = (await db.select({ id: S.id }).from(S).where(eq(S.planId, planId))).length;
    if (count >= MAX_TAREAS) throw new TeamError(409, `Tope de ${MAX_TAREAS} tareas por meta: termina con lo que hay`);
    const newId = randomUUID();
    await db.insert(S).values({
      id: newId, planId, stepIndex: count, stepKey: `t${count + 1}`, description: titulo, prompt,
      adapter: "agy", model: role.modelo, role: role.id, writes: role.escribe === false ? 0 : 1, readOnly: role.escribe === false ? 1 : 0,
      parentStepId, depth, createdByStepId: parentStepId, reason: opts.consulta ? "consulta" : null, status: "pending", blockedBy: "[]",
    });
    if (input.esperar === true) {
      await db.update(S).set({ blockedBy: JSON.stringify([...parseIds(parent.blockedBy), newId]) }).where(eq(S.id, parentStepId));
    }
    return newId;
  });
  await enqueueWakeup(planId, id, opts.consulta ? "consulta" : "asignada");
  emit({ type: "team:task", planId, stepId: id, status: "pending" });
  return { id };
}

export async function addComment(planId: string, stepId: string, author: string, texto: unknown, opts: { menciones?: boolean } = {}): Promise<{ id: string }> {
  const body = text(texto, COMENTARIO_MAX, "texto");
  const step = await getStep(stepId);
  if (!step || step.planId !== planId) throw new TeamError(404, "La tarea no existe");
  const authorStep = author === HUMANO ? undefined : await getStep(author);
  const id = randomUUID();
  await db.insert(schema.teamComments).values({ id, planId, stepId, author, body, createdByRunId: authorStep?.runId ?? null, createdAt: now() });
  if (author !== stepId) await enqueueWakeup(planId, stepId, "comentario", { commentIds: [id] });
  emit({ type: "team:comment", planId, stepId, commentId: id });
  if (opts.menciones !== false) {
    const ids = new Set(loadRoles().map((r) => r.id));
    for (const rol of new Set([...body.matchAll(/(?:^|\s)@([a-z][a-z0-9-]*)/g)].map((m) => m[1]))) {
      if (rol === JEFE_ROL || !ids.has(rol)) continue;
      try {
        await createChildTask(planId, stepId, { rol, titulo: `Consulta de ${await authorLabel(author)}`.slice(0, TITULO_MAX), instrucciones: body }, { consulta: true });
      } catch (e) {
        if (!(e instanceof TeamError)) throw e; // tope de profundidad/tareas: el comentario ya quedó, solo se omite la consulta
      }
    }
  }
  return { id };
}

export async function authorLabel(author: string): Promise<string> {
  if (author === HUMANO) return HUMANO;
  const s = await getStep(author);
  return s ? `${s.role ?? "?"} (${s.description})` : "tarea borrada";
}

type CommentRow = { id: string; author: string; body: string; createdAt: string };
const C = schema.teamComments;
export async function commentsFor(stepId: string, limit: number): Promise<CommentRow[]> {
  const rows = await db.select({ id: C.id, author: C.author, body: C.body, createdAt: C.createdAt }).from(C).where(eq(C.stepId, stepId)).orderBy(asc(C.createdAt));
  return rows.slice(-limit);
}
export async function commentsByIds(ids: string[]): Promise<CommentRow[]> {
  if (!ids.length) return [];
  return db.select({ id: C.id, author: C.author, body: C.body, createdAt: C.createdAt }).from(C).where(inArray(C.id, ids)).orderBy(asc(C.createdAt));
}

/** Estado de una hija para quien la delegó: estado, detalle y resultado (o error) recortado. */
export function childSummary(step: StepRow): string {
  const detalle = step.statusDetail ? ` (${step.statusDetail})` : "";
  const aviso = (step.inputTokens ?? 0) > TOPE_TOKENS_TURNO
    ? ` · AVISO: su último turno gastó ${step.inputTokens} tokens de entrada (tope ${TOPE_TOKENS_TURNO}): acota más (leer, entrega) la próxima vez.`
    : "";
  return `${step.status}${detalle}: ${clip(step.result ?? step.errorMessage ?? "(sin resultado)", RESUMEN_HIJA_MAX)}${aviso}`;
}

export function estadoTarea(step: Pick<StepRow, "status" | "blockedBy">, hijas: Pick<StepRow, "id" | "status">[]): "en_cola" | "corriendo" | "esperando" | "hecha" | "fallida" | "cancelada" {
  if (step.status === "running") return "corriendo";
  if (step.status === "succeeded") return "hecha";
  if (step.status === "failed") return "fallida";
  if (step.status === "cancelled" || step.status === "skipped") return "cancelada";
  const espera = parseIds(step.blockedBy);
  return hijas.some((h) => espera.includes(h.id) && !TERMINAL.has(h.status)) ? "esperando" : "en_cola";
}

/**
 * Una tarea llegó a estado terminal: la consulta responde con un comentario a quien preguntó; si el padre la
 * esperaba y ya terminaron todas, el padre despierta con los resúmenes; una hija no esperada que falla avisa por comentario.
 */
export async function onTaskTerminal(planId: string, stepId: string): Promise<void> {
  const step = await getStep(stepId);
  if (!step?.parentStepId) return;
  const parent = await getStep(step.parentStepId);
  if (!parent || parent.status === "cancelled") return;
  if (step.reason === "consulta") {
    await addComment(planId, parent.id, step.id, `Respuesta de ${step.role} a la consulta: ${childSummary(step)}`, { menciones: false });
    return;
  }
  // Decide dentro de la cadena (lee/escribe blocked_by del padre); los comentarios, ya fuera de ella.
  const esperaba = await serial(async () => {
    const espera = parseIds((await getStep(parent.id))?.blockedBy ?? null);
    if (!espera.includes(step.id)) return false;
    const hijas = await childrenOf(parent.id);
    const terminada = (id: string) => TERMINAL.has(hijas.find((h) => h.id === id)?.status ?? "cancelled");
    if (!espera.every(terminada)) return true;
    // Despertar ANTES de vaciar blocked_by: el scheduler ve siempre uno de los dos y no da al padre por terminado.
    // enqueueWakeup usa la cadena de wakeups.ts (otra), no reentra en esta.
    await enqueueWakeup(planId, parent.id, "hijas_terminadas", { childIds: espera });
    await db.update(S).set({ blockedBy: JSON.stringify(espera.filter((id) => !terminada(id))) }).where(eq(S.id, parent.id));
    return true;
  });
  if (esperaba) return;
  if (step.status === "failed") {
    await addComment(planId, parent.id, step.id, `La tarea "${step.description}" (${step.role}) falló: ${step.statusDetail ?? step.errorMessage ?? "sin detalle"}`, { menciones: false });
  }
}

export interface TaskContext {
  meta: { id: string; pedido: string };
  tarea: { id: string; rol: string; titulo: string; instrucciones: string; estado: string };
  ancestros: { id: string; rol: string; titulo: string; resultado: string | null }[];
  hijas: { id: string; rol: string; titulo: string; estado: string; resumen: string }[];
  comentarios: { id: string; autor: string; texto: string; fecha: string }[];
}

export async function taskContext(stepId: string): Promise<TaskContext> {
  const step = await getStep(stepId);
  if (!step) throw new TeamError(404, "La tarea no existe");
  const [plan] = await db.select().from(schema.plans).where(eq(schema.plans.id, step.planId));
  const hijas = await childrenOf(stepId);
  const comentarios = await commentsFor(stepId, 50);
  return {
    meta: { id: step.planId, pedido: plan?.description ?? "" },
    tarea: { id: step.id, rol: step.role ?? "", titulo: step.description, instrucciones: step.prompt, estado: estadoTarea(step, hijas) },
    ancestros: (await ancestorsOf(step)).map((a) => ({ id: a.id, rol: a.role ?? "", titulo: a.description, resultado: a.result ? clip(a.result, RESUMEN_HIJA_MAX) : null })),
    hijas: await Promise.all(hijas.map(async (h) => ({ id: h.id, rol: h.role ?? "", titulo: h.description, estado: estadoTarea(h, await childrenOf(h.id)), resumen: childSummary(h) }))),
    comentarios: await Promise.all(comentarios.map(async (c) => ({ id: c.id, autor: await authorLabel(c.author), texto: c.body, fecha: c.createdAt }))),
  };
}

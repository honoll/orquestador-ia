import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db/index.js";

export type WakeReason = "asignada" | "comentario" | "hijas_terminadas" | "consulta" | "continuar";
export interface WakePayload { reasons: WakeReason[]; commentIds: string[]; childIds: string[] }
export type WakeupRow = typeof schema.teamWakeups.$inferSelect;

const W = schema.teamWakeups;
const empty = (): WakePayload => ({ reasons: [], commentIds: [], childIds: [] });
const union = <T>(a: T[], b: T[] = []) => [...a, ...b.filter((x) => !a.includes(x))];
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function parsePayload(raw: string | null): WakePayload {
  try {
    const o = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    return { reasons: strings(o.reasons) as WakeReason[], commentIds: strings(o.commentIds), childIds: strings(o.childIds) };
  } catch { return empty(); }
}

export function mergePayload(a: WakePayload, b: Partial<WakePayload>): WakePayload {
  return { reasons: union(a.reasons, b.reasons), commentIds: union(a.commentIds, b.commentIds), childIds: union(a.childIds, b.childIds) };
}

// Todo lo que lee-y-escribe la cola pasa en fila: dos encolados no crean dos despertares para la misma tarea.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

/** Encola un despertar; si la tarea ya tiene uno en cola, se fusiona (un solo turno para todo lo nuevo). */
export function enqueueWakeup(
  planId: string, stepId: string, reason: WakeReason,
  extra: { commentIds?: string[]; childIds?: string[] } = {}, now: Date = new Date(),
): Promise<string> {
  return serial(async () => {
    const add = { reasons: [reason], commentIds: extra.commentIds ?? [], childIds: extra.childIds ?? [] };
    const [queued] = await db.select().from(W).where(and(eq(W.stepId, stepId), eq(W.status, "en_cola")));
    if (queued) {
      await db.update(W).set({ payload: JSON.stringify(mergePayload(parsePayload(queued.payload), add)) }).where(eq(W.id, queued.id));
      return queued.id;
    }
    const id = randomUUID();
    await db.insert(W).values({ id, planId, stepId, reason, payload: JSON.stringify(mergePayload(empty(), add)), status: "en_cola", createdAt: now.toISOString() });
    return id;
  });
}

/** Toma el despertar más viejo cuya tarea no está corriendo (ni en `skip`). Una tarea cancelada o borrada lo cancela. */
export function claimWakeup(planId: string, skip: ReadonlySet<string> = new Set()): Promise<WakeupRow | null> {
  return serial(async () => {
    const rows = await db.select().from(W).where(and(eq(W.planId, planId), eq(W.status, "en_cola"))).orderBy(asc(W.createdAt));
    for (const w of rows) {
      if (skip.has(w.stepId)) continue;
      const [step] = await db.select({ status: schema.planSteps.status }).from(schema.planSteps).where(eq(schema.planSteps.id, w.stepId));
      if (!step || step.status === "cancelled") {
        await db.update(W).set({ status: "cancelado" }).where(eq(W.id, w.id));
        continue;
      }
      if (step.status === "running") continue; // espera a que termine el turno en curso
      const takenAt = new Date().toISOString();
      await db.update(W).set({ status: "tomado", takenAt }).where(eq(W.id, w.id));
      return { ...w, status: "tomado", takenAt };
    }
    return null;
  });
}

export async function finishWakeup(id: string, status: "hecho" | "cancelado"): Promise<void> {
  await db.update(W).set({ status }).where(eq(W.id, id));
}

/** El turno no pudo arrancar (sin cuenta, cuota, guardia): el despertar vuelve a la cola, o se funde con uno nuevo. */
export function requeueWakeup(id: string): Promise<void> {
  return serial(async () => {
    const [w] = await db.select().from(W).where(eq(W.id, id));
    if (!w) return;
    const [other] = await db.select().from(W).where(and(eq(W.stepId, w.stepId), eq(W.status, "en_cola")));
    if (other && other.id !== w.id) {
      await db.update(W).set({ payload: JSON.stringify(mergePayload(parsePayload(other.payload), parsePayload(w.payload))) }).where(eq(W.id, other.id));
      await db.update(W).set({ status: "hecho" }).where(eq(W.id, w.id));
      return;
    }
    await db.update(W).set({ status: "en_cola", takenAt: null }).where(eq(W.id, id));
  });
}

export async function cancelPlanWakeups(planId: string): Promise<void> {
  await db.update(W).set({ status: "cancelado" }).where(and(eq(W.planId, planId), inArray(W.status, ["en_cola", "tomado"])));
}

export async function hasQueued(planId: string): Promise<boolean> {
  return (await db.select({ id: W.id }).from(W).where(and(eq(W.planId, planId), eq(W.status, "en_cola")))).length > 0;
}

export async function hasQueuedFor(stepId: string): Promise<boolean> {
  return (await db.select({ id: W.id }).from(W).where(and(eq(W.stepId, stepId), eq(W.status, "en_cola")))).length > 0;
}

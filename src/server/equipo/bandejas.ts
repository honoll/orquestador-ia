import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { loadRoles } from "../roles.js";
import { estadoTarea, type StepRow } from "./tasks.js";
import { JEFE_ROL } from "./constants.js";

export const MAX_POR_GRUPO = 20;
export const OTROS = "otros";

export interface BandejaTarea {
  id: string; planId: string; modo: "pasos" | "equipo"; titulo: string; meta: string; cuenta: string | null; desde: string | null;
}
type Grupo = "trabajando" | "enCola" | "esperando";
export interface Bandeja {
  rol: string; nombre: string; trabajando: BandejaTarea[]; enCola: BandejaTarea[]; esperando: BandejaTarea[];
  total: Record<Grupo, number>;
}

const P = schema.plans, S = schema.planSteps;
const GRUPOS: Grupo[] = ["trabajando", "enCola", "esperando"];
const vacia = (rol: string, nombre: string): Bandeja => ({ rol, nombre, trabajando: [], enCola: [], esperando: [], total: { trabajando: 0, enCola: 0, esperando: 0 } });
// Más recientes primero; las que no han arrancado (sin `desde`) al final.
const recientes = (a: BandejaTarea, b: BandejaTarea) => (b.desde ?? "").localeCompare(a.desde ?? "");

function grupoDe(step: StepRow, hijas: StepRow[] | null): Grupo {
  if (step.status === "running") return "trabajando";
  return hijas && estadoTarea(step, hijas) === "esperando" ? "esperando" : "enCola";
}

/** Trabajo activo por rol para la barra (F15): metas de equipo abiertas y planes de pasos corriendo o pausados. */
export async function buildBandejas(): Promise<Bandeja[]> {
  const filas: Bandeja[] = [vacia(JEFE_ROL, "Jefe"), ...loadRoles().filter((r) => r.id !== JEFE_ROL).map((r) => vacia(r.id, r.nombre))];
  const porRol = new Map(filas.map((b) => [b.rol, b]));
  const otros = vacia(OTROS, "Otros");

  const planes = await db.select().from(P).where(or(
    and(eq(P.mode, "equipo"), inArray(P.status, ["pending", "running"])),
    and(eq(P.mode, "pasos"), or(eq(P.status, "running"), isNotNull(P.pauseReason))),
  ));
  if (planes.length) {
    const planPorId = new Map(planes.map((p) => [p.id, p]));
    const pasos = await db.select().from(S).where(inArray(S.planId, [...planPorId.keys()]));
    const hijasDe = new Map<string, StepRow[]>();
    for (const s of pasos) if (s.parentStepId) hijasDe.set(s.parentStepId, [...(hijasDe.get(s.parentStepId) ?? []), s]);
    const cuentas = [...new Set(pasos.map((s) => s.accountId).filter((x): x is string => !!x))];
    const etiqueta = new Map(
      (cuentas.length ? await db.select({ id: schema.agyAccounts.id, label: schema.agyAccounts.label }).from(schema.agyAccounts).where(inArray(schema.agyAccounts.id, cuentas)) : [])
        .map((a) => [a.id, a.label]),
    );
    for (const s of pasos) {
      if (s.status !== "pending" && s.status !== "running") continue;
      const plan = planPorId.get(s.planId)!;
      const grupo = grupoDe(s, plan.mode === "equipo" ? hijasDe.get(s.id) ?? [] : null);
      const b = (s.role ? porRol.get(s.role) : undefined) ?? otros;
      b.total[grupo]++;
      b[grupo].push({
        id: s.id, planId: s.planId, modo: plan.mode, titulo: s.description, meta: plan.description,
        cuenta: s.adapter === "agy" ? (s.accountId ? etiqueta.get(s.accountId) ?? null : null) : s.adapter,
        desde: s.startedAt ?? null,
      });
    }
  }
  const salida = GRUPOS.some((g) => otros.total[g] > 0) ? [...filas, otros] : filas;
  for (const b of salida) for (const g of GRUPOS) b[g] = b[g].sort(recientes).slice(0, MAX_POR_GRUPO);
  return salida;
}

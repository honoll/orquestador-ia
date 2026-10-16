import { Hono, type Context } from "hono";
import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { approveTaskGuard, cancelTeam, continueTeam, humanComment, pauseTeam, startGoal } from "../equipo/team-scheduler.js";
import { authorLabel, childrenOf, estadoTarea, TeamError } from "../equipo/tasks.js";
import { CUERPO_MAX, JEFE_ROL } from "../equipo/constants.js";

const P = schema.plans, S = schema.planSteps;

export interface MetaView {
  id: string; pedido: string; estado: string; pausa: string | null; usados: number; presupuesto: number | null;
  respuesta: string | null; error: string | null; proyecto: string | null; creada: string; actualizada: string;
}
export interface TareaView {
  id: string; parentId: string | null; rol: string; titulo: string; instrucciones: string; estado: string; cuenta: string | null;
  turnos: number; tokens: number; detalle: string | null; resultado: string | null; guardia: boolean;
}
export interface ComentarioView { id: string; tareaId: string; autor: string; texto: string; fecha: string }

const metaView = (p: typeof P.$inferSelect): MetaView => ({
  id: p.id, pedido: p.description, estado: p.status, pausa: p.pauseReason ?? null, usados: p.usedTokens, presupuesto: p.budgetTokens ?? null,
  respuesta: p.synthesis ?? null, error: p.errorMessage ?? null, proyecto: p.projectId ?? null, creada: p.createdAt, actualizada: p.updatedAt,
});

async function json(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  if (raw.length > CUERPO_MAX) throw new TeamError(400, "Cuerpo demasiado grande");
  try { const v = raw ? JSON.parse(raw) : {}; return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { throw new TeamError(400, "JSON inválido"); }
}
const fail = (c: Context, err: unknown) => { if (err instanceof TeamError) return c.json({ error: err.message }, err.status); throw err; };

async function getMeta(id: string) {
  const [p] = await db.select().from(P).where(eq(P.id, id));
  return p && p.mode === "equipo" ? p : undefined;
}

export function createEquipoRoute() {
  const app = new Hono();

  app.get("/", async (c) => {
    const rows = await db.select().from(P).where(eq(P.mode, "equipo")).orderBy(desc(P.createdAt));
    return c.json(rows.map(metaView));
  });

  app.post("/", async (c) => {
    try {
      const b = await json(c);
      if (typeof b.pedido !== "string") throw new TeamError(400, '"pedido" debe ser texto');
      // Sin proyecto la meta correría con escritura en la carpeta del orquestador (planCwd cae a process.cwd()).
      if (typeof b.projectId !== "string" || !b.projectId) throw new TeamError(400, '"projectId" es obligatorio: elige un proyecto');
      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, b.projectId));
      if (!project?.path) throw new TeamError(400, "El proyecto no existe o no tiene carpeta");
      const { planId } = await startGoal({ pedido: b.pedido, projectId: project.id });
      return c.json({ id: planId }, 201);
    } catch (err) { return fail(c, err); }
  });

  app.get("/:id", async (c) => {
    const meta = await getMeta(c.req.param("id"));
    if (!meta) return c.json({ error: "La meta no existe" }, 404);
    const steps = (await db.select().from(S).where(eq(S.planId, meta.id))).sort((a, b) => a.stepIndex - b.stepIndex);
    const accountIds = [...new Set(steps.map((s) => s.accountId).filter((x): x is string => !!x))];
    const accounts = accountIds.length ? await db.select().from(schema.agyAccounts).where(inArray(schema.agyAccounts.id, accountIds)) : [];
    const label = new Map(accounts.map((a) => [a.id, a.label]));
    const tareas: TareaView[] = await Promise.all(steps.map(async (s) => ({
      id: s.id, parentId: s.parentStepId ?? null, rol: s.role ?? "", titulo: s.description, instrucciones: s.prompt,
      estado: estadoTarea(s, await childrenOf(s.id)),
      cuenta: s.role === JEFE_ROL ? "claude" : s.accountId ? label.get(s.accountId) ?? s.accountId : null,
      turnos: s.turns, tokens: (s.inputTokens ?? 0) + (s.outputTokens ?? 0), detalle: s.statusDetail ?? s.errorMessage ?? null,
      resultado: s.result ?? null, guardia: !!s.guardFlags,
    })));
    const cs = await db.select().from(schema.teamComments).where(eq(schema.teamComments.planId, meta.id));
    const comentarios: ComentarioView[] = await Promise.all(cs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-500)
      .map(async (x) => ({ id: x.id, tareaId: x.stepId, autor: await authorLabel(x.author), texto: x.body, fecha: x.createdAt })));
    return c.json({ meta: metaView(meta), tareas, comentarios });
  });

  app.post("/:id/comentarios", async (c) => {
    try {
      const meta = await getMeta(c.req.param("id"));
      if (!meta) return c.json({ error: "La meta no existe" }, 404);
      const b = await json(c);
      if (typeof b.tareaId !== "string") throw new TeamError(400, '"tareaId" debe ser texto');
      return c.json(await humanComment(meta.id, b.tareaId, b.texto), 201);
    } catch (err) { return fail(c, err); }
  });

  const action = (fn: (id: string) => Promise<unknown>) => async (c: Context) => {
    const meta = await getMeta(c.req.param("id") ?? "");
    if (!meta) return c.json({ error: "La meta no existe" }, 404);
    await fn(meta.id);
    return c.json({ ok: true });
  };
  app.post("/:id/pausar", action((id) => pauseTeam(id, "manual")));
  app.post("/:id/continuar", action((id) => continueTeam(id)));
  app.post("/:id/cancelar", action((id) => cancelTeam(id)));

  app.post("/:id/tareas/:tareaId/aprobar", async (c) => {
    const meta = await getMeta(c.req.param("id"));
    if (!meta) return c.json({ error: "La meta no existe" }, 404);
    const ok = await approveTaskGuard(meta.id, c.req.param("tareaId"));
    return ok ? c.json({ ok: true }) : c.json({ error: "Esa tarea no está pausada por la guardia" }, 409);
  });

  return app;
}

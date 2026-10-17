import { describe, it, expect, beforeAll, vi } from "vitest";

const sched = vi.hoisted(() => ({
  startGoal: vi.fn(), humanComment: vi.fn(async () => ({ id: "c1" })), pauseTeam: vi.fn(), continueTeam: vi.fn(),
  cancelTeam: vi.fn(), approveTaskGuard: vi.fn(async () => true), kickTeam: vi.fn(), resumeTeamsOnBoot: vi.fn(),
}));
vi.mock("../../src/server/equipo/team-scheduler.js", () => sched);

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { eq } = await import("drizzle-orm");
const { createGoal, createChildTask, addComment } = await import("../../src/server/equipo/tasks.js");
const ALC = { leer: ["x"], entrega: "breve" }; // alcance obligatorio al delegar
const { createEquipoRoute } = await import("../../src/server/routes/equipo.js");
const plansRoute = (await import("../../src/server/routes/plans.js")).default;

beforeAll(async () => { await migrationDone; });
const app = createEquipoRoute();
const post = (p: string, body: unknown = {}) => app.request(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("API humana del equipo", () => {
  it("POST / valida y arranca la meta", async () => {
    await db.insert(schema.projects).values({ id: "proy-equipo", name: "p", path: "C:/estudio/p" });
    sched.startGoal.mockResolvedValueOnce({ planId: "nuevo" });
    const r = await post("/", { pedido: "Haz algo", projectId: "proy-equipo" });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ id: "nuevo" });
    expect(sched.startGoal).toHaveBeenCalledWith({ pedido: "Haz algo", projectId: "proy-equipo" });
    expect((await post("/", { pedido: 5, projectId: "proy-equipo" })).status).toBe(400);
  });

  it("POST / exige un proyecto existente (sin él la meta escribiría en el repo del orquestador)", async () => {
    sched.startGoal.mockClear();
    expect((await post("/", { pedido: "Haz algo" })).status).toBe(400);
    expect((await post("/", { pedido: "Haz algo", projectId: null })).status).toBe(400);
    expect((await post("/", { pedido: "Haz algo", projectId: "no-existe" })).status).toBe(400);
    expect(sched.startGoal).not.toHaveBeenCalled();
  });

  it("GET /:id arma meta, árbol con estados y comentarios; GET / lista solo metas", async () => {
    const { planId, rootStepId } = await createGoal({ pedido: "La meta" });
    const a = (await createChildTask(planId, rootStepId, { rol: "dev", titulo: "Código", instrucciones: "haz", esperar: true, ...ALC })).id;
    await addComment(planId, a, "humano", "ojo");
    const r = await app.request(`/${planId}`);
    expect(r.status).toBe(200);
    const d = await r.json() as any;
    expect(d.meta).toMatchObject({ id: planId, pedido: "La meta", estado: "pending", presupuesto: 600000 });
    expect(d.tareas.map((t: any) => [t.rol, t.estado, t.parentId])).toEqual([["jefe", "esperando", null], ["dev", "en_cola", rootStepId]]);
    expect(d.tareas[0].cuenta).toBe("claude");
    expect(d.comentarios.map((c: any) => [c.tareaId, c.autor, c.texto])).toEqual([[a, "humano", "ojo"]]);
    const list = await (await app.request("/")).json() as any[];
    expect(list.some((m: any) => m.id === planId)).toBe(true);
    expect((await app.request("/no-existe")).status).toBe(404);
  });

  it("comentarios, pausar, continuar, cancelar y aprobar llaman al scheduler", async () => {
    const { planId, rootStepId } = await createGoal({ pedido: "m" });
    expect((await post(`/${planId}/comentarios`, { tareaId: rootStepId, texto: "hola" })).status).toBe(201);
    expect(sched.humanComment).toHaveBeenCalledWith(planId, rootStepId, "hola");
    await post(`/${planId}/pausar`); expect(sched.pauseTeam).toHaveBeenCalledWith(planId, "manual");
    await post(`/${planId}/continuar`); expect(sched.continueTeam).toHaveBeenCalledWith(planId);
    await post(`/${planId}/cancelar`); expect(sched.cancelTeam).toHaveBeenCalledWith(planId);
    expect((await post(`/${planId}/tareas/${rootStepId}/aprobar`)).status).toBe(200);
    sched.approveTaskGuard.mockResolvedValueOnce(false);
    expect((await post(`/${planId}/tareas/${rootStepId}/aprobar`)).status).toBe(409);
  });

  it("las rutas de planes no tocan metas de equipo y no las listan", async () => {
    const { planId } = await createGoal({ pedido: "m" });
    const r = await plansRoute.request(`/${planId}/run-all`, { method: "POST" });
    expect(r.status).toBe(409);
    const list = await (await plansRoute.request("/")).json() as any[];
    expect(list.some((p: any) => p.id === planId)).toBe(false);
    expect((await plansRoute.request(`/${planId}`, { method: "DELETE" })).status).toBe(200);
    expect(await db.select().from(schema.teamWakeups).where(eq(schema.teamWakeups.planId, planId))).toEqual([]);
    expect(sched.cancelTeam).toHaveBeenCalledWith(planId);
  });
});

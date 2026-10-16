import { describe, it, expect, beforeAll } from "vitest";

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { eq, and } = await import("drizzle-orm");
const t = await import("../../src/server/equipo/tasks.js");
const { parsePayload } = await import("../../src/server/equipo/wakeups.js");
const { MAX_TAREAS, MAX_PROFUNDIDAD } = await import("../../src/server/equipo/constants.js");

beforeAll(async () => { await migrationDone; });

const queued = async (stepId: string) =>
  (await db.select().from(schema.teamWakeups).where(and(eq(schema.teamWakeups.stepId, stepId), eq(schema.teamWakeups.status, "en_cola"))))[0];

describe("árbol de tareas", () => {
  it("createGoal: meta en modo equipo con raíz del Jefe (claude, Opus, sin escribir) y despertar asignada", async () => {
    const { planId, rootStepId } = await t.createGoal({ pedido: "Haz una landing" });
    const [plan] = await db.select().from(schema.plans).where(eq(schema.plans.id, planId));
    expect(plan).toMatchObject({ mode: "equipo", description: "Haz una landing", budgetTokens: 600000 });
    const root = (await t.getStep(rootStepId))!;
    expect(root).toMatchObject({ role: "jefe", adapter: "claude", model: "claude-opus-5-5", depth: 0, writes: 0, readOnly: 0, parentStepId: null });
    expect((await queued(rootStepId))?.reason).toBe("asignada");
    await expect(t.createGoal({ pedido: "" })).rejects.toMatchObject({ status: 400 });
  });

  it("createChildTask: rol válido, modelo del rol, esperar bloquea al padre; valida campos", async () => {
    const { planId, rootStepId } = await t.createGoal({ pedido: "m" });
    const { id } = await t.createChildTask(planId, rootStepId, { rol: "dev", titulo: "Código", instrucciones: "Escribe x", esperar: true });
    const kid = (await t.getStep(id))!;
    expect(kid).toMatchObject({ role: "dev", adapter: "agy", parentStepId: rootStepId, depth: 1, writes: 1, readOnly: 0, createdByStepId: rootStepId, description: "Código", prompt: "Escribe x" });
    expect(t.parseIds((await t.getStep(rootStepId))!.blockedBy)).toEqual([id]);
    const lector = await t.createChildTask(planId, rootStepId, { rol: "lector", titulo: "Lee", instrucciones: "Lee y" });
    expect((await t.getStep(lector.id))!).toMatchObject({ writes: 0, readOnly: 1 });
    expect(t.parseIds((await t.getStep(rootStepId))!.blockedBy)).toEqual([id]);
    for (const bad of [{ rol: "jefe", titulo: "a", instrucciones: "b" }, { rol: "nadie", titulo: "a", instrucciones: "b" }, { rol: "dev", titulo: "", instrucciones: "b" }, { rol: "dev", titulo: "a", instrucciones: "" }, { rol: "dev", titulo: "a", instrucciones: "b", esperar: "si" }]) {
      await expect(t.createChildTask(planId, rootStepId, bad)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("topes: profundidad y número de tareas → 409", async () => {
    const { planId, rootStepId } = await t.createGoal({ pedido: "m" });
    let parent = rootStepId;
    for (let d = 1; d <= MAX_PROFUNDIDAD; d++) parent = (await t.createChildTask(planId, parent, { rol: "dev", titulo: `n${d}`, instrucciones: "i" })).id;
    await expect(t.createChildTask(planId, parent, { rol: "dev", titulo: "x", instrucciones: "i" })).rejects.toMatchObject({ status: 409 });
    const g = await t.createGoal({ pedido: "m2" });
    for (let i = 1; i < MAX_TAREAS; i++) await t.createChildTask(g.planId, g.rootStepId, { rol: "lector", titulo: `t${i}`, instrucciones: "i" });
    await expect(t.createChildTask(g.planId, g.rootStepId, { rol: "lector", titulo: "otra", instrucciones: "i" })).rejects.toMatchObject({ status: 409 });
  });

  it("inSubtree: la tarea misma y sus descendientes sí; hermanos y padres no", async () => {
    const { planId, rootStepId } = await t.createGoal({ pedido: "m" });
    const a = (await t.createChildTask(planId, rootStepId, { rol: "dev", titulo: "a", instrucciones: "i" })).id;
    const b = (await t.createChildTask(planId, rootStepId, { rol: "dev", titulo: "b", instrucciones: "i" })).id;
    const a1 = (await t.createChildTask(planId, a, { rol: "qa", titulo: "a1", instrucciones: "i" })).id;
    expect(await t.inSubtree(a, a)).toBe(true);
    expect(await t.inSubtree(a, a1)).toBe(true);
    expect(await t.inSubtree(a, b)).toBe(false);
    expect(await t.inSubtree(a, rootStepId)).toBe(false);
  });

  it("comentarios: despiertan al dueño salvo el propio; @rol crea consulta; menciones apagadas no", async () => {
    const { planId, rootStepId } = await t.createGoal({ pedido: "m" });
    const a = (await t.createChildTask(planId, rootStepId, { rol: "dev", titulo: "a", instrucciones: "i" })).id;
    await db.update(schema.teamWakeups).set({ status: "hecho" }).where(eq(schema.teamWakeups.stepId, a));
    const propio = await t.addComment(planId, a, a, "nota mía");
    expect(await queued(a)).toBeUndefined();
    const humano = await t.addComment(planId, a, "humano", "¿y los tests? @qa revisa por favor");
    const w = (await queued(a))!;
    expect(parsePayload(w.payload).commentIds).toEqual([humano.id]);
    const kids = await t.childrenOf(a);
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({ role: "qa", reason: "consulta" });
    await t.addComment(planId, a, "humano", "sin consulta @qa", { menciones: false });
    expect(await t.childrenOf(a)).toHaveLength(1);
    expect(propio.id).toBeTruthy();
    await expect(t.addComment(planId, a, "humano", "x".repeat(4001))).rejects.toMatchObject({ status: 400 });
  });

  it("onTaskTerminal: con todas las hijas esperadas terminadas despierta al padre una vez y limpia blocked_by", async () => {
    const { planId, rootStepId } = await t.createGoal({ pedido: "m" });
    await db.update(schema.teamWakeups).set({ status: "hecho" }).where(eq(schema.teamWakeups.stepId, rootStepId));
    const a = (await t.createChildTask(planId, rootStepId, { rol: "dev", titulo: "a", instrucciones: "i", esperar: true })).id;
    const b = (await t.createChildTask(planId, rootStepId, { rol: "redactor", titulo: "b", instrucciones: "i", esperar: true })).id;
    await db.update(schema.planSteps).set({ status: "succeeded", result: "listo a" }).where(eq(schema.planSteps.id, a));
    await t.onTaskTerminal(planId, a);
    expect(await queued(rootStepId)).toBeUndefined();
    await db.update(schema.planSteps).set({ status: "failed", errorMessage: "se rompió" }).where(eq(schema.planSteps.id, b));
    await t.onTaskTerminal(planId, b);
    const w = (await queued(rootStepId))!;
    expect(w.reason).toBe("hijas_terminadas");
    expect(parsePayload(w.payload).childIds.sort()).toEqual([a, b].sort());
    expect(t.parseIds((await t.getStep(rootStepId))!.blockedBy)).toEqual([]);
  });

  it("onTaskTerminal: hija no esperada que falla deja un comentario automático; consulta responde con comentario", async () => {
    const { planId, rootStepId } = await t.createGoal({ pedido: "m" });
    const a = (await t.createChildTask(planId, rootStepId, { rol: "dev", titulo: "suelta", instrucciones: "i" })).id;
    await db.update(schema.planSteps).set({ status: "failed", errorMessage: "boom" }).where(eq(schema.planSteps.id, a));
    await t.onTaskTerminal(planId, a);
    const cs = await t.commentsFor(rootStepId, 10);
    expect(cs.at(-1)?.body).toMatch(/suelta.*falló.*boom/s);
    const c = (await t.createChildTask(planId, rootStepId, { rol: "qa", titulo: "Consulta", instrucciones: "¿pasa?" }, { consulta: true })).id;
    await db.update(schema.planSteps).set({ status: "succeeded", result: "sí pasa" }).where(eq(schema.planSteps.id, c));
    await t.onTaskTerminal(planId, c);
    expect((await t.commentsFor(rootStepId, 10)).at(-1)?.body).toMatch(/sí pasa/);
  });

  it("taskContext y estadoTarea", async () => {
    const { planId, rootStepId } = await t.createGoal({ pedido: "La meta" });
    const a = (await t.createChildTask(planId, rootStepId, { rol: "dev", titulo: "a", instrucciones: "haz a", esperar: true })).id;
    await t.addComment(planId, a, "humano", "ojo");
    const ctx = await t.taskContext(a);
    expect(ctx.meta).toEqual({ id: planId, pedido: "La meta" });
    expect(ctx.tarea).toMatchObject({ id: a, rol: "dev", titulo: "a", instrucciones: "haz a", estado: "en_cola" });
    expect(ctx.ancestros.map((x) => x.rol)).toEqual(["jefe"]);
    expect(ctx.comentarios.map((c) => [c.autor, c.texto])).toEqual([["humano", "ojo"]]);
    const root = (await t.getStep(rootStepId))!;
    expect(t.estadoTarea(root, await t.childrenOf(rootStepId))).toBe("esperando");
    expect(t.roleCatalog()).toMatch(/- dev:/);
    expect(t.roleCatalog()).not.toMatch(/- jefe:/);
  });
});

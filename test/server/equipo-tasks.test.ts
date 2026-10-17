import { describe, it, expect, beforeAll } from "vitest";

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { eq, and } = await import("drizzle-orm");
const t = await import("../../src/server/equipo/tasks.js");
const ALC = { leer: ["x"], entrega: "breve" }; // alcance obligatorio al delegar
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
    const { id } = await t.createChildTask(planId, rootStepId, { rol: "dev", titulo: "Código", instrucciones: "Escribe x", esperar: true, ...ALC });
    const kid = (await t.getStep(id))!;
    expect(kid).toMatchObject({ role: "dev", adapter: "agy", parentStepId: rootStepId, depth: 1, writes: 1, readOnly: 0, createdByStepId: rootStepId, description: "Código", prompt: expect.stringContaining("Escribe x") });
    expect(t.parseIds((await t.getStep(rootStepId))!.blockedBy)).toEqual([id]);
    const lector = await t.createChildTask(planId, rootStepId, { rol: "lector", titulo: "Lee", instrucciones: "Lee y", ...ALC });
    expect((await t.getStep(lector.id))!).toMatchObject({ writes: 0, readOnly: 1 });
    expect(t.parseIds((await t.getStep(rootStepId))!.blockedBy)).toEqual([id]);
    for (const bad of [{ rol: "jefe", titulo: "a", instrucciones: "b", ...ALC }, { rol: "nadie", titulo: "a", instrucciones: "b", ...ALC }, { rol: "dev", titulo: "", instrucciones: "b", ...ALC }, { rol: "dev", titulo: "a", instrucciones: "", ...ALC }, { rol: "dev", titulo: "a", instrucciones: "b", esperar: "si", ...ALC }]) {
      await expect(t.createChildTask(planId, rootStepId, bad)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("createChildTask exige leer y entrega y los guarda en el prompt", async () => {
    const { planId, rootStepId } = await t.createGoal({ pedido: "m" });
    const { id } = await t.createChildTask(planId, rootStepId, { rol: "lector", titulo: "Lee", instrucciones: "Resume x", leer: ["src/x.ts", " CLAUDE.md § Team mode (F14) "], entrega: "3 viñetas, máx 80 palabras" });
    expect((await t.getStep(id))!.prompt).toBe("Resume x\n\nLEE SOLO:\n- src/x.ts\n- CLAUDE.md § Team mode (F14)\n\nENTREGA: 3 viñetas, máx 80 palabras");
    const ok = { rol: "dev", titulo: "a", instrucciones: "b" };
    for (const bad of [
      { ...ok, entrega: "e" },                                  // sin leer
      { ...ok, leer: [], entrega: "e" },
      { ...ok, leer: "src/x.ts", entrega: "e" },                // no es arreglo
      { ...ok, leer: [""], entrega: "e" },
      { ...ok, leer: ["x".repeat(201)], entrega: "e" },
      { ...ok, leer: Array(11).fill("a"), entrega: "e" },
      { ...ok, leer: ["a"] },                                   // sin entrega
      { ...ok, leer: ["a"], entrega: "x".repeat(301) },
    ]) await expect(t.createChildTask(planId, rootStepId, bad)).rejects.toMatchObject({ status: 400 });
  });

  it("una consulta @rol no exige leer ni entrega", async () => {
    const { planId, rootStepId } = await t.createGoal({ pedido: "m" });
    const { id } = await t.createChildTask(planId, rootStepId, { rol: "qa", titulo: "Consulta", instrucciones: "¿pasa?" }, { consulta: true });
    expect((await t.getStep(id))!.prompt).toBe("¿pasa?");
  });

  it("childSummary avisa cuando el turno pasó del tope de tokens de entrada", () => {
    const base = { status: "succeeded", statusDetail: null, result: "ok", errorMessage: null } as any;
    expect(t.childSummary({ ...base, inputTokens: 60_001 })).toContain("AVISO: su último turno gastó 60001 tokens de entrada (tope 60000)");
    expect(t.childSummary({ ...base, inputTokens: 60_000 })).not.toContain("AVISO");
    expect(t.childSummary({ ...base, inputTokens: null })).toBe("succeeded: ok");
  });

  it("topes: profundidad y número de tareas → 409", async () => {
    const { planId, rootStepId } = await t.createGoal({ pedido: "m" });
    let parent = rootStepId;
    for (let d = 1; d <= MAX_PROFUNDIDAD; d++) parent = (await t.createChildTask(planId, parent, { rol: "dev", titulo: `n${d}`, instrucciones: "i", ...ALC })).id;
    await expect(t.createChildTask(planId, parent, { rol: "dev", titulo: "x", instrucciones: "i", ...ALC })).rejects.toMatchObject({ status: 409 });
    const g = await t.createGoal({ pedido: "m2" });
    for (let i = 1; i < MAX_TAREAS; i++) await t.createChildTask(g.planId, g.rootStepId, { rol: "lector", titulo: `t${i}`, instrucciones: "i", ...ALC });
    await expect(t.createChildTask(g.planId, g.rootStepId, { rol: "lector", titulo: "otra", instrucciones: "i", ...ALC })).rejects.toMatchObject({ status: 409 });
  });

  it("inSubtree: la tarea misma y sus descendientes sí; hermanos y padres no", async () => {
    const { planId, rootStepId } = await t.createGoal({ pedido: "m" });
    const a = (await t.createChildTask(planId, rootStepId, { rol: "dev", titulo: "a", instrucciones: "i", ...ALC })).id;
    const b = (await t.createChildTask(planId, rootStepId, { rol: "dev", titulo: "b", instrucciones: "i", ...ALC })).id;
    const a1 = (await t.createChildTask(planId, a, { rol: "qa", titulo: "a1", instrucciones: "i", ...ALC })).id;
    expect(await t.inSubtree(a, a)).toBe(true);
    expect(await t.inSubtree(a, a1)).toBe(true);
    expect(await t.inSubtree(a, b)).toBe(false);
    expect(await t.inSubtree(a, rootStepId)).toBe(false);
  });

  it("comentarios: despiertan al dueño salvo el propio; @rol crea consulta; menciones apagadas no", async () => {
    const { planId, rootStepId } = await t.createGoal({ pedido: "m" });
    const a = (await t.createChildTask(planId, rootStepId, { rol: "dev", titulo: "a", instrucciones: "i", ...ALC })).id;
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
    const a = (await t.createChildTask(planId, rootStepId, { rol: "dev", titulo: "a", instrucciones: "i", esperar: true, ...ALC })).id;
    const b = (await t.createChildTask(planId, rootStepId, { rol: "redactor", titulo: "b", instrucciones: "i", esperar: true, ...ALC })).id;
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
    const a = (await t.createChildTask(planId, rootStepId, { rol: "dev", titulo: "suelta", instrucciones: "i", ...ALC })).id;
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
    const a = (await t.createChildTask(planId, rootStepId, { rol: "dev", titulo: "a", instrucciones: "haz a", esperar: true, ...ALC })).id;
    await t.addComment(planId, a, "humano", "ojo");
    const ctx = await t.taskContext(a);
    expect(ctx.meta).toEqual({ id: planId, pedido: "La meta" });
    expect(ctx.tarea).toMatchObject({ id: a, rol: "dev", titulo: "a", instrucciones: expect.stringContaining("haz a"), estado: "en_cola" });
    expect(ctx.ancestros.map((x) => x.rol)).toEqual(["jefe"]);
    expect(ctx.comentarios.map((c) => [c.autor, c.texto])).toEqual([["humano", "ojo"]]);
    const root = (await t.getStep(rootStepId))!;
    expect(t.estadoTarea(root, await t.childrenOf(rootStepId))).toBe("esperando");
    expect(t.roleCatalog()).toMatch(/- dev:/);
    expect(t.roleCatalog()).not.toMatch(/- jefe:/);
  });

  it("delegaciones en paralelo con esperar: no se pierde ningún id y stepIndex/stepKey no se repiten", async () => {
    const { planId, rootStepId } = await t.createGoal({ pedido: "m" });
    const ids = (await Promise.all([1, 2, 3].map((i) => t.createChildTask(planId, rootStepId, { rol: "lector", titulo: `p${i}`, instrucciones: "i", esperar: true, ...ALC })))).map((r) => r.id);
    expect(t.parseIds((await t.getStep(rootStepId))!.blockedBy).sort()).toEqual([...ids].sort());
    const kids = await Promise.all(ids.map((id) => t.getStep(id)));
    expect(new Set(kids.map((k) => k!.stepIndex)).size).toBe(3);
    expect(new Set(kids.map((k) => k!.stepKey)).size).toBe(3);
  });

  it("onTaskTerminal concurrente: un solo despertar hijas_terminadas y blocked_by vacío", async () => {
    const { planId, rootStepId } = await t.createGoal({ pedido: "m" });
    await db.update(schema.teamWakeups).set({ status: "hecho" }).where(eq(schema.teamWakeups.stepId, rootStepId));
    const a = (await t.createChildTask(planId, rootStepId, { rol: "dev", titulo: "a", instrucciones: "i", esperar: true, ...ALC })).id;
    const b = (await t.createChildTask(planId, rootStepId, { rol: "dev", titulo: "b", instrucciones: "i", esperar: true, ...ALC })).id;
    await db.update(schema.planSteps).set({ status: "succeeded", result: "ok" }).where(eq(schema.planSteps.id, a));
    await db.update(schema.planSteps).set({ status: "succeeded", result: "ok" }).where(eq(schema.planSteps.id, b));
    await Promise.all([t.onTaskTerminal(planId, a), t.onTaskTerminal(planId, b), t.onTaskTerminal(planId, a)]);
    const rows = await db.select().from(schema.teamWakeups).where(and(eq(schema.teamWakeups.stepId, rootStepId), eq(schema.teamWakeups.status, "en_cola")));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("hijas_terminadas");
    expect(t.parseIds((await t.getStep(rootStepId))!.blockedBy)).toEqual([]);
  });

  it("menciones: título largo se recorta; en el tope de profundidad el comentario se guarda sin consulta; emails no mencionan", async () => {
    const { planId, rootStepId } = await t.createGoal({ pedido: "p".repeat(200) });
    const a = (await t.createChildTask(planId, rootStepId, { rol: "dev", titulo: "a", instrucciones: "i", ...ALC })).id;
    const largo = await t.addComment(planId, a, rootStepId, "revisa esto @qa");
    expect(largo.id).toBeTruthy();
    const [consulta] = await t.childrenOf(a);
    expect(consulta).toMatchObject({ role: "qa", reason: "consulta" });
    expect(consulta.description.length).toBeLessThanOrEqual(120);

    let parent = rootStepId;
    for (let d = 1; d <= MAX_PROFUNDIDAD; d++) parent = (await t.createChildTask(planId, parent, { rol: "dev", titulo: `n${d}`, instrucciones: "i", ...ALC })).id;
    expect((await t.addComment(planId, parent, "humano", "¿y esto? @qa")).id).toBeTruthy();
    expect(await t.childrenOf(parent)).toHaveLength(0);

    await t.addComment(planId, a, "humano", "escríbeme a a@dev.com o ve a /ruta/@qa/x");
    expect(await t.childrenOf(a)).toHaveLength(1);
  });
});

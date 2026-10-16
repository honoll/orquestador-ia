import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Adaptador falso: el Jefe delega por la API real (con el token de su env) y luego cierra; las hijas trabajan un rato.
const h = vi.hoisted(() => ({
  live: 0, maxLive: 0, jefeTurns: 0, agentApp: null as any, script: "delegar" as "delegar" | "tokens" | "lento",
  tareas: null as null | string[][], gate: null as Promise<void> | null, killed: 0, quota: false, subTarea: false,
}));
const delegar = async (ctx: any, rol: string, titulo: string, instrucciones: string) => {
  const r = await h.agentApp.request("/tareas", {
    method: "POST", headers: { Authorization: `Bearer ${ctx.env.ORQ_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ rol, titulo, instrucciones, esperar: true }),
  });
  if (r.status !== 201) throw new Error(`delegar falló ${r.status}`);
};
const ok = (summary: string, tokens = 10) => ({
  exitCode: 0, signal: null, timedOut: false, stdout: summary, stderr: "", summary, sessionId: `ses-${Math.random()}`, model: null,
  costUsd: 0, inputTokens: tokens, outputTokens: 0, errorMessage: null, errorFamily: null, retryNotBefore: null,
});
vi.mock("../../src/adapters/registry.js", () => {
  const jefe = async (ctx: any) => {
    h.jefeTurns++;
    if (h.script === "tokens") return ok("gasté\n<<<ESTADO terminado>>>", 1000);
    // Corre hasta que lo maten (cancelar con un turno en curso).
    if (h.script === "lento") return new Promise((resolve) => ctx.onKill?.(() => { h.killed++; resolve({ ...ok("cortado"), exitCode: 1, stderr: "matado" }); }));
    if (h.jefeTurns === 1) {
      const tareas = h.tareas ?? [["dev", "Código", "haz Código"], ["redactor", "Textos", "haz Textos"], ["dev", "Estilos", "haz Estilos"]];
      for (const [rol, titulo, instrucciones] of tareas) await delegar(ctx, rol, titulo, instrucciones);
      return ok(`Repartí ${tareas.length} tareas.\n<<<ESTADO terminado>>>`);
    }
    return ok(`Respuesta final con ${ctx.prompt.includes("terminaron las tareas que esperabas") ? "resúmenes" : "nada"}\n<<<ESTADO terminado>>>`);
  };
  const agy = async (ctx: any) => {
    if (h.quota) return { ...ok(""), exitCode: 1, errorFamily: "quota_exhausted", errorMessage: "quota exhausted" };
    // Primer turno de la tarea que hace push: delega y espera una subtarea (así tiene un segundo turno).
    if (h.subTarea && ctx.prompt.includes("git push origin main")) {
      await delegar(ctx, "redactor", "Nota", "escribe una nota");
      return ok("delegué\n<<<ESTADO terminado>>>");
    }
    h.live++; h.maxLive = Math.max(h.maxLive, h.live);
    await (h.gate ?? new Promise((r) => setTimeout(r, 40)));
    h.live--;
    return ok("hecho\n<<<ESTADO terminado>>>");
  };
  const mk = (type: string, execute: any) => ({ meta: { type }, detect: async () => ({ available: true, resolvedPath: "x" }), execute });
  return { getAdapter: (t: string) => (t === "claude" ? mk("claude", jefe) : t === "agy" ? mk("agy", agy) : undefined), adapters: {} };
});

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { eq } = await import("drizzle-orm");
const { createAccount } = await import("../../src/server/agy-accounts.js");
const { createWorker, pickWorker } = await import("../../src/server/agy-workers.js");
const sched = await import("../../src/server/equipo/team-scheduler.js");
const { createEquipoAgenteRoute } = await import("../../src/server/routes/equipo-agente.js");
const { createChildTask, createGoal, getStep } = await import("../../src/server/equipo/tasks.js");

let projectId = "";
beforeAll(async () => {
  await migrationDone;
  await createAccount("Local");
  for (const [i, label] of ["w2", "w3"].entries()) {
    const a = await createAccount(label);
    await createWorker({ accountId: a.id, port: 39100 + i, keyPath: `C:/k/${label}.key` });
  }
  projectId = randomUUID();
  await db.insert(schema.projects).values({ id: projectId, name: "demo", path: fs.mkdtempSync(path.join(os.tmpdir(), "equipo-")) });
  h.agentApp = createEquipoAgenteRoute(sched.kickTeam);
});
beforeEach(() => {
  Object.assign(h, { live: 0, maxLive: 0, jefeTurns: 0, script: "delegar", tareas: null, gate: null, killed: 0, quota: false, subTarea: false });
});

const plan = async (id: string) => (await db.select().from(schema.plans).where(eq(schema.plans.id, id)))[0];

describe("scheduler del equipo", () => {
  it("el Jefe delega 3 tareas que corren en paralelo, despierta con los resúmenes y cierra la meta", async () => {
    const { planId, rootStepId } = await createGoal({ pedido: "Haz una landing", projectId });
    await sched.runTeam(planId);
    const p = await plan(planId);
    expect(p.status).toBe("completed");
    expect(p.synthesis).toMatch(/Respuesta final con resúmenes/);
    expect(h.jefeTurns).toBe(2);
    expect(h.maxLive).toBeGreaterThanOrEqual(2);
    const kids = await db.select().from(schema.planSteps).where(eq(schema.planSteps.parentStepId, rootStepId));
    expect(kids.map((k) => k.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect((await getStep(rootStepId))!.turns).toBe(2);
    expect(await db.select().from(schema.teamRunTokens).where(eq(schema.teamRunTokens.planId, planId))).toEqual([]);
    const wk = await db.select().from(schema.teamWakeups).where(eq(schema.teamWakeups.planId, planId));
    expect(wk.filter((w) => w.status === "en_cola" || w.status === "tomado")).toEqual([]);
    await sched.cancelTeam(planId); // una meta cerrada no se reescribe
    expect((await plan(planId)).status).toBe("completed");
  });

  it("presupuesto agotado pausa la meta; continuar sube el tope y la termina", async () => {
    h.script = "tokens";
    const g = await createGoal({ pedido: "m2", projectId });
    await db.update(schema.plans).set({ budgetTokens: 1, usedTokens: 5 }).where(eq(schema.plans.id, g.planId));
    await sched.runTeam(g.planId);
    expect(await plan(g.planId)).toMatchObject({ status: "pending", pauseReason: "budget" });
    await sched.continueTeam(g.planId);
    await vi.waitFor(async () => expect((await plan(g.planId)).status).toBe("completed"), { timeout: 5000 });
    expect((await plan(g.planId)).budgetTokens).toBeGreaterThan(1);
  });

  it("cancelar deja la meta y sus tareas canceladas y la cola vacía", async () => {
    const { planId } = await createGoal({ pedido: "m", projectId });
    await sched.cancelTeam(planId);
    expect((await plan(planId)).status).toBe("cancelled");
    const steps = await db.select().from(schema.planSteps).where(eq(schema.planSteps.planId, planId));
    expect(steps.every((s) => s.status === "cancelled")).toBe(true);
    const wk = await db.select().from(schema.teamWakeups).where(eq(schema.teamWakeups.planId, planId));
    expect(wk.every((w) => w.status !== "en_cola")).toBe(true);
  });

  it("una tarea que llega a MAX_TURNOS_TAREA falla sin correr", async () => {
    const { planId, rootStepId } = await createGoal({ pedido: "m", projectId });
    await db.update(schema.planSteps).set({ turns: 8 }).where(eq(schema.planSteps.id, rootStepId));
    await sched.runTeam(planId);
    expect((await getStep(rootStepId))!).toMatchObject({ status: "failed", statusDetail: "demasiados turnos" });
    expect((await plan(planId)).status).toBe("failed");
    expect(h.jefeTurns).toBe(0);
  });

  it("resumeTeamsOnBoot: turnos huérfanos vuelven a la cola con 'continuar'", async () => {
    const { planId, rootStepId } = await createGoal({ pedido: "m", projectId });
    await db.update(schema.plans).set({ status: "running" }).where(eq(schema.plans.id, planId));
    await db.update(schema.planSteps).set({ status: "running" }).where(eq(schema.planSteps.id, rootStepId));
    await db.update(schema.teamWakeups).set({ status: "tomado" }).where(eq(schema.teamWakeups.planId, planId));
    await sched.resumeTeamsOnBoot();
    await vi.waitFor(async () => expect((await plan(planId)).status).toBe("completed"), { timeout: 5000 });
  });

  it("una tarea que espera cuenta no tapa los despertares de atrás (el Jefe corre sin cuenta agy)", async () => {
    h.script = "tokens";
    const { planId, rootStepId } = await createGoal({ pedido: "m", projectId });
    await createChildTask(planId, rootStepId, { rol: "dev", titulo: "Código", instrucciones: "haz" });
    // El despertar del Jefe queda detrás del de la hija.
    await db.update(schema.teamWakeups).set({ createdAt: "2999-01-01T00:00:00.000Z" }).where(eq(schema.teamWakeups.stepId, rootStepId));
    const leases = [];
    for (let l = await pickWorker(); l; l = await pickWorker()) leases.push(l);
    expect(leases.length).toBe(3);
    try {
      await sched.runTeam(planId);
    } finally { for (const l of leases) l.release(); }
    expect((await plan(planId)).status).toBe("completed");
    expect(h.jefeTurns).toBe(1);
  });

  it("runTeam sobre un plan de pasos 'running' sale y no se vuelve a arrancar solo", async () => {
    const id = randomUUID();
    await db.insert(schema.plans).values({ id, description: "plan de pasos", status: "running" });
    await sched.runTeam(id);
    for (let i = 0; i < 10; i++) {
      expect(sched.isTeamRunning(id)).toBe(false);
      await new Promise((r) => setTimeout(r, 5));
    }
    await expect(sched.humanComment(id, "x", "hola")).rejects.toMatchObject({ status: 404 });
    expect((await plan(id)).status).toBe("running");
  });

  it("cancelar con un turno en curso lo mata, deja la tarea cancelada y la meta cancelada", async () => {
    h.script = "lento";
    const { planId, rootStepId } = await createGoal({ pedido: "m", projectId });
    const done = sched.runTeam(planId);
    await vi.waitFor(() => expect(h.jefeTurns).toBe(1));
    await sched.cancelTeam(planId);
    await done;
    expect(h.killed).toBe(1);
    expect((await getStep(rootStepId))!.status).toBe("cancelled");
    expect(await plan(planId)).toMatchObject({ status: "cancelled", pauseReason: null });
  });

  it("pausar y continuar mientras un turno sigue en curso no deja la meta colgada", async () => {
    h.tareas = [["dev", "Código", "haz Código"]];
    let open!: () => void;
    h.gate = new Promise<void>((r) => { open = r; });
    const { planId, rootStepId } = await createGoal({ pedido: "m", projectId });
    const done = sched.runTeam(planId);
    await vi.waitFor(async () => { expect(h.live).toBe(1); expect((await getStep(rootStepId))!.status).toBe("pending"); });
    await sched.pauseTeam(planId, "manual");
    await new Promise((r) => setTimeout(r, 50)); // el bucle sale y se queda drenando el turno de la hija
    await sched.continueTeam(planId);
    open();
    await done;
    await vi.waitFor(async () => expect((await plan(planId)).status).toBe("completed"), { timeout: 5000 });
    expect(h.jefeTurns).toBe(2);
  });

  it("sin cuota en ninguna bolsa el turno se devuelve (no gasta turno) y la meta pausa por cuota", async () => {
    h.quota = true;
    const { planId, rootStepId } = await createGoal({ pedido: "m", projectId });
    await db.update(schema.planSteps).set({ adapter: "agy" }).where(eq(schema.planSteps.id, rootStepId));
    try {
      await sched.runTeam(planId);
      expect(await plan(planId)).toMatchObject({ status: "pending", pauseReason: "quota" });
      expect((await getStep(rootStepId))!).toMatchObject({ status: "pending", turns: 0 });
      const wk = await db.select().from(schema.teamWakeups).where(eq(schema.teamWakeups.planId, planId));
      expect(wk.map((w) => w.status)).toEqual(["en_cola"]);
    } finally {
      await db.update(schema.agyAccounts).set({ quotaBlockedUntil: null, quotaBlockedAt: null, calibratedLimit5h: null });
      await sched.cancelTeam(planId);
    }
  });

  it("la guardia (sin JEV) pausa la tarea con git push; aprobada corre y no vuelve a pausar en su siguiente turno", async () => {
    h.tareas = [["dev", "Publicar", "haz el cambio y luego git push origin main"]];
    h.subTarea = true;
    const { planId, rootStepId } = await createGoal({ pedido: "m", projectId });
    await sched.runTeam(planId);
    expect(await plan(planId)).toMatchObject({ status: "pending", pauseReason: "guard" });
    const [kid] = await db.select().from(schema.planSteps).where(eq(schema.planSteps.parentStepId, rootStepId));
    expect(kid).toMatchObject({ status: "pending", turns: 0 });
    expect(kid.guardFlags).toMatch(/git/);
    expect(await sched.approveTaskGuard(planId, kid.id)).toBe(true);
    await vi.waitFor(async () => expect((await plan(planId)).status).toBe("completed"), { timeout: 5000 });
    expect((await getStep(kid.id))!).toMatchObject({ status: "succeeded", turns: 2, guardApproved: 1 });
    expect((await plan(planId)).pauseReason).toBeNull();
  });
});

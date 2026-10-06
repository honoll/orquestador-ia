import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({ runPlanDag: vi.fn(async () => {}), running: new Set<string>(), retrySynthesis: vi.fn(async () => true), cancelPlanRun: vi.fn(() => true) }));
vi.mock("../../src/server/plan-scheduler.js", () => ({
  runPlanDag: h.runPlanDag,
  isPlanRunning: (id: string) => h.running.has(id),
  cancelPlanRun: h.cancelPlanRun,
  retrySynthesis: h.retrySynthesis,
}));

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { default: plansRoute } = await import("../../src/server/routes/plans.js");
const { eq } = await import("drizzle-orm");

beforeAll(async () => { await migrationDone; });

async function mk(extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.insert(schema.plans).values({ id, description: "d", status: "pending", ...extra } as any);
  return id;
}
async function mkStep(planId: string, extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.insert(schema.planSteps).values({ id, planId, stepIndex: 0, description: "x", adapter: "codex", prompt: "p", status: "pending", ...extra } as any);
  return id;
}
const getPlanRow = (id: string) => db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((x) => x[0]);
const getStep = (id: string) => db.select().from(schema.planSteps).where(eq(schema.planSteps.id, id)).then((x) => x[0]);
const req = (path: string, method = "POST", body?: unknown) =>
  plansRoute.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

describe("rutas de planes (F2)", () => {
  it("run-all usa el planificador; 409 si ya corre", async () => {
    const id = await mk();
    expect((await req(`/${id}/run-all`)).status).toBe(202);
    expect(h.runPlanDag).toHaveBeenCalledWith(id, expect.any(String), { mode: "all" });
    h.running.add(id);
    expect((await req(`/${id}/run-all`)).status).toBe(409);
    h.running.delete(id);
  });

  it("run-next usa modo next", async () => {
    const id = await mk();
    await db.insert(schema.planSteps).values({ id: randomUUID(), planId: id, stepIndex: 0, description: "x", adapter: "codex", prompt: "p", status: "pending" });
    await req(`/${id}/run-next`);
    expect(h.runPlanDag).toHaveBeenLastCalledWith(id, expect.any(String), { mode: "next" });
  });

  it("settings valida y guarda tope y paralelismo", async () => {
    const id = await mk();
    expect((await req(`/${id}/settings`, "PATCH", { maxParallel: 9 })).status).toBe(400);
    expect((await req(`/${id}/settings`, "PATCH", { budgetTokens: -1 })).status).toBe(400);
    const r = await req(`/${id}/settings`, "PATCH", { budgetTokens: 50000, maxParallel: 2 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ budgetTokens: 50000, maxParallel: 2 });
    expect(((await (await req(`/${id}/settings`, "PATCH", { budgetTokens: null })).json()) as { budgetTokens: unknown }).budgetTokens).toBeNull();
  });

  it("continue tras pausa por presupuesto sube el tope 50 % sobre lo usado y relanza", async () => {
    const id = await mk({ pauseReason: "budget", budgetTokens: 80000, usedTokens: 85000 });
    const r = await req(`/${id}/continue`);
    expect(r.status).toBe(202);
    expect(((await r.json()) as { budgetTokens: number }).budgetTokens).toBe(127500);
    const p = await db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((x) => x[0]);
    expect(p.budgetTokens).toBe(127500);
    expect(h.runPlanDag).toHaveBeenLastCalledWith(id, expect.any(String), { mode: "all" });
  });

  it("synthesis/retry llama retrySynthesis; 409 si corre", async () => {
    const id = await mk({ status: "completed", synthesisStatus: "failed" });
    expect((await req(`/${id}/synthesis/retry`)).status).toBe(202);
    expect(h.retrySynthesis).toHaveBeenCalledWith(id);
    h.running.add(id);
    expect((await req(`/${id}/synthesis/retry`)).status).toBe(409);
    h.running.delete(id);
  });

  it("cancel mata el plan en curso y marca running/pending como cancelled", async () => {
    const id = await mk({ status: "running", synthesisStatus: "running", synthesis: "previa", pauseReason: "budget" });
    await db.insert(schema.planSteps).values({ id: randomUUID(), planId: id, stepIndex: 0, description: "x", adapter: "codex", prompt: "p", status: "running" });
    expect((await req(`/${id}/cancel`)).status).toBe(200);
    expect(h.cancelPlanRun).toHaveBeenCalledWith(id);
    const s = await db.select().from(schema.planSteps).where(eq(schema.planSteps.planId, id));
    expect(s[0].status).toBe("cancelled");
    const p = await db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((x) => x[0]);
    expect(p.status).toBe("cancelled");
    expect(p.synthesisStatus).toBeNull();
    expect(p.synthesis).toBe("previa");
    expect(p.pauseReason).toBeNull();
  });

  it("resume pone en pending los pasos failed/cancelled/running y borra la síntesis vieja", async () => {
    const id = await mk({ status: "failed", synthesisStatus: "failed", synthesis: "vieja", synthesisError: "x" });
    const t = new Date().toISOString();
    const ids = [
      await mkStep(id, { stepIndex: 0, status: "succeeded" }),
      await mkStep(id, { stepIndex: 1, status: "failed", errorMessage: "boom", startedAt: t, finishedAt: t }),
      await mkStep(id, { stepIndex: 2, status: "cancelled", startedAt: t, finishedAt: t }),
      await mkStep(id, { stepIndex: 3, status: "running", startedAt: t }),
    ];
    expect((await req(`/${id}/resume`)).status).toBe(202);
    const rows = await Promise.all(ids.map(getStep));
    expect(rows.map((r) => r.status)).toEqual(["succeeded", "pending", "pending", "pending"]);
    for (const r of rows.slice(1)) expect(r).toMatchObject({ errorMessage: null, startedAt: null, finishedAt: null });
    expect(await getPlanRow(id)).toMatchObject({ synthesisStatus: null, synthesis: null, synthesisError: null });
  });

  it("run-all de un plan cancelado o fallido reanuda los pasos que no terminaron; de un plan pending no", async () => {
    const cancelled = await mk({ status: "cancelled" });
    const s1 = await mkStep(cancelled, { status: "cancelled" });
    await req(`/${cancelled}/run-all`);
    expect((await getStep(s1)).status).toBe("pending");
    const failed = await mk({ status: "failed" });
    const s2 = await mkStep(failed, { status: "failed", errorMessage: "boom" });
    await req(`/${failed}/run-all`);
    expect(await getStep(s2)).toMatchObject({ status: "pending", errorMessage: null });
    const pending = await mk({ status: "pending" });
    const s3 = await mkStep(pending, { status: "failed" });
    await req(`/${pending}/run-all`);
    expect((await getStep(s3)).status).toBe("failed");
  });

  it("run-all de un plan pending con un paso cancelado lo reanuda", async () => {
    const id = await mk({ status: "pending" });
    await mkStep(id, { stepIndex: 0, stepKey: "s1", dependsOn: "[]", status: "succeeded" });
    const s2 = await mkStep(id, { stepIndex: 1, stepKey: "s2", dependsOn: JSON.stringify(["s1"]), status: "cancelled" });
    h.runPlanDag.mockClear();
    expect((await req(`/${id}/run-all`)).status).toBe(202);
    expect((await getStep(s2)).status).toBe("pending");
    expect(h.runPlanDag).toHaveBeenCalledTimes(1);
  });

  it("run-next sin pasos pending pero con cancelados los resetea y lanza", async () => {
    const id = await mk({ status: "pending" });
    await mkStep(id, { stepIndex: 0, stepKey: "s1", dependsOn: "[]", status: "succeeded" });
    const s2 = await mkStep(id, { stepIndex: 1, stepKey: "s2", dependsOn: JSON.stringify(["s1"]), status: "cancelled" });
    h.runPlanDag.mockClear();
    const r = await req(`/${id}/run-next`);
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ ok: true, stepId: s2 });
    expect((await getStep(s2)).status).toBe("pending");
    expect(h.runPlanDag).toHaveBeenCalledTimes(1);
  });

  it("reintentar un paso borra la síntesis vieja", async () => {
    const id = await mk({ status: "completed", synthesisStatus: "succeeded", synthesis: "vieja" });
    const s = await mkStep(id, { status: "failed" });
    expect((await req(`/${id}/steps/${s}/retry`)).status).toBe(202);
    expect((await getStep(s)).status).toBe("pending");
    expect(await getPlanRow(id)).toMatchObject({ synthesisStatus: null, synthesis: null, synthesisError: null });
  });

  it("run-next responde el paso que el planificador puede arrancar, o blocked sin lanzar", async () => {
    const id = await mk();
    await mkStep(id, { stepIndex: 0, stepKey: "s1", dependsOn: JSON.stringify(["s2"]) });
    const s2 = await mkStep(id, { stepIndex: 1, stepKey: "s2", dependsOn: "[]" });
    const r = await req(`/${id}/run-next`);
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ ok: true, stepId: s2 });

    const blocked = await mk();
    await mkStep(blocked, { stepIndex: 0, stepKey: "s1", dependsOn: "[]", status: "cancelled" });
    await mkStep(blocked, { stepIndex: 1, stepKey: "s2", dependsOn: JSON.stringify(["s1"]) });
    h.runPlanDag.mockClear();
    const b = await req(`/${blocked}/run-next`);
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({ done: false, blocked: true });
    expect(h.runPlanDag).not.toHaveBeenCalled();
  });

  it("synthesis/retry solo para un plan completado con síntesis fallida", async () => {
    for (const extra of [{ status: "pending", synthesisStatus: "failed" }, { status: "completed", synthesisStatus: "succeeded" }, { status: "completed" }]) {
      const id = await mk(extra);
      const r = await req(`/${id}/synthesis/retry`);
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: "Solo se puede reintentar una síntesis fallida de un plan completado" });
    }
  });

  it("DELETE cancela la corrida antes de borrar", async () => {
    const id = await mk({ status: "running" });
    h.cancelPlanRun.mockClear();
    expect((await req(`/${id}`, "DELETE")).status).toBe(200);
    expect(h.cancelPlanRun).toHaveBeenCalledWith(id);
    expect(await getPlanRow(id)).toBeUndefined();
  });

  it("PATCH del plan solo acepta projectId; el resto se ignora", async () => {
    const id = await mk();
    const r = await req(`/${id}`, "PATCH", { projectId: null, status: "completed", usedTokens: 5 });
    expect(r.status).toBe(200);
    expect(await getPlanRow(id)).toMatchObject({ status: "pending", usedTokens: 0, projectId: null });
  });

  it("PATCH de un paso solo acepta description/adapter/model/prompt y valida el adapter", async () => {
    const id = await mk();
    const s = await mkStep(id);
    expect((await req(`/${id}/steps/${s}`, "PATCH", { adapter: "gpt" })).status).toBe(400);
    const r = await req(`/${id}/steps/${s}`, "PATCH", { prompt: "nuevo", adapter: "claude", model: "claude-opus-5-5", description: "d2", status: "succeeded", result: "falso" });
    expect(r.status).toBe(200);
    expect(await getStep(s)).toMatchObject({ prompt: "nuevo", adapter: "claude", model: "claude-opus-5-5", description: "d2", status: "pending", result: null });
  });
});

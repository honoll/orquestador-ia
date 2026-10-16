import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { eq } = await import("drizzle-orm");
const w = await import("../../src/server/equipo/wakeups.js");

beforeAll(async () => { await migrationDone; });

async function plan() {
  const planId = randomUUID();
  await db.insert(schema.plans).values({ id: planId, description: "m", mode: "equipo" });
  const step = async (status: "pending" | "running" | "succeeded" | "cancelled" = "pending") => {
    const id = randomUUID();
    await db.insert(schema.planSteps).values({ id, planId, stepIndex: 0, description: "t", adapter: "agy", prompt: "p", status });
    return id;
  };
  return { planId, step };
}

describe("despertares", () => {
  it("fusiona: un solo despertar en cola por tarea con los motivos y ids unidos", async () => {
    const { planId, step } = await plan();
    const s = await step();
    const a = await w.enqueueWakeup(planId, s, "asignada");
    const b = await w.enqueueWakeup(planId, s, "comentario", { commentIds: ["c1"] });
    const c = await w.enqueueWakeup(planId, s, "comentario", { commentIds: ["c1", "c2"] });
    expect(b).toBe(a);
    expect(c).toBe(a);
    const rows = await db.select().from(schema.teamWakeups).where(eq(schema.teamWakeups.stepId, s));
    expect(rows).toHaveLength(1);
    expect(w.parsePayload(rows[0].payload)).toEqual({ reasons: ["asignada", "comentario"], commentIds: ["c1", "c2"], childIds: [] });
  });

  it("toma el más viejo cuya tarea no corre ni está en skip; una tarea cancelada cancela su despertar", async () => {
    const { planId, step } = await plan();
    const corre = await step("running");
    const cancelada = await step("cancelled");
    const libre = await step();
    const otra = await step();
    await w.enqueueWakeup(planId, corre, "asignada", {}, new Date(1));
    await w.enqueueWakeup(planId, cancelada, "asignada", {}, new Date(2));
    await w.enqueueWakeup(planId, libre, "asignada", {}, new Date(3));
    await w.enqueueWakeup(planId, otra, "asignada", {}, new Date(4));
    const got = await w.claimWakeup(planId, new Set([libre]));
    expect(got?.stepId).toBe(otra);
    expect(got?.status).toBe("tomado");
    const [c] = await db.select().from(schema.teamWakeups).where(eq(schema.teamWakeups.stepId, cancelada));
    expect(c.status).toBe("cancelado");
    expect(await w.hasQueuedFor(corre)).toBe(true);
    expect(await w.hasQueuedFor(otra)).toBe(false);
  });

  it("requeue vuelve a la cola (o se fusiona si llegó otro); finish y cancelPlan cierran", async () => {
    const { planId, step } = await plan();
    const s = await step();
    await w.enqueueWakeup(planId, s, "asignada");
    const t = (await w.claimWakeup(planId))!;
    await w.enqueueWakeup(planId, s, "comentario", { commentIds: ["x"] });
    await w.requeueWakeup(t.id);
    const rows = await db.select().from(schema.teamWakeups).where(eq(schema.teamWakeups.stepId, s));
    const queued = rows.filter((r) => r.status === "en_cola");
    expect(queued).toHaveLength(1);
    expect(w.parsePayload(queued[0].payload).reasons).toEqual(["comentario", "asignada"]);
    expect(await w.hasQueued(planId)).toBe(true);
    await w.cancelPlanWakeups(planId);
    expect(await w.hasQueued(planId)).toBe(false);
  });

  it("cinco encolados simultáneos de la misma tarea dejan un solo despertar", async () => {
    const { planId, step } = await plan();
    const s = await step();
    const ids = await Promise.all([1, 2, 3, 4, 5].map((i) => w.enqueueWakeup(planId, s, "comentario", { commentIds: [`c${i}`] })));
    expect(new Set(ids).size).toBe(1);
    const rows = await db.select().from(schema.teamWakeups).where(eq(schema.teamWakeups.stepId, s));
    expect(rows.filter((r) => r.status === "en_cola")).toHaveLength(1);
    expect(w.parsePayload(rows[0].payload).commentIds.sort()).toEqual(["c1", "c2", "c3", "c4", "c5"]);
  });

  it("dos claim simultáneos sobre un despertar: uno lo toma y el otro recibe null", async () => {
    const { planId, step } = await plan();
    await w.enqueueWakeup(planId, await step(), "asignada");
    const got = await Promise.all([w.claimWakeup(planId), w.claimWakeup(planId)]);
    expect(got.filter((g) => g !== null)).toHaveLength(1);
    expect(got.filter((g) => g === null)).toHaveLength(1);
  });

  it("requeue después de cancelPlanWakeups no revive el despertar", async () => {
    const { planId, step } = await plan();
    await w.enqueueWakeup(planId, await step(), "asignada");
    const t = (await w.claimWakeup(planId))!;
    await w.cancelPlanWakeups(planId);
    await w.requeueWakeup(t.id);
    const [row] = await db.select().from(schema.teamWakeups).where(eq(schema.teamWakeups.id, t.id));
    expect(row.status).toBe("cancelado");
    expect(await w.hasQueued(planId)).toBe(false);
  });

  it("parsePayload tolera basura", () => {
    expect(w.parsePayload("no json")).toEqual({ reasons: [], commentIds: [], childIds: [] });
    expect(w.parsePayload(null)).toEqual({ reasons: [], commentIds: [], childIds: [] });
  });
});

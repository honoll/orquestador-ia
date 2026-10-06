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
});

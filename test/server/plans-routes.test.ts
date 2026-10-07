import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({ runPlanDag: vi.fn(async () => {}), running: new Set<string>(), retrySynthesis: vi.fn(async () => true), cancelPlanRun: vi.fn(() => true),
  gate: null as Promise<void> | null,
  indexVault: vi.fn(async () => ({ scanned: 0, updated: 0, removed: 0, chunks: 0, failed: false })),
  retrieveMemory: vi.fn(async () => ({
    notes: [{ path: "Proyectos/x.md", title: "x", score: 0.8, projectNote: true, excerpt: "EXTRACTO-SECRETO" }],
    source: "semantic" as const,
  })),
  tier: { tier: "normal", confidence: null, source: "fallback" } as { tier: string; confidence: number | null; source: string },
  generatePlan: vi.fn(async () => ({
    steps: [{ stepIndex: 0, key: "s1", dependsOn: [], writes: false, estimatedTokens: 1000, description: "paso", adapter: "codex", model: "m", reason: "r", prompt: "p" }],
    estimatedTokens: 1000,
  })),
}));
vi.mock("../../src/server/plan-tier.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/server/plan-tier.js")>("../../src/server/plan-tier.js");
  return { ...actual, classifyTier: vi.fn(async () => { if (h.gate) await h.gate; return h.tier; }), trivialWrites: vi.fn(async () => false) };
});
vi.mock("../../src/server/planner.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/server/planner.js")>("../../src/server/planner.js");
  return { ...actual, generatePlan: h.generatePlan };
});
vi.mock("../../src/memory/vault-index.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/memory/vault-index.js")>("../../src/memory/vault-index.js");
  return { ...actual, indexVault: h.indexVault };
});
vi.mock("../../src/memory/retrieve.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/memory/retrieve.js")>("../../src/memory/retrieve.js");
  return { ...actual, retrieveMemory: h.retrieveMemory };
});
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
const tierMod = await import("../../src/server/plan-tier.js");

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

afterEach(() => { h.tier = { tier: "normal", confidence: null, source: "fallback" }; h.gate = null; });

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

  it("PATCH de paso: cambiar el prompt anula la aprobación de la guardia", async () => {
    const id = await mk();
    const stepId = randomUUID();
    await db.insert(schema.planSteps).values({ id: stepId, planId: id, stepIndex: 0, description: "x", adapter: "codex", prompt: "p", status: "pending", guardApproved: 1, guardFlags: "[]" });
    const r = await req(`/${id}/steps/${stepId}`, "PATCH", { prompt: "otro" });
    expect(await r.json()).toMatchObject({ prompt: "otro", guardApproved: 0, guardFlags: null });
  });

  it("PATCH de paso: cambiar el prompt de un plan en pausa de guardia quita la pausa", async () => {
    const id = await mk({ pauseReason: "guard" });
    const s = await mkStep(id, { guardFlags: "[]" });
    await req(`/${id}/steps/${s}`, "PATCH", { description: "solo descripción" });
    expect((await getPlanRow(id)).pauseReason).toBe("guard");
    await req(`/${id}/steps/${s}`, "PATCH", { prompt: "otro" });
    expect((await getPlanRow(id)).pauseReason).toBeNull();
    const budget = await mk({ pauseReason: "budget" });
    const s2 = await mkStep(budget);
    await req(`/${budget}/steps/${s2}`, "PATCH", { prompt: "otro" });
    expect((await getPlanRow(budget)).pauseReason).toBe("budget");
  });

  it("trivial: un paso agy, sin Opus, y arranca solo", async () => {
    h.generatePlan.mockClear();
    h.tier = { tier: "trivial", confidence: 0.95, source: "jev" };
    const r = await req("/", "POST", { description: "resume a.txt" });
    const { id } = (await r.json()) as { id: string };
    await vi.waitFor(async () => expect(h.runPlanDag).toHaveBeenCalledWith(id, expect.any(String), { mode: "all" }));
    expect(h.generatePlan).not.toHaveBeenCalled();
    const steps = await db.select().from(schema.planSteps).where(eq(schema.planSteps.planId, id));
    expect(steps).toHaveLength(1);
    // trivialWrites → false: solo lee, así que corre sin permisos de escritura.
    expect(steps[0]).toMatchObject({ adapter: "agy", model: "gemini-3.8-flash-low", stepKey: "s1", writes: 0, readOnly: 1 });
    const p = await db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((x) => x[0]);
    expect(p).toMatchObject({ tier: "trivial", tierSource: "jev", status: "pending" });
  });

  it("trivial que escribe: readOnly 0", async () => {
    h.tier = { tier: "trivial", confidence: 0.95, source: "jev" };
    vi.mocked(tierMod.trivialWrites).mockResolvedValueOnce(true);
    const r = await req("/", "POST", { description: "corrige el typo en a.txt" });
    const { id } = (await r.json()) as { id: string };
    await vi.waitFor(async () => expect(h.runPlanDag).toHaveBeenCalledWith(id, expect.any(String), { mode: "all" }));
    const steps = await db.select().from(schema.planSteps).where(eq(schema.planSteps.planId, id));
    expect(steps[0]).toMatchObject({ writes: 1, readOnly: 0 });
  });

  it("normal: indexa, recupera memoria, la guarda sin extracto y se la pasa al planner", async () => {
    h.generatePlan.mockClear();
    h.retrieveMemory.mockClear();
    h.indexVault.mockClear();
    const r = await req("/", "POST", { description: "agrega login" });
    const { id } = (await r.json()) as { id: string };
    await vi.waitFor(async () => expect((await getPlanRow(id)).status).toBe("pending"));
    expect(h.indexVault).toHaveBeenCalledTimes(1);
    expect(h.retrieveMemory).toHaveBeenCalledWith(expect.objectContaining({ query: "agrega login" }));
    const p = await getPlanRow(id);
    expect(p.memorySource).toBe("semantic");
    expect(p.memoryNotePath).toBe("Proyectos/x.md");
    const saved = JSON.parse(p.memoryNotes!);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ path: "Proyectos/x.md", projectNote: true });
    expect(saved[0]).not.toHaveProperty("excerpt");
    const opts = (h.generatePlan.mock.calls[0] as any[])[3];
    expect(opts.memory).toContain("EXTRACTO-SECRETO");
    expect(opts.memory).toContain("Proyectos/x.md");
  });

  it("si la indexación falla o se cuelga, el planner sigue sin bloquearse", async () => {
    h.generatePlan.mockClear();
    h.indexVault.mockRejectedValueOnce(new Error("boom"));
    const r = await req("/", "POST", { description: "otra cosa" });
    const { id } = (await r.json()) as { id: string };
    await vi.waitFor(async () => expect((await getPlanRow(id)).status).toBe("pending"));
    expect(h.generatePlan).toHaveBeenCalled();
  });

  it("trivial: no recupera memoria", async () => {
    h.retrieveMemory.mockClear();
    h.indexVault.mockClear();
    h.tier = { tier: "trivial", confidence: 0.95, source: "jev" };
    const r = await req("/", "POST", { description: "resume c.txt" });
    const { id } = (await r.json()) as { id: string };
    await vi.waitFor(async () => expect(h.runPlanDag).toHaveBeenCalledWith(id, expect.any(String), { mode: "all" }));
    expect(h.retrieveMemory).not.toHaveBeenCalled();
    expect(h.indexVault).not.toHaveBeenCalled();
    expect((await getPlanRow(id)).memoryNotes).toBeNull();
  });

  it("crítico: Opus planea, se agrega la revisión de solo lectura y NO arranca solo", async () => {
    h.tier = { tier: "critical", confidence: 0.9, source: "jev" };
    h.runPlanDag.mockClear();
    const r = await req("/", "POST", { description: "migra producción" });
    const { id } = (await r.json()) as { id: string };
    await vi.waitFor(async () => {
      const p = await db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((x) => x[0]);
      expect(p.status).toBe("pending");
    });
    const steps = (await db.select().from(schema.planSteps).where(eq(schema.planSteps.planId, id))).sort((a, b) => a.stepIndex - b.stepIndex);
    expect(steps.at(-1)).toMatchObject({ stepKey: "review", adapter: "claude", readOnly: 1, writes: 0 });
    expect(h.runPlanDag).not.toHaveBeenCalled();
  });

  it("cancelar la generación durante la clasificación se respeta: sin pasos ni arranque", async () => {
    h.tier = { tier: "trivial", confidence: 0.95, source: "jev" };
    h.runPlanDag.mockClear();
    h.generatePlan.mockClear();
    let release!: () => void;
    h.gate = new Promise<void>((r) => { release = r; });
    const r = await req("/", "POST", { description: "resume b.txt" });
    const { id } = (await r.json()) as { id: string };
    expect((await req(`/${id}/cancel-generation`)).status).toBe(200);
    release();
    await new Promise((res) => setTimeout(res, 200));
    expect((await getPlanRow(id)).status).toBe("cancelled");
    expect(await db.select().from(schema.planSteps).where(eq(schema.planSteps.planId, id))).toHaveLength(0);
    expect(h.runPlanDag).not.toHaveBeenCalled();
    expect(h.generatePlan).not.toHaveBeenCalled();
  });
  it("aprobar paso: marca guardApproved y relanza; 409 si corre; 404 si no existe", async () => {
    const id = await mk({ pauseReason: "guard" });
    const stepId = randomUUID();
    await db.insert(schema.planSteps).values({ id: stepId, planId: id, stepIndex: 0, description: "x", adapter: "codex", prompt: "p", status: "pending", guardFlags: JSON.stringify([{ id: "git", label: "l", probability: 1, source: "local" }]) });
    expect((await req(`/${id}/steps/${randomUUID()}/approve`)).status).toBe(404);
    const noFlags = await mkStep(id);
    const r409 = await req(`/${id}/steps/${noFlags}/approve`);
    expect(r409.status).toBe(409);
    expect(await r409.json()).toEqual({ error: "Solo se puede aprobar un paso detenido por la guardia" });
    const otherPlan = await mk();
    const otherStep = await mkStep(otherPlan, { guardFlags: "[{}]" });
    expect((await req(`/${otherPlan}/steps/${otherStep}/approve`)).status).toBe(409);
    expect(h.runPlanDag).not.toHaveBeenCalledWith(otherPlan, expect.anything(), expect.anything());
    h.running.add(id);
    expect((await req(`/${id}/steps/${stepId}/approve`)).status).toBe(409);
    h.running.delete(id);
    expect((await req(`/${id}/steps/${stepId}/approve`)).status).toBe(202);
    const s = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId)).then((x) => x[0]);
    expect(s.guardApproved).toBe(1);
    expect(h.runPlanDag).toHaveBeenLastCalledWith(id, expect.any(String), { mode: "all" });
  });
});

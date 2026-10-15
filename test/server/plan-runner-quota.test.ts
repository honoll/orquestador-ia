import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const quota = {
    exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "", summary: "", sessionId: null, model: null,
    costUsd: 0, inputTokens: 7, outputTokens: 3, errorMessage: "429 quota exceeded" as string | null, errorFamily: "quota_exhausted" as string | null, retryNotBefore: null,
  };
  const ok = { ...quota, exitCode: 0, summary: "listo", inputTokens: 5, outputTokens: 1, errorMessage: null, errorFamily: null };
  return { execute: vi.fn(async (_ctx: any) => quota), quota, ok };
});

vi.mock("../../src/adapters/registry.js", () => ({
  getAdapter: (t: string) => (t === "agy" ? { meta: { type: "agy" }, detect: async () => ({ available: true, resolvedPath: "x" }), execute: h.execute } : undefined),
  adapters: {},
}));

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { runPlanStep, QUOTA_PAUSE_PREFIX } = await import("../../src/server/plan-runner.js");
const { createAccount, updateAccount } = await import("../../src/server/agy-accounts.js");
const { createWorker } = await import("../../src/server/agy-workers.js");
const { WorkerUnavailableError } = await import("../../src/adapters/agy/worker-client.js");
const { eq, ne, and } = await import("drizzle-orm");
const { collectOfficeInput, buildOfficeState } = await import("../../src/server/office-state.js");

let localId = "";
beforeAll(async () => { await migrationDone; localId = (await createAccount("Prueba")).id; });
beforeEach(() => { h.execute.mockReset(); h.execute.mockImplementation(async () => h.quota); });
afterEach(async () => {
  await db.delete(schema.agyWorkers);
  await db.delete(schema.agyUsage);
  await db.delete(schema.agyAccounts).where(ne(schema.agyAccounts.id, localId));
  await db.update(schema.agyAccounts).set({ quotaBlockedUntil: null, quotaBlockedAt: null, calibratedLimit5h: null });
});

async function addWorker(label: string, port: number, pool = label) {
  const a = await createAccount(label);
  await updateAccount(a.id, { pool });
  await createWorker({ accountId: a.id, port, keyPath: `C:/k/${label}.key` });
  return a.id;
}
const usageOf = async (accountId: string) => db.select().from(schema.agyUsage).where(eq(schema.agyUsage.accountId, accountId));

async function mk(extra: Record<string, unknown> = {}) {
  const planId = randomUUID();
  const stepId = randomUUID();
  await db.insert(schema.plans).values({ id: planId, description: "p", status: "running" });
  await db.insert(schema.planSteps).values({ id: stepId, planId, stepIndex: 0, description: "d", adapter: "agy", prompt: "original", status: "pending", ...extra });
  return { planId, stepId, cwd: fs.mkdtempSync(path.join(os.tmpdir(), "plan-")) };
}

describe("runPlanStep", () => {
  it("cuota: devuelve paused_quota con los tokens, no reintenta y no toca el plan", async () => {
    const { planId, stepId, cwd } = await mk();
    const out = await runPlanStep({ planId, stepId, cwd });
    expect(out).toEqual({ status: "paused_quota", tokensUsed: 10 });
    expect(h.execute).toHaveBeenCalledTimes(1);
    const step = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId)).then((r) => r[0]);
    expect(step.status).toBe("pending");
    expect(step.errorMessage?.startsWith(QUOTA_PAUSE_PREFIX)).toBe(true);
    const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, planId)).then((r) => r[0]);
    expect(plan.status).toBe("running");
  });

  it("cuota en una bolsa: reintenta en otra bolsa y registra el uso en cada cuenta", async () => {
    const w = await addWorker("agy2", 3121);
    h.execute.mockImplementationOnce(async () => h.quota).mockImplementationOnce(async () => h.ok);
    const { planId, stepId, cwd } = await mk();
    const out = await runPlanStep({ planId, stepId, cwd });
    expect(out).toEqual({ status: "succeeded", tokensUsed: 16 });
    const targets = h.execute.mock.calls.map((c) => c[0].agyWorker?.port ?? "local");
    expect(new Set(targets)).toEqual(new Set([3121, "local"]));
    const [quotaAcc, okAcc] = targets[0] === 3121 ? [w, localId] : [localId, w];
    expect((await usageOf(quotaAcc)).map((u) => u.inputTokens)).toEqual([7]);
    expect((await usageOf(okAcc)).map((u) => u.inputTokens)).toEqual([5]);
  });

  it("cuota en la única otra cuenta de la MISMA bolsa: no la reintenta ahí → pausa", async () => {
    await addWorker("agy2", 3121, "Prueba");
    const { planId, stepId, cwd } = await mk();
    expect((await runPlanStep({ planId, stepId, cwd })).status).toBe("paused_quota");
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("trabajador no disponible: prueba otra cuenta sin fallar el paso ni registrar uso", async () => {
    const w = await addWorker("agy2", 3121);
    await updateAccount(localId, { manualLimit5h: 1000 });
    await db.insert(schema.agyUsage).values({ id: randomUUID(), accountId: localId, at: new Date().toISOString(), inputTokens: 900, outputTokens: 0, source: "plan" });
    h.execute.mockImplementationOnce(async () => { throw new WorkerUnavailableError("no responde"); }).mockImplementationOnce(async () => h.ok);
    const { planId, stepId, cwd } = await mk();
    expect((await runPlanStep({ planId, stepId, cwd })).status).toBe("succeeded");
    expect(h.execute.mock.calls[0][0].agyWorker?.port).toBe(3121);
    expect(h.execute.mock.calls[1][0].agyWorker).toBeUndefined();
    expect(await usageOf(w)).toHaveLength(0);
    const runs = await db.select().from(schema.runs).where(and(eq(schema.runs.adapter, "agy"), eq(schema.runs.status, "running")));
    expect(runs).toHaveLength(0);
  });

  it("promptOverride reemplaza el prompt guardado", async () => {
    const { planId, stepId, cwd } = await mk();
    await runPlanStep({ planId, stepId, cwd, promptOverride: "con contexto" });
    expect(h.execute.mock.calls[0][0].prompt).toBe("con contexto");
  });

  it("F4: un paso readOnly llega al adapter como readOnly: true", async () => {
    const { planId, stepId, cwd } = await mk({ readOnly: 1 });
    await runPlanStep({ planId, stepId, cwd });
    expect(h.execute.mock.calls[0][0].readOnly).toBe(true);
  });

  it("F4: un paso sin readOnly llega como readOnly: false", async () => {
    const { planId, stepId, cwd } = await mk({ readOnly: 0 });
    await runPlanStep({ planId, stepId, cwd });
    expect(h.execute.mock.calls[0][0].readOnly).toBe(false);
  });
});

describe("Oficina: escritorios con filas reales (regresión: contaban doble)", () => {

  const agyDesks = async () => buildOfficeState(await collectOfficeInput()).agents.find((a) => a.id === "agy")!.desks;

  it("1 paso corriendo → 1 escritorio; 2 pasos → 2", async () => {
    await addWorker("agy2", 3121); // un paso por cuenta: el segundo va al trabajador
    const seen: number[] = [];
    h.execute.mockImplementationOnce(async () => { seen.push(await agyDesks()); return h.ok; });
    const a = await mk();
    await runPlanStep({ planId: a.planId, stepId: a.stepId, cwd: a.cwd });

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = 0;
    const both = async () => { if (++started === 2) { seen.push(await agyDesks()); release(); } await gate; return h.ok; };
    h.execute.mockImplementationOnce(both).mockImplementationOnce(both);
    const b = await mk(); const c = await mk();
    await Promise.all([runPlanStep({ planId: b.planId, stepId: b.stepId, cwd: b.cwd }), runPlanStep({ planId: c.planId, stepId: c.stepId, cwd: c.cwd })]);
    expect(seen).toEqual([1, 2]);
  });
});

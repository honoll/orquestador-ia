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

  it("400 del trabajador: se salta solo para este paso (sin marcarlo caído ni dejar run fallido)", async () => {
    const w = await addWorker("agy2", 3121);
    await updateAccount(localId, { manualLimit5h: 1000 });
    await db.insert(schema.agyUsage).values({ id: randomUUID(), accountId: localId, at: new Date().toISOString(), inputTokens: 900, outputTokens: 0, source: "plan" });
    h.execute.mockImplementationOnce(async () => { throw new WorkerUnavailableError("respondió 400: cuerpo inválido", 400); }).mockImplementationOnce(async () => h.ok);
    const { planId, stepId, cwd } = await mk();
    const before = (await db.select().from(schema.runs).where(eq(schema.runs.status, "failed"))).length;
    expect((await runPlanStep({ planId, stepId, cwd })).status).toBe("succeeded");
    expect(h.execute.mock.calls[1][0].agyWorker).toBeUndefined();
    expect((await db.select().from(schema.runs).where(eq(schema.runs.status, "failed"))).length).toBe(before);
    const { pickWorker } = await import("../../src/server/agy-workers.js");
    const again = await pickWorker(Date.now(), { accounts: new Set([localId]) });
    expect(again?.accountId).toBe(w); // no quedó "caído" para los demás pasos
    again?.release();
  });

  it("413 en el único trabajador con la local bloqueada: el paso falla una vez con ese error", async () => {
    await addWorker("agy2", 3121);
    await db.update(schema.agyAccounts).set({ quotaBlockedUntil: new Date(Date.now() + 3_600_000).toISOString() }).where(eq(schema.agyAccounts.id, localId));
    h.execute.mockImplementation(async () => { throw new WorkerUnavailableError("trabajador agy en el puerto 3121 respondió 413: cuerpo demasiado grande", 413); });
    const { planId, stepId, cwd } = await mk();
    const before = (await db.select().from(schema.runs).where(eq(schema.runs.status, "failed"))).length;
    expect((await runPlanStep({ planId, stepId, cwd })).status).toBe("failed");
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect((await db.select().from(schema.runs).where(eq(schema.runs.status, "failed"))).length).toBe(before);
    const step = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId)).then((r) => r[0]);
    expect(step.errorMessage).toContain("413");
  });

  it("401 del trabajador: se marca caído (60 s) como sin respuesta", async () => {
    const w = await addWorker("agy2", 3121);
    await updateAccount(localId, { manualLimit5h: 1000 });
    await db.insert(schema.agyUsage).values({ id: randomUUID(), accountId: localId, at: new Date().toISOString(), inputTokens: 900, outputTokens: 0, source: "plan" });
    h.execute.mockImplementationOnce(async () => { throw new WorkerUnavailableError("respondió 401", 401); }).mockImplementationOnce(async () => h.ok);
    const { planId, stepId, cwd } = await mk();
    expect((await runPlanStep({ planId, stepId, cwd })).status).toBe("succeeded");
    const { pickWorker, markWorkerHealth } = await import("../../src/server/agy-workers.js");
    expect(await pickWorker(Date.now(), { accounts: new Set([localId]) })).toBeNull();
    const wid = (await db.select().from(schema.agyWorkers).where(eq(schema.agyWorkers.accountId, w)))[0].id;
    markWorkerHealth(wid, true);
  });

  it("proyecto fuera de la raíz de los trabajadores: solo la cuenta local", async () => {
    await addWorker("agy2", 3121);
    await updateAccount(localId, { manualLimit5h: 1000 });
    await db.insert(schema.agyUsage).values({ id: randomUUID(), accountId: localId, at: new Date().toISOString(), inputTokens: 900, outputTokens: 0, source: "plan" });
    h.execute.mockImplementation(async () => h.ok);
    const prev = process.env.AGY_WORKER_ROOT;
    process.env.AGY_WORKER_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "otra-raiz-"));
    try {
      const { planId, stepId, cwd } = await mk();
      expect((await runPlanStep({ planId, stepId, cwd })).status).toBe("succeeded");
      expect(h.execute.mock.calls[0][0].agyWorker).toBeUndefined();
    } finally {
      process.env.AGY_WORKER_ROOT = prev;
    }
  });

  it("reintento sin cuenta libre (la otra está ocupada): vuelve a pending como requeued, sin esperar", async () => {
    await addWorker("agy2", 3121);
    const { pickWorker } = await import("../../src/server/agy-workers.js");
    const { planId, stepId, cwd } = await mk();
    const first = (await pickWorker())!; // la mejor; el paso usa la otra y se queda sin alternativa libre
    const out = await runPlanStep({ planId, stepId, cwd });
    first.release();
    expect(out.status).toBe("requeued");
    expect(h.execute).toHaveBeenCalledTimes(1);
    const step = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId)).then((r) => r[0]);
    expect(step.status).toBe("pending");
  });

  it("409 (ocupado): sin run fallido, el trabajador se enfría y el paso vuelve a pending", async () => {
    const w = await addWorker("agy2", 3121);
    const { pickWorker } = await import("../../src/server/agy-workers.js");
    const held = (await pickWorker(Date.now(), { accounts: new Set([w]) }))!; // la local queda ocupada
    h.execute.mockImplementationOnce(async () => { throw new WorkerUnavailableError("ocupado", 409); });
    const { planId, stepId, cwd } = await mk();
    const before = (await db.select().from(schema.runs)).length;
    const out = await runPlanStep({ planId, stepId, cwd });
    expect(out).toMatchObject({ status: "requeued", attempt: 0 });
    expect((await db.select().from(schema.runs)).length).toBe(before);
    const step = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId)).then((r) => r[0]);
    expect(step).toMatchObject({ status: "pending", runId: null });
    held.release();
    expect((await pickWorker(Date.now(), { accounts: new Set([localId]) }))).toBeNull(); // agy2 enfriándose
  });

  it("startAttempt sigue la cuenta de reintentos tras un requeued", async () => {
    h.execute.mockImplementation(async () => ({ ...h.ok, exitCode: 1, errorMessage: "boom", errorFamily: "unknown" }));
    const { planId, stepId, cwd } = await mk();
    await runPlanStep({ planId, stepId, cwd, startAttempt: 2 });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("promptOverride reemplaza el prompt guardado", async () => {
    const { planId, stepId, cwd } = await mk();
    await runPlanStep({ planId, stepId, cwd, promptOverride: "con contexto" });
    expect(h.execute.mock.calls[0][0].prompt).toBe("con contexto");
  });

  it("F14: turno retomado que cambia de cuenta a media vuelta recibe el prompt completo, sin sesión", async () => {
    const w = await addWorker("agy2", 3121);
    await updateAccount(localId, { manualLimit5h: 1000 });
    await db.insert(schema.agyUsage).values({ id: randomUUID(), accountId: localId, at: new Date().toISOString(), inputTokens: 900, outputTokens: 0, source: "plan" });
    h.execute.mockImplementationOnce(async () => { throw new WorkerUnavailableError("respondió 400", 400); }).mockImplementationOnce(async () => h.ok);
    const { planId, stepId, cwd } = await mk({ sessionId: "ses-1", accountId: w });
    expect((await runPlanStep({ planId, stepId, cwd, promptOverride: "DELTA", promptFull: "COMPLETO" })).status).toBe("succeeded");
    const [a, b] = h.execute.mock.calls.map((c) => c[0]);
    expect([a.agyWorker?.port, a.prompt, a.sessionId]).toEqual([3121, "DELTA", "ses-1"]);
    expect([b.agyWorker, b.prompt, b.sessionId]).toEqual([undefined, "COMPLETO", undefined]);
  });

  it("F14: turno retomado en la misma cuenta recibe el delta con su sesión", async () => {
    h.execute.mockImplementation(async () => h.ok);
    const { planId, stepId, cwd } = await mk({ sessionId: "ses-1", accountId: localId });
    await runPlanStep({ planId, stepId, cwd, promptOverride: "DELTA", promptFull: "COMPLETO" });
    expect([h.execute.mock.calls[0][0].prompt, h.execute.mock.calls[0][0].sessionId]).toEqual(["DELTA", "ses-1"]);
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

  // Con asientos por cuenta, desks = cuentas; lo que no debe contarse doble son los asientos ocupados.
  const agyDesks = async () => buildOfficeState(await collectOfficeInput()).agents.find((a) => a.id === "agy")!.seats!.filter((s) => s.working).length;

  it("1 paso corriendo → 1 escritorio; 2 pasos → 2", async () => {
    await addWorker("agy2", 3121); // un paso por cuenta: el segundo va al trabajador
    const seen: number[] = [];
    const loose: number[] = []; // chats sueltos vistos: la run de un paso corriendo NO debe contar (run_id se enlaza al iniciar)
    h.execute.mockImplementationOnce(async () => { seen.push(await agyDesks()); loose.push((await collectOfficeInput()).chatRuns.length); return h.ok; });
    const a = await mk();
    await runPlanStep({ planId: a.planId, stepId: a.stepId, cwd: a.cwd });

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = 0;
    const both = async () => { if (++started === 2) { seen.push(await agyDesks()); loose.push((await collectOfficeInput()).chatRuns.length); release(); } await gate; return h.ok; };
    h.execute.mockImplementationOnce(both).mockImplementationOnce(both);
    const b = await mk(); const c = await mk();
    await Promise.all([runPlanStep({ planId: b.planId, stepId: b.stepId, cwd: b.cwd }), runPlanStep({ planId: c.planId, stepId: c.stepId, cwd: c.cwd })]);
    expect(seen).toEqual([1, 2]);
    expect(loose).toEqual([0, 0]);
  });
});

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = { current: 0, max: 0, calls: [] as { type: string; key: string; prompt: string; start: number; end: number; readOnly?: boolean; model?: string }[], fail: new Set<string>(), tokens: 100, delayMs: 40, withKill: false, killed: 0, onStart: null as null | (() => void) };
  const ok = (summary: string) => ({
    exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", summary, sessionId: null, model: null,
    costUsd: 0, inputTokens: state.tokens, outputTokens: 0, errorMessage: null, errorFamily: null, retryNotBefore: null,
  });
  const make = (type: string) => ({
    meta: { type },
    detect: async () => ({ available: true, resolvedPath: "x" }),
    execute: async (ctx: any) => {
      state.current++;
      state.max = Math.max(state.max, state.current);
      const start = Date.now();
      state.onStart?.();
      await new Promise<void>((r) => {
        const t = setTimeout(r, state.delayMs);
        if (state.withKill) ctx.onKill?.(() => { state.killed++; clearTimeout(t); r(); });
      });
      state.current--;
      const key = /\[(s\d+)\]/.exec(ctx.prompt)?.[1] ?? "synth";
      state.calls.push({ type, key, prompt: ctx.prompt, start, end: Date.now(), readOnly: ctx.readOnly, model: ctx.model });
      if (state.fail.has(key)) return { ...ok(""), exitCode: 1, errorMessage: "boom", errorFamily: "unknown" };
      return ok(`resultado-${key}`);
    },
  });
  return { state, adapters: { claude: make("claude"), codex: make("codex"), agy: make("agy") } as Record<string, any> };
});

vi.mock("../../src/adapters/registry.js", () => ({ getAdapter: (t: string) => h.adapters[t], adapters: h.adapters }));

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { runPlanDag, cancelPlanRun, isPlanRunning } = await import("../../src/server/plan-scheduler.js");
const { createAccount } = await import("../../src/server/agy-accounts.js");
const { eq } = await import("drizzle-orm");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
beforeAll(async () => { await migrationDone; });
beforeEach(() => {
  Object.assign(h.state, { current: 0, max: 0, calls: [], tokens: 100, delayMs: 40, withKill: false, killed: 0, onStart: null });
  h.state.fail.clear();
});

type S = { key: string; deps?: string[]; writes?: boolean; adapter?: string };
async function mkPlan(steps: S[], extra: Record<string, unknown> = {}) {
  const planId = randomUUID();
  await db.insert(schema.plans).values({ id: planId, description: "pedido de prueba", status: "pending", ...extra } as any);
  for (const [i, s] of steps.entries()) {
    await db.insert(schema.planSteps).values({
      id: randomUUID(), planId, stepIndex: i, description: `desc ${s.key}`, adapter: s.adapter ?? "codex",
      prompt: `[${s.key}] haz algo`, status: "pending", stepKey: s.key, dependsOn: JSON.stringify(s.deps ?? []), writes: s.writes ? 1 : 0,
    });
  }
  return planId;
}
const plan = (id: string) => db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((r) => r[0]);
const steps = (id: string) => db.select().from(schema.planSteps).where(eq(schema.planSteps.planId, id)).then((r) => r.sort((a, b) => a.stepIndex - b.stepIndex));
const stepCalls = () => h.state.calls.filter((c) => c.key !== "synth");

describe("planificador", () => {
  it("lectores en paralelo, el escritor espera a sus dependencias y recibe sus resultados; síntesis al final", async () => {
    const id = await mkPlan([{ key: "s1" }, { key: "s2" }, { key: "s3", deps: ["s1", "s2"], writes: true }]);
    await runPlanDag(id, cwd);
    expect(h.state.max).toBe(2);
    const c = Object.fromEntries(stepCalls().map((x) => [x.key, x]));
    expect(c.s3.start).toBeGreaterThanOrEqual(Math.max(c.s1.end, c.s2.end));
    expect(c.s3.prompt).toContain("resultado-s1");
    expect(c.s3.prompt).toContain("resultado-s2");
    const synth = h.state.calls.find((x) => x.key === "synth")!;
    expect(synth).toMatchObject({ type: "claude", readOnly: true, model: "claude-opus-5-5" });
    expect(synth.prompt).toContain("resultado-s3");
    expect(await plan(id)).toMatchObject({ status: "completed", synthesis: "resultado-synth", synthesisStatus: "succeeded", usedTokens: 400 });
  });

  it("escritores en fila", async () => {
    const id = await mkPlan([{ key: "s1", writes: true }, { key: "s2", writes: true }, { key: "s3", writes: true }]);
    await runPlanDag(id, cwd);
    expect(h.state.max).toBe(1);
  });

  it("respeta maxParallel", async () => {
    const id = await mkPlan([{ key: "s1" }, { key: "s2" }, { key: "s3" }, { key: "s4" }], { maxParallel: 2 });
    await runPlanDag(id, cwd);
    expect(h.state.max).toBe(2);
  });

  it("si un paso falla: no arranca más, plan failed, sin síntesis", async () => {
    h.state.fail.add("s1");
    const id = await mkPlan([{ key: "s1" }, { key: "s2", deps: ["s1"] }]);
    await runPlanDag(id, cwd);
    const [s1, s2] = await steps(id);
    expect([s1.status, s2.status]).toEqual(["failed", "pending"]);
    expect((await plan(id)).status).toBe("failed");
    expect(h.state.calls.some((x) => x.key === "synth")).toBe(false);
  });

  it("presupuesto: termina lo que corre, pausa con motivo budget y se puede continuar", async () => {
    const id = await mkPlan([{ key: "s1" }, { key: "s2" }, { key: "s3" }], { maxParallel: 1, budgetTokens: 150 });
    await runPlanDag(id, cwd);
    expect(stepCalls().map((x) => x.key)).toEqual(["s1", "s2"]);
    expect(await plan(id)).toMatchObject({ status: "pending", pauseReason: "budget", usedTokens: 200 });
    await db.update(schema.plans).set({ budgetTokens: 1000 }).where(eq(schema.plans.id, id));
    await runPlanDag(id, cwd);
    expect(await plan(id)).toMatchObject({ status: "completed", pauseReason: null });
  });

  it("cuota: con la cuenta bloqueada no gasta la llamada y pausa con motivo quota", async () => {
    const a = await createAccount("Bloqueada");
    await db.update(schema.agyAccounts).set({ quotaBlockedUntil: new Date(Date.now() + 3_600_000).toISOString() }).where(eq(schema.agyAccounts.id, a.id));
    const id = await mkPlan([{ key: "s1", adapter: "agy" }]);
    await runPlanDag(id, cwd);
    expect(h.state.calls).toHaveLength(0);
    expect(await plan(id)).toMatchObject({ status: "pending", pauseReason: "quota" });
    await db.update(schema.agyAccounts).set({ quotaBlockedUntil: null }).where(eq(schema.agyAccounts.id, a.id));
  });

  it("plan viejo sin claves corre en orden, uno a la vez", async () => {
    const planId = randomUUID();
    await db.insert(schema.plans).values({ id: planId, description: "viejo", status: "pending" });
    for (const i of [0, 1]) {
      await db.insert(schema.planSteps).values({ id: randomUUID(), planId, stepIndex: i, description: "d", adapter: "codex", prompt: `[s${i + 1}] x`, status: "pending" });
    }
    await runPlanDag(planId, cwd);
    expect(h.state.max).toBe(1);
    expect(stepCalls().map((x) => x.key)).toEqual(["s1", "s2"]);
  });

  it("modo paso a paso corre un solo paso y deja el plan pending", async () => {
    const id = await mkPlan([{ key: "s1" }, { key: "s2" }]);
    await runPlanDag(id, cwd, { mode: "next" });
    expect(stepCalls()).toHaveLength(1);
    expect((await plan(id)).status).toBe("pending");
  });

  it("no corre dos veces el mismo plan; cancelar deja los pasos en curso como cancelled", async () => {
    h.state.delayMs = 80;
    const id = await mkPlan([{ key: "s1" }, { key: "s2", deps: ["s1"] }]);
    const p = runPlanDag(id, cwd);
    await new Promise((r) => setTimeout(r, 20));
    expect(isPlanRunning(id)).toBe(true);
    await runPlanDag(id, cwd); // ignorado
    expect(cancelPlanRun(id)).toBe(true);
    await p;
    const [s1, s2] = await steps(id);
    expect(s1.status).toBe("cancelled");
    expect(s2.status).toBe("pending");
    expect(stepCalls()).toHaveLength(1);
    expect(isPlanRunning(id)).toBe(false);
  });

  it("si la síntesis falla, el plan queda completed con synthesis_status failed", async () => {
    h.state.fail.add("synth");
    const id = await mkPlan([{ key: "s1" }]);
    await runPlanDag(id, cwd);
    expect(await plan(id)).toMatchObject({ status: "completed", synthesisStatus: "failed" });
    expect((await plan(id)).synthesisError).toBeTruthy();
  });

  it("si se cancela antes de que el paso registre su kill, el proceso se mata al registrarlo", async () => {
    Object.assign(h.state, { delayMs: 2000, withKill: true });
    const id = await mkPlan([{ key: "s1" }]);
    h.state.onStart = () => { cancelPlanRun(id); };
    const t0 = Date.now();
    await runPlanDag(id, cwd);
    expect(h.state.killed).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect((await steps(id))[0].status).toBe("cancelled");
    expect(isPlanRunning(id)).toBe(false);
  });

  it("si algo truena (plan inexistente), no deja el plan marcado como corriendo", async () => {
    const id = randomUUID();
    await expect(runPlanDag(id, cwd)).rejects.toThrow(/not found/);
    expect(isPlanRunning(id)).toBe(false);
  });
});

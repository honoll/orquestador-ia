import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = { calls: [] as string[], jevAnswers: null as Record<string, unknown> | null, gate: null as Promise<void> | null, entered: null as (() => void) | null };
  const ok = (summary: string) => ({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", summary, sessionId: null, model: null, costUsd: 0, inputTokens: 10, outputTokens: 0, errorMessage: null, errorFamily: null, retryNotBefore: null });
  const make = (type: string) => ({ meta: { type }, detect: async () => ({ available: true, resolvedPath: "x" }),
    execute: async (ctx: any) => { state.calls.push(/\[(s\d+)\]/.exec(ctx.prompt)?.[1] ?? "synth"); return ok("hecho"); } });
  return { state, adapters: { claude: make("claude"), codex: make("codex"), agy: make("agy") } as Record<string, any> };
});
vi.mock("../../src/adapters/registry.js", () => ({ getAdapter: (t: string) => h.adapters[t], adapters: h.adapters }));
vi.mock("../../src/lib/jev.js", async (orig) => {
  const real: any = await orig();
  return { ...real, jev: { configured: () => h.state.jevAnswers !== null, ask: async () => { h.state.entered?.(); if (h.state.gate) await h.state.gate; return h.state.jevAnswers; } } };
});

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { runPlanDag, cancelPlanRun } = await import("../../src/server/plan-scheduler.js");
const { eq } = await import("drizzle-orm");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
beforeAll(async () => { await migrationDone; });
beforeEach(() => { h.state.calls = []; h.state.jevAnswers = null; h.state.gate = null; h.state.entered = null; });

async function mk(prompt: string, writes = 1) {
  const planId = randomUUID();
  const stepId = randomUUID();
  await db.insert(schema.plans).values({ id: planId, description: "d", status: "pending" });
  await db.insert(schema.planSteps).values({ id: stepId, planId, stepIndex: 0, description: "x", adapter: "codex", prompt: `[s1] ${prompt}`, status: "pending", stepKey: "s1", dependsOn: "[]", writes });
  return { planId, stepId };
}
const plan = (id: string) => db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((r) => r[0]);
const step = (id: string) => db.select().from(schema.planSteps).where(eq(schema.planSteps.id, id)).then((r) => r[0]);

describe("guardia en el planificador", () => {
  it("escritor marcado (reglas locales): no se lanza, plan pending con motivo guard y banderas guardadas", async () => {
    const { planId, stepId } = await mk("al terminar haz git push");
    await runPlanDag(planId, cwd);
    expect(h.state.calls).toEqual([]);
    expect(await plan(planId)).toMatchObject({ status: "pending", pauseReason: "guard" });
    const s = await step(stepId);
    expect(s.status).toBe("pending");
    expect(JSON.parse(s.guardFlags!)[0]).toMatchObject({ id: "git", source: "local" });
  });

  it("aprobado: corre aunque la guardia lo marque", async () => {
    const { planId, stepId } = await mk("al terminar haz git push");
    await db.update(schema.planSteps).set({ guardApproved: 1, guardFlags: JSON.stringify([{ id: "git", label: "l", probability: 1, source: "local" }]) }).where(eq(schema.planSteps.id, stepId));
    await runPlanDag(planId, cwd);
    expect(h.state.calls).toContain("s1");
    expect((await plan(planId)).status).toBe("completed");
    // Al lanzarlo se consumen la aprobación y las banderas viejas.
    expect(await step(stepId)).toMatchObject({ guardApproved: 0, guardFlags: null });
  });

  it("los lectores no pasan por la guardia", async () => {
    const { planId } = await mk("lee y haz git push mental", 0);
    await runPlanDag(planId, cwd);
    expect(h.state.calls).toContain("s1");
  });

  it("con JEV que dice que no: corre aunque el texto mencione push", async () => {
    h.state.jevAnswers = { git: { type: "noul", noul: 0.02 }, destructive: { type: "noul", noul: 0.01 }, outside_project: { type: "noul", noul: 0.03 } };
    const { planId } = await mk("no hagas git push");
    await runPlanDag(planId, cwd);
    expect(h.state.calls).toContain("s1");
  });

  it("con JEV que marca: pausa con fuente jev", async () => {
    h.state.jevAnswers = { git: { type: "noul", noul: 0.1 }, destructive: { type: "noul", noul: 0.88 }, outside_project: { type: "noul", noul: 0.1 } };
    const { planId, stepId } = await mk("limpia la carpeta");
    await runPlanDag(planId, cwd);
    expect(h.state.calls).toEqual([]);
    expect(JSON.parse((await step(stepId)).guardFlags!)).toEqual([expect.objectContaining({ id: "destructive", probability: 0.88, source: "jev" })]);
  });

  it("aprobar vale una vez: tras correr, volver a pending y relanzar lo pausa otra vez", async () => {
    const { planId, stepId } = await mk("al terminar haz git push");
    await db.update(schema.planSteps).set({ guardApproved: 1 }).where(eq(schema.planSteps.id, stepId));
    await runPlanDag(planId, cwd);
    expect(h.state.calls).toEqual(["s1", "synth"]);
    expect((await step(stepId)).guardApproved).toBe(0);
    h.state.calls = [];
    await db.update(schema.planSteps).set({ status: "pending", result: null }).where(eq(schema.planSteps.id, stepId));
    await db.update(schema.plans).set({ status: "pending", synthesisStatus: null, synthesis: null }).where(eq(schema.plans.id, planId));
    await runPlanDag(planId, cwd);
    expect(h.state.calls).toEqual([]);
    expect(await plan(planId)).toMatchObject({ status: "pending", pauseReason: "guard" });
  });

  it("cancelar mientras la guardia evalúa: no se lanza nada de esa vuelta (ni el lector que va después)", async () => {
    const { planId } = await mk("al terminar haz git push");
    await db.insert(schema.planSteps).values({ id: randomUUID(), planId, stepIndex: 1, description: "y", adapter: "codex", prompt: "[s2] lee", status: "pending", stepKey: "s2", dependsOn: "[]", writes: 0 });
    let release!: () => void;
    h.state.gate = new Promise<void>((r) => { release = r; });
    const entered = new Promise<void>((r) => { h.state.entered = r; });
    const done = runPlanDag(planId, cwd);
    await entered;
    expect(cancelPlanRun(planId)).toBe(true);
    release();
    await done;
    expect(h.state.calls).toEqual([]);
    expect((await plan(planId)).status).toBe("cancelled");
  });
});

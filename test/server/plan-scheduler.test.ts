import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = { current: 0, max: 0, calls: [] as { type: string; key: string; prompt: string; start: number; end: number; readOnly?: boolean; model?: string }[], fail: new Set<string>(), tokens: 100, delayMs: 40, withKill: false, killed: 0, onStart: null as null | (() => void), delayByKey: {} as Record<string, number>, accountThrows: false, synthText: null as string | null };
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
      const key = /\[(s\d+)\]/.exec(ctx.prompt)?.[1] ?? "synth";
      state.onStart?.();
      await new Promise<void>((r) => {
        let done = false;
        const t = setTimeout(() => { done = true; r(); }, state.delayByKey[key] ?? state.delayMs);
        if (state.withKill) ctx.onKill?.(() => { if (done) return; done = true; state.killed++; clearTimeout(t); r(); });
      });
      state.current--;
      state.calls.push({ type, key, prompt: ctx.prompt, start, end: Date.now(), readOnly: ctx.readOnly, model: ctx.model });
      if (state.fail.has(key)) return { ...ok(""), exitCode: 1, errorMessage: "boom", errorFamily: "unknown" };
      return ok(key === "synth" && state.synthText ? state.synthText : `resultado-${key}`);
    },
  });
  return { state, events: [] as any[], adapters: { claude: make("claude"), codex: make("codex"), agy: make("agy") } as Record<string, any> };
});

vi.mock("../../src/server/ws.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/server/ws.js")>();
  return { ...orig, broadcast: (e: any) => { h.events.push(e); } };
});

vi.mock("../../src/server/agy-accounts.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/server/agy-accounts.js")>();
  return {
    ...orig,
    getActiveAccount: (...a: Parameters<typeof orig.getActiveAccount>) => {
      if (h.state.accountThrows) throw new Error("db caída");
      return orig.getActiveAccount(...a);
    },
  };
});
vi.mock("../../src/adapters/registry.js", () => ({ getAdapter: (t: string) => h.adapters[t], adapters: h.adapters }));

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { runPlanDag, cancelPlanRun, isPlanRunning } = await import("../../src/server/plan-scheduler.js");
const { createAccount } = await import("../../src/server/agy-accounts.js");
const { eq } = await import("drizzle-orm");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
const vault = fs.mkdtempSync(path.join(os.tmpdir(), "sched-vault-"));
process.env.CEREBRO_PATH = vault;
beforeAll(async () => { await migrationDone; });
beforeEach(() => {
  Object.assign(h.state, { current: 0, max: 0, calls: [], tokens: 100, delayMs: 40, withKill: false, killed: 0, onStart: null, delayByKey: {}, accountThrows: false, synthText: null });
  h.state.fail.clear();
  h.events.length = 0;
});

type S = { key: string; deps?: string[]; writes?: boolean; adapter?: string; status?: string };
async function mkPlan(steps: S[], extra: Record<string, unknown> = {}) {
  const planId = randomUUID();
  await db.insert(schema.plans).values({ id: planId, description: "pedido de prueba", status: "pending", ...extra } as any);
  for (const [i, s] of steps.entries()) {
    await db.insert(schema.planSteps).values({
      id: randomUUID(), planId, stepIndex: i, description: `desc ${s.key}`, adapter: s.adapter ?? "codex",
      prompt: `[${s.key}] haz algo`, status: (s.status ?? "pending") as any, stepKey: s.key, dependsOn: JSON.stringify(s.deps ?? []), writes: s.writes ? 1 : 0,
    });
  }
  return planId;
}
const plan = (id: string) => db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((r) => r[0]);
const steps = (id: string) => db.select().from(schema.planSteps).where(eq(schema.planSteps.planId, id)).then((r) => r.sort((a, b) => a.stepIndex - b.stepIndex));
const stepCalls = () => h.state.calls.filter((c) => c.key !== "synth");
const doneEvents = (id: string) => h.events.filter((e) => e.type === "plan:done" && e.planId === id);

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
    expect(await plan(id)).toMatchObject({ status: "cancelled", pauseReason: null });
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
    await expect(runPlanDag(id, cwd)).resolves.toBeUndefined();
    expect(isPlanRunning(id)).toBe(false);
  });

  it("cancelar durante la síntesis mata a Opus y no marca el plan completed", async () => {
    Object.assign(h.state, { withKill: true, delayByKey: { synth: 2000 } });
    const id = await mkPlan([{ key: "s1" }]);
    const p = runPlanDag(id, cwd);
    const t0 = Date.now();
    while ((await plan(id)).synthesisStatus !== "running") {
      if (Date.now() - t0 > 3000) throw new Error("la síntesis nunca arrancó");
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 30)); // que el proceso registre su kill
    expect(cancelPlanRun(id)).toBe(true);
    await p;
    expect(h.state.killed).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1500);
    const row = await plan(id);
    expect(row.status).toBe("cancelled");
    expect(row.synthesisStatus).toBeNull();
    expect(row.synthesis).toBeNull();
    expect(isPlanRunning(id)).toBe(false);
  });

  it("si algo truena a media corrida: mata lo que corre y deja el plan failed con el error", async () => {
    Object.assign(h.state, { withKill: true, delayByKey: { s2: 2000 } });
    const id = await mkPlan([{ key: "s1" }, { key: "s2" }]);
    h.state.onStart = () => { h.state.accountThrows = true; };
    const t0 = Date.now();
    await runPlanDag(id, cwd);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(h.state.killed).toBe(1);
    expect(await plan(id)).toMatchObject({ status: "failed", errorMessage: "db caída" });
    expect(isPlanRunning(id)).toBe(false);
  });

  it("pasos cancelados no cuentan como hechos: sin síntesis y el plan queda pending", async () => {
    const id = await mkPlan([{ key: "s1", status: "succeeded" }, { key: "s2", status: "cancelled" }]);
    await runPlanDag(id, cwd);
    expect(h.state.calls).toHaveLength(0);
    expect(await plan(id)).toMatchObject({ status: "pending", synthesisStatus: null });
    expect(doneEvents(id)).toEqual([expect.objectContaining({ status: "pending" })]);
  });

  it("un paso running huérfano (reinicio) vuelve a pending y el plan corre normal", async () => {
    const id = await mkPlan([{ key: "s1", status: "running" }, { key: "s2", deps: ["s1"] }], { maxParallel: 1, synthesisStatus: "running" });
    await runPlanDag(id, cwd);
    expect(stepCalls().map((x) => x.key)).toEqual(["s1", "s2"]);
    expect(await plan(id)).toMatchObject({ status: "completed", synthesisStatus: "succeeded" });
  });

  it("modo next sin nada que lanzar emite plan:done pending; si lanza uno, no", async () => {
    const blocked = await mkPlan([{ key: "s1", status: "cancelled" }, { key: "s2", deps: ["s1"] }]);
    await runPlanDag(blocked, cwd, { mode: "next" });
    expect(h.state.calls).toHaveLength(0);
    expect(doneEvents(blocked)).toEqual([expect.objectContaining({ status: "pending" })]);
    const ok = await mkPlan([{ key: "s1" }, { key: "s2" }]);
    await runPlanDag(ok, cwd, { mode: "next" });
    expect(doneEvents(ok)).toHaveLength(0);
  });
  it("la síntesis con bloque MEMORIA guarda solo la respuesta, escribe la nota y emite plan:memory-note", async () => {
    h.state.synthText = ["Todo listo.", "<<<MEMORIA>>>", '{"decisiones":["usar sqlite"],"aprendizajes":["probar antes"]}', "<<<FIN MEMORIA>>>"].join("\n");
    const id = await mkPlan([{ key: "s1" }]);
    await runPlanDag(id, cwd);
    const row = await plan(id);
    expect(row).toMatchObject({ status: "completed", synthesis: "Todo listo.", synthesisStatus: "succeeded" });
    expect(row.memoryNotePath).toMatch(/^Orquestador\/Planes\/.+\.md$/);
    const note = fs.readFileSync(path.join(vault, row.memoryNotePath!), "utf-8");
    expect(note).toContain("usar sqlite");
    expect(note).toContain("probar antes");
    expect(note).toContain("Todo listo.");
    expect(h.events.some((e) => e.type === "plan:memory-note" && e.planId === id && e.path === row.memoryNotePath)).toBe(true);
  });

  it("si escribir la nota falla, el plan igual queda completed", async () => {
    const blocker = path.join(os.tmpdir(), `sched-file-${randomUUID()}`);
    fs.writeFileSync(blocker, "x");
    const prev = process.env.CEREBRO_PATH;
    process.env.CEREBRO_PATH = blocker; // un archivo, no un directorio: mkdir falla
    try {
      const id = await mkPlan([{ key: "s1" }]);
      await runPlanDag(id, cwd);
      expect(await plan(id)).toMatchObject({ status: "completed", synthesisStatus: "succeeded", memoryNotePath: null });
    } finally {
      process.env.CEREBRO_PATH = prev;
    }
  });
});

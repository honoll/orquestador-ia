import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const base = {
    exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", summary: "", sessionId: null, model: null,
    costUsd: 0, inputTokens: 5, outputTokens: 1, errorMessage: null as string | null, errorFamily: null as string | null, retryNotBefore: null,
  };
  return { execute: vi.fn(async (_ctx: any) => base), base };
});

vi.mock("../../src/adapters/registry.js", () => ({
  getAdapter: (t: string) => (t === "agy" ? { meta: { type: "agy" }, detect: async () => ({ available: true, resolvedPath: "x" }), execute: h.execute } : undefined),
  adapters: {},
}));

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { runPlanStep, QUOTA_PAUSE_PREFIX } = await import("../../src/server/plan-runner.js");
const { createAccount } = await import("../../src/server/agy-accounts.js");
const { eq } = await import("drizzle-orm");

beforeAll(async () => { await migrationDone; await createAccount("Roles"); });
beforeEach(async () => {
  h.execute.mockReset();
  // El caso de cuota bloquea la bolsa; cada prueba arranca con la cuenta libre.
  await db.update(schema.agyAccounts).set({ quotaBlockedUntil: null, quotaBlockedAt: null, calibratedLimit5h: null });
});

const reply = (summary: string, extra: Record<string, unknown> = {}) => h.execute.mockImplementation(async () => ({ ...h.base, summary, ...extra }));

async function run(role: string | null) {
  const planId = randomUUID();
  const stepId = randomUUID();
  await db.insert(schema.plans).values({ id: planId, description: "p", status: "running" });
  await db.insert(schema.planSteps).values({ id: stepId, planId, stepIndex: 0, description: "d", adapter: "agy", prompt: "p", status: "pending", role, statusDetail: "viejo" });
  const out = await runPlanStep({ planId, stepId, cwd: fs.mkdtempSync(path.join(os.tmpdir(), "plan-")) });
  const step = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId)).then((r) => r[0]);
  return { out, step };
}

describe("runPlanStep: estado final de pasos con rol (F11)", () => {
  it("terminado → succeeded con el detalle guardado", async () => {
    reply('Listo.\n<<<ESTADO terminado {"detalle":"2 archivos"}>>>');
    const { out, step } = await run("dev");
    expect(out.status).toBe("succeeded");
    expect(step).toMatchObject({ status: "succeeded", statusDetail: "2 archivos" });
  });

  it("bloqueado / necesita → failed con el detalle visible, sin reintentar", async () => {
    reply('No pude.\n<<<ESTADO bloqueado {"detalle":"npm test no arranca"}>>>');
    const b = await run("qa");
    expect(b.out.status).toBe("failed");
    expect(b.step).toMatchObject({ status: "failed", statusDetail: "npm test no arranca", errorMessage: "bloqueado: npm test no arranca" });
    expect(h.execute).toHaveBeenCalledTimes(1);

    reply('<<<ESTADO necesita {"detalle":"¿qué puerto?"}>>>');
    const n = await run("dev");
    expect(n.step).toMatchObject({ status: "failed", statusDetail: "¿qué puerto?", errorMessage: "necesita: ¿qué puerto?" });
  });

  it("sin estado final → failed 'sin estado final'", async () => {
    reply("Hice todo, creo.");
    const { out, step } = await run("lector");
    expect(out.status).toBe("failed");
    expect(step).toMatchObject({ status: "failed", errorMessage: "sin estado final", statusDetail: "sin estado final" });
  });

  it("la cuota se maneja antes que el estado (pausa, no 'sin estado final')", async () => {
    reply("", { exitCode: 1, errorMessage: "429 quota exceeded", errorFamily: "quota_exhausted" });
    const { out, step } = await run("dev");
    expect(out.status).toBe("paused_quota");
    expect(step.errorMessage?.startsWith(QUOTA_PAUSE_PREFIX)).toBe(true);
  });

  it("paso sin rol (legado) no exige estado", async () => {
    reply("Hecho sin bloque.");
    const { out, step } = await run(null);
    expect(out.status).toBe("succeeded");
    expect(step.statusDetail).toBeNull();
  });
});

describe("runPlanStep: carpeta de salidas del rol imagen (F11)", () => {
  it("prompt con la carpeta, .gitignore y aviso si toca archivos fuera (git)", async () => {
    const { execFileSync } = await import("node:child_process");
    try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { return; }
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-"));
    execFileSync("git", ["init", "-q"], { cwd });
    const planId = randomUUID();
    const stepId = randomUUID();
    await db.insert(schema.plans).values({ id: planId, description: "p", status: "running" });
    await db.insert(schema.planSteps).values({ id: stepId, planId, stepIndex: 0, description: "d", adapter: "agy", prompt: "haz logo", status: "pending", role: "imagen" });
    h.execute.mockImplementation(async (ctx: any) => {
      fs.writeFileSync(path.join(cwd, "colado.js"), "x");
      return { ...h.base, summary: 'Listo.\n<<<ESTADO terminado {"detalle":"1 imagen"}>>>', prompt: ctx.prompt };
    });
    const out = await runPlanStep({ planId, stepId, cwd });
    const sent = h.execute.mock.calls[0][0].prompt as string;
    expect(sent).toContain(path.join(cwd, ".orquestador", "salidas", planId));
    expect(sent).toContain("únicamente aquí");
    expect(fs.readFileSync(path.join(cwd, ".gitignore"), "utf8")).toContain(".orquestador/");
    const step = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId)).then((r) => r[0]);
    expect(out.status).toBe("succeeded");
    expect(step.statusDetail).toContain("colado.js");
  });

  it("roles que no escriben salidas no crean carpeta", async () => {
    reply('<<<ESTADO terminado {"detalle":"ok"}>>>');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-"));
    const planId = randomUUID();
    const stepId = randomUUID();
    await db.insert(schema.plans).values({ id: planId, description: "p", status: "running" });
    await db.insert(schema.planSteps).values({ id: stepId, planId, stepIndex: 0, description: "d", adapter: "agy", prompt: "p", status: "pending", role: "dev" });
    await runPlanStep({ planId, stepId, cwd });
    expect(fs.existsSync(path.join(cwd, ".orquestador"))).toBe(false);
  });
});

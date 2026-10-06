import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const quota = {
    exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "", summary: "", sessionId: null, model: null,
    costUsd: 0, inputTokens: 7, outputTokens: 3, errorMessage: "429 quota exceeded", errorFamily: "quota_exhausted", retryNotBefore: null,
  };
  return { execute: vi.fn(async (_ctx: any) => quota), quota };
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

beforeAll(async () => { await migrationDone; await createAccount("Prueba"); });
beforeEach(() => h.execute.mockClear());

async function mk() {
  const planId = randomUUID();
  const stepId = randomUUID();
  await db.insert(schema.plans).values({ id: planId, description: "p", status: "running" });
  await db.insert(schema.planSteps).values({ id: stepId, planId, stepIndex: 0, description: "d", adapter: "agy", prompt: "original", status: "pending" });
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

  it("promptOverride reemplaza el prompt guardado", async () => {
    const { planId, stepId, cwd } = await mk();
    await runPlanStep({ planId, stepId, cwd, promptOverride: "con contexto" });
    expect(h.execute.mock.calls[0][0].prompt).toBe("con contexto");
  });
});

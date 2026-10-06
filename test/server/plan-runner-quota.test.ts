import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AdapterExecutionResult } from "../../src/lib/types.js";

const quotaResult: AdapterExecutionResult = {
  exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "", summary: "", sessionId: null, model: null,
  costUsd: 0, inputTokens: 0, outputTokens: 0, errorMessage: "429 quota exceeded", errorFamily: "quota_exhausted", retryNotBefore: null,
};
const execute = vi.fn(async () => quotaResult);

vi.mock("../../src/adapters/registry.js", () => ({
  getAdapter: (t: string) => (t === "agy" ? { meta: { type: "agy" }, detect: async () => ({ available: true, resolvedPath: "x" }), execute } : undefined),
  adapters: {},
}));

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { runPlanAll, runPlanStep, QUOTA_PAUSE_PREFIX } = await import("../../src/server/plan-runner.js");
const { createAccount } = await import("../../src/server/agy-accounts.js");
const { eq } = await import("drizzle-orm");

beforeAll(async () => { await migrationDone; await createAccount("Prueba"); });
beforeEach(() => { execute.mockClear(); });

describe("pausa por cuota", () => {
  it("un paso agy con quota_exhausted no reintenta, vuelve a pending y el plan queda pending", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-"));
    const planId = randomUUID();
    const stepId = randomUUID();
    await db.insert(schema.plans).values({ id: planId, description: "p", status: "pending" });
    await db.insert(schema.planSteps).values({ id: stepId, planId, stepIndex: 0, description: "d", adapter: "agy", prompt: "x", status: "pending" });

    await runPlanAll(planId, cwd);

    expect(execute).toHaveBeenCalledTimes(1);
    const step = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId)).then((r) => r[0]);
    expect(step.status).toBe("pending");
    expect(step.errorMessage?.startsWith(QUOTA_PAUSE_PREFIX)).toBe(true);
    const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, planId)).then((r) => r[0]);
    expect(plan.status).toBe("pending");
    const usage = await db.select().from(schema.agyUsage);
    expect(usage.length).toBeGreaterThanOrEqual(1);
  });

  it("paso a paso (runPlanStep directo): pausa el plan en pending", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-"));
    const planId = randomUUID();
    const stepId = randomUUID();
    await db.insert(schema.plans).values({ id: planId, description: "p", status: "pending" });
    await db.insert(schema.planSteps).values({ id: stepId, planId, stepIndex: 0, description: "d", adapter: "agy", prompt: "x", status: "pending" });

    await runPlanStep({ planId, stepId, cwd });

    expect(execute).toHaveBeenCalledTimes(1);
    const step = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId)).then((r) => r[0]);
    expect(step.status).toBe("pending");
    expect(step.errorMessage?.startsWith(QUOTA_PAUSE_PREFIX)).toBe(true);
    const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, planId)).then((r) => r[0]);
    expect(plan.status).toBe("pending");
  });
});

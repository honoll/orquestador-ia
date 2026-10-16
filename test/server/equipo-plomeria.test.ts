import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({ execute: vi.fn(async (_ctx: any) => ({
  exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", summary: "ok", sessionId: "ses-1", model: null,
  costUsd: 0, inputTokens: 1, outputTokens: 1, errorMessage: null, errorFamily: null, retryNotBefore: null,
})) }));
vi.mock("../../src/adapters/registry.js", () => ({
  getAdapter: (t: string) => (t === "agy" ? { meta: { type: "agy" }, detect: async () => ({ available: true, resolvedPath: "x" }), execute: h.execute } : undefined),
  adapters: {},
}));
const runOnWorker = vi.hoisted(() => vi.fn((_t: any, _body: any) => ({ promise: Promise.resolve({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" }), kill: () => {} })));

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { eq } = await import("drizzle-orm");
const { runPlanStep } = await import("../../src/server/plan-runner.js");
const { createAccount } = await import("../../src/server/agy-accounts.js");
const { createWorker, pickWorker } = await import("../../src/server/agy-workers.js");

let localId = "";
beforeAll(async () => { await migrationDone; localId = (await createAccount("Local")).id; });

describe("plomería del turno", () => {
  it("runPlanStep pasa extraEnv al adaptador y anota la cuenta del intento", async () => {
    const planId = randomUUID(), stepId = randomUUID();
    await db.insert(schema.plans).values({ id: planId, description: "p", status: "running" });
    await db.insert(schema.planSteps).values({ id: stepId, planId, stepIndex: 0, description: "d", adapter: "agy", prompt: "x", status: "pending" });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plom-"));
    const out = await runPlanStep({ planId, stepId, cwd, extraEnv: { ORQ_API: "http://127.0.0.1:1", ORQ_TAREA: stepId, ORQ_TOKEN: "t" } });
    expect(out.status).toBe("succeeded");
    expect(h.execute.mock.calls[0][0].env).toEqual({ ORQ_API: "http://127.0.0.1:1", ORQ_TAREA: stepId, ORQ_TOKEN: "t" });
    const [row] = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId));
    expect(row.accountId).toBe(localId);
  });

  it("pickWorker con only reserva solo esa cuenta (o null si está ocupada)", async () => {
    const other = await createAccount("Otra");
    await createWorker({ accountId: other.id, port: 39001, keyPath: "C:/k/otra.key" });
    const a = await pickWorker(Date.now(), { only: other.id });
    expect(a?.accountId).toBe(other.id);
    expect(await pickWorker(Date.now(), { only: other.id })).toBeNull();
    a!.release();
  });
});

describe("agy en trabajador", () => {
  it("manda env ORQ_* y la sesión en el cuerpo de /run", async () => {
    vi.resetModules();
    vi.doMock("../../src/adapters/agy/worker-client.js", async (orig) => ({ ...(await orig<object>()), runOnWorker }));
    const { execute } = await import("../../src/adapters/agy/execute.js");
    await execute({
      runId: "r", prompt: "p", cwd: "C:/estudio/x", sessionId: "conv-9", agyWorker: { port: 3121, keyPath: "k" },
      env: { ORQ_API: "a", ORQ_TAREA: "b", ORQ_TOKEN: "c", OTRA: "no" }, onLog: () => {},
    });
    expect(runOnWorker.mock.calls[0][1]).toMatchObject({ sessionId: "conv-9", env: { ORQ_API: "a", ORQ_TAREA: "b", ORQ_TOKEN: "c" } });
    expect(runOnWorker.mock.calls[0][1].env).not.toHaveProperty("OTRA");
  });
});

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  runPlanDag: vi.fn(async () => {}),
  running: new Set<string>(),
  tier: { tier: "normal", confidence: null, source: "fallback" } as { tier: string; confidence: number | null; source: string },
  events: [] as Record<string, unknown>[],
  generatePlan: vi.fn(async () => ({
    steps: [{ stepIndex: 0, key: "s1", dependsOn: [], writes: false, estimatedTokens: 1000, description: "paso", adapter: "codex", model: "m", reason: "r", prompt: "p" }],
    estimatedTokens: 1000,
  })),
}));
vi.mock("../../src/server/plan-tier.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/server/plan-tier.js")>("../../src/server/plan-tier.js");
  return { ...actual, classifyTier: vi.fn(async () => h.tier), trivialWrites: vi.fn(async () => false) };
});
vi.mock("../../src/server/planner.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/server/planner.js")>("../../src/server/planner.js");
  return { ...actual, generatePlan: h.generatePlan };
});
vi.mock("../../src/memory/vault-index.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/memory/vault-index.js")>("../../src/memory/vault-index.js");
  return { ...actual, indexVault: vi.fn(async () => ({ scanned: 0, updated: 0, removed: 0, chunks: 0, failed: false })) };
});
vi.mock("../../src/server/ws.js", () => ({
  broadcast: (e: Record<string, unknown>) => { h.events.push(e); },
  addClient: () => {},
  removeClient: () => {},
}));
vi.mock("../../src/server/plan-scheduler.js", () => ({
  runPlanDag: h.runPlanDag,
  isPlanRunning: (id: string) => h.running.has(id),
  cancelPlanRun: vi.fn(() => true),
  retrySynthesis: vi.fn(async () => true),
}));

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { createPlan, startPlanIfAllowed } = await import("../../src/server/plan-create.js");
const { eq } = await import("drizzle-orm");

beforeAll(async () => { await migrationDone; });
beforeEach(() => { h.runPlanDag.mockClear(); h.running.clear(); h.events.length = 0; h.tier = { tier: "normal", confidence: null, source: "fallback" }; });

async function mk(extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.insert(schema.plans).values({ id, description: "d", status: "pending", ...extra } as typeof schema.plans.$inferInsert);
  return id;
}
async function waitFor(fn: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("timeout");
}

describe("startPlanIfAllowed", () => {
  it("plan normal pending → started y corre runPlanDag", async () => {
    const id = await mk({ tier: "normal" });
    expect(await startPlanIfAllowed(id)).toBe("started");
    expect(h.runPlanDag).toHaveBeenCalledWith(id, expect.any(String), { mode: "all" });
  });
  it("plan crítico → needs-approval sin ejecutar", async () => {
    const id = await mk({ tier: "critical" });
    expect(await startPlanIfAllowed(id)).toBe("needs-approval");
    expect(h.runPlanDag).not.toHaveBeenCalled();
  });
  it("generating o failed → not-ready", async () => {
    expect(await startPlanIfAllowed(await mk({ status: "generating" }))).toBe("not-ready");
    expect(await startPlanIfAllowed(await mk({ status: "failed" }))).toBe("not-ready");
    expect(h.runPlanDag).not.toHaveBeenCalled();
  });
  it("plan inexistente → not-ready", async () => {
    expect(await startPlanIfAllowed(randomUUID())).toBe("not-ready");
  });
  it("ya corriendo → running", async () => {
    const id = await mk();
    h.running.add(id);
    expect(await startPlanIfAllowed(id)).toBe("running");
    expect(h.runPlanDag).not.toHaveBeenCalled();
  });
});

describe("createPlan", () => {
  it("devuelve id, deja el plan generating y luego pending con pasos", async () => {
    const { id } = await createPlan({ description: "haz algo" });
    const first = await db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((r) => r[0]);
    expect(first).toBeTruthy();
    await waitFor(async () => (await db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((r) => r[0]))?.status === "pending");
    const steps = await db.select().from(schema.planSteps).where(eq(schema.planSteps.planId, id));
    expect(steps).toHaveLength(1);
    expect(h.events.some((e) => e.type === "plan:ready" && e.planId === id)).toBe(true);
    expect(h.runPlanDag).not.toHaveBeenCalled();
  });
});

describe("startPlanIfAllowed con requireJev (I6: voz sin JEV)", () => {
  it("tier por fallback o sin fuente: needs-jev-approval sin ejecutar", async () => {
    const a = await mk({ tier: "normal", tierSource: "fallback" });
    expect(await startPlanIfAllowed(a, { requireJev: true })).toBe("needs-jev-approval");
    const b = await mk({ tier: "normal", tierSource: null });
    expect(await startPlanIfAllowed(b, { requireJev: true })).toBe("needs-jev-approval");
    expect(h.runPlanDag).not.toHaveBeenCalled();
  });
  it("tier de JEV: normal arranca y crítico pide aprobación", async () => {
    const n = await mk({ tier: "normal", tierSource: "jev" });
    expect(await startPlanIfAllowed(n, { requireJev: true })).toBe("started");
    const c = await mk({ tier: "critical", tierSource: "jev" });
    expect(await startPlanIfAllowed(c, { requireJev: true })).toBe("needs-approval");
    expect(h.runPlanDag).toHaveBeenCalledTimes(1);
  });
  it("sin la opción el comportamiento no cambia", async () => {
    const id = await mk({ tier: "normal", tierSource: "fallback" });
    expect(await startPlanIfAllowed(id)).toBe("started");
  });
});

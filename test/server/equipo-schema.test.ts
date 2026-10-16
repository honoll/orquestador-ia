import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { eq } = await import("drizzle-orm");

beforeAll(async () => { await migrationDone; });

describe("esquema F14", () => {
  it("plans.mode vale 'pasos' por defecto y acepta 'equipo'; plan_steps tiene las columnas del árbol", async () => {
    const a = randomUUID(), b = randomUUID();
    await db.insert(schema.plans).values({ id: a, description: "x" });
    await db.insert(schema.plans).values({ id: b, description: "y", mode: "equipo", pauseReason: "manual" });
    const [pa] = await db.select().from(schema.plans).where(eq(schema.plans.id, a));
    const [pb] = await db.select().from(schema.plans).where(eq(schema.plans.id, b));
    expect(pa.mode).toBe("pasos");
    expect(pb.mode).toBe("equipo");
    const s = randomUUID();
    await db.insert(schema.planSteps).values({
      id: s, planId: b, stepIndex: 0, description: "d", adapter: "agy", prompt: "p",
      parentStepId: null, depth: 0, blockedBy: "[]", accountId: "acc", createdByStepId: null,
    });
    const [row] = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, s));
    expect(row).toMatchObject({ depth: 0, blockedBy: "[]", turns: 0, accountId: "acc", parentStepId: null });
  });

  it("tablas team_comments, team_wakeups y team_run_tokens", async () => {
    const p = randomUUID();
    await db.insert(schema.plans).values({ id: p, description: "z", mode: "equipo" });
    await db.insert(schema.teamComments).values({ id: randomUUID(), planId: p, stepId: "s", author: "humano", body: "hola" });
    await db.insert(schema.teamWakeups).values({ id: randomUUID(), planId: p, stepId: "s", reason: "asignada", createdAt: new Date().toISOString() });
    await db.insert(schema.teamRunTokens).values({ tokenHash: "h".repeat(64), planId: p, stepId: "s", expiresAt: new Date().toISOString() });
    const [w] = await db.select().from(schema.teamWakeups).where(eq(schema.teamWakeups.planId, p));
    expect(w).toMatchObject({ status: "en_cola", payload: "{}", takenAt: null });
    const [c] = await db.select().from(schema.teamComments).where(eq(schema.teamComments.planId, p));
    expect(c.createdAt).toBeTruthy();
  });
});

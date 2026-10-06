import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { migrationDone } from "../../src/db/migrate.js";
import { db, schema } from "../../src/db/index.js";

beforeAll(async () => { await migrationDone; });

describe("esquema F2", () => {
  it("plans tiene presupuesto, paralelismo, pausa y síntesis con defaults", async () => {
    const id = randomUUID();
    await db.insert(schema.plans).values({ id, description: "d", status: "pending" });
    const p = await db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((r) => r[0]);
    expect(p).toMatchObject({ usedTokens: 0, maxParallel: 3, budgetTokens: null, pauseReason: null, synthesis: null, synthesisStatus: null });
  });
  it("plan_steps guarda clave, dependencias, writes y estimación", async () => {
    const planId = randomUUID();
    await db.insert(schema.plans).values({ id: planId, description: "d", status: "pending" });
    const id = randomUUID();
    await db.insert(schema.planSteps).values({ id, planId, stepIndex: 0, description: "x", adapter: "codex", prompt: "p", status: "pending", stepKey: "s1", dependsOn: "[]", writes: 0, estimatedTokens: 5000 });
    const s = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, id)).then((r) => r[0]);
    expect(s).toMatchObject({ stepKey: "s1", dependsOn: "[]", writes: 0, estimatedTokens: 5000 });
  });
});

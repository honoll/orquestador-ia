import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { eq } = await import("drizzle-orm");
const { createGoal, createChildTask } = await import("../../src/server/equipo/tasks.js");
const { createAccount } = await import("../../src/server/agy-accounts.js");
const { loadRoles } = await import("../../src/server/roles.js");
const { buildBandejas, MAX_POR_GRUPO } = await import("../../src/server/equipo/bandejas.js");
const { createBandejasRoute } = await import("../../src/server/routes/bandejas.js");

beforeAll(async () => { await migrationDone; });

const S = schema.planSteps;
async function pasos(status: "running" | "pending", pauseReason: "quota" | null, description: string) {
  const id = randomUUID();
  await db.insert(schema.plans).values({ id, description, status, pauseReason });
  return id;
}
async function paso(planId: string, extra: Partial<typeof S.$inferInsert>) {
  const id = randomUUID();
  await db.insert(S).values({ id, planId, stepIndex: 0, description: "paso", adapter: "agy", prompt: "p", status: "pending", ...extra });
  return id;
}

describe("bandejas por rol", () => {
  it("agrupa trabajo activo de metas y planes por rol, en el orden de la barra", async () => {
    const acc = await createAccount("Cuenta B");
    const { planId: meta, rootStepId } = await createGoal({ pedido: "Meta X" });
    const dev = (await createChildTask(meta, rootStepId, { rol: "dev", titulo: "Código", instrucciones: "i", esperar: true })).id;
    await db.update(S).set({ status: "running", accountId: acc.id, startedAt: "2026-10-16T10:00:00.000Z" }).where(eq(S.id, dev));
    await createChildTask(meta, rootStepId, { rol: "redactor", titulo: "Textos", instrucciones: "i" });
    const plan = await pasos("running", null, "Plan P");
    await paso(plan, { role: "qa", status: "running", accountId: acc.id, description: "Probar", startedAt: "2026-10-16T10:05:00.000Z" });
    await paso(plan, { role: null, adapter: "claude", description: "Viejo sin rol" });
    const noCorrido = await pasos("pending", null, "Plan sin correr");
    await paso(noCorrido, { role: "dev", description: "No cuenta" });
    const pausado = await pasos("pending", "quota", "Plan pausado");
    await paso(pausado, { role: "lector", description: "En cola por pausa" });
    const cerrada = await createGoal({ pedido: "Meta cerrada" });
    await db.update(schema.plans).set({ status: "completed" }).where(eq(schema.plans.id, cerrada.planId));

    const out = await buildBandejas();
    expect(out.map((b) => b.rol)).toEqual(["jefe", ...loadRoles().map((r) => r.id).filter((id) => id !== "jefe"), "otros"]);
    const by = Object.fromEntries(out.map((b) => [b.rol, b]));
    expect(by.jefe.nombre).toBe("Jefe");
    expect(by.jefe.total).toEqual({ trabajando: 0, enCola: 0, esperando: 1 });
    expect(by.jefe.esperando[0]).toMatchObject({ id: rootStepId, modo: "equipo", meta: "Meta X", cuenta: "claude" });
    expect(by.dev.total).toEqual({ trabajando: 1, enCola: 0, esperando: 0 });
    expect(by.dev.trabajando[0]).toMatchObject({ id: dev, titulo: "Código", cuenta: "Cuenta B", desde: "2026-10-16T10:00:00.000Z", planId: meta });
    expect(by.redactor.enCola).toHaveLength(1);
    expect(by.qa.trabajando[0]).toMatchObject({ modo: "pasos", meta: "Plan P", cuenta: "Cuenta B" });
    expect(by.lector.enCola[0]).toMatchObject({ titulo: "En cola por pausa", modo: "pasos" });
    expect(by.otros.enCola[0]).toMatchObject({ titulo: "Viejo sin rol", cuenta: "claude" });
  });

  it("tope de 20 por grupo con el total completo", async () => {
    // Base nueva por archivo, pero esta prueba corre después de la anterior: se mide solo el rol 'investigador'.
    const { planId, rootStepId } = await createGoal({ pedido: "Muchas" });
    for (let i = 0; i < 25; i++) await createChildTask(planId, rootStepId, { rol: "investigador", titulo: `t${i}`, instrucciones: "i" });
    const inv = (await buildBandejas()).find((b) => b.rol === "investigador")!;
    expect(inv.enCola).toHaveLength(MAX_POR_GRUPO);
    expect(inv.total.enCola).toBe(25);
  });

  it("la ruta devuelve el arreglo", async () => {
    const r = await createBandejasRoute().request("/");
    expect(r.status).toBe(200);
    expect(Array.isArray(await r.json())).toBe(true);
  });
});

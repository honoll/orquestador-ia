import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { issueRunToken, verifyRunToken, revokeRunToken, revokePlanTokens } = await import("../../src/server/equipo/tokens.js");
const { TOKEN_TTL_MS, orqApi } = await import("../../src/server/equipo/constants.js");

beforeAll(async () => { await migrationDone; });

describe("tokens de turno", () => {
  it("emite 64 hex, guarda solo el hash y verifica su alcance", async () => {
    const scope = { planId: randomUUID(), stepId: randomUUID() };
    const t = await issueRunToken(scope);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    const rows = await db.select().from(schema.teamRunTokens);
    expect(rows.some((r) => r.tokenHash === t)).toBe(false);
    expect(await verifyRunToken(t)).toEqual(scope);
  });

  it("rechaza vacío, mal formado, desconocido y vencido", async () => {
    const t = await issueRunToken({ planId: "p", stepId: "s" }, 1_000);
    expect(await verifyRunToken(undefined)).toBeNull();
    expect(await verifyRunToken("xyz")).toBeNull();
    expect(await verifyRunToken("a".repeat(64))).toBeNull();
    expect(await verifyRunToken(t, 1_000 + TOKEN_TTL_MS - 1)).toEqual({ planId: "p", stepId: "s" });
    expect(await verifyRunToken(t, 1_000 + TOKEN_TTL_MS)).toBeNull();
  });

  it("revocar uno o todos los de una meta", async () => {
    const a = await issueRunToken({ planId: "m1", stepId: "s1" });
    const b = await issueRunToken({ planId: "m1", stepId: "s2" });
    const c = await issueRunToken({ planId: "m2", stepId: "s3" });
    await revokeRunToken(a);
    expect(await verifyRunToken(a)).toBeNull();
    await revokePlanTokens("m1");
    expect(await verifyRunToken(b)).toBeNull();
    expect(await verifyRunToken(c)).not.toBeNull();
  });

  it("ORQ_API usa ORQUESTADOR_PORT o 3110", () => {
    const old = process.env.ORQUESTADOR_PORT;
    delete process.env.ORQUESTADOR_PORT;
    expect(orqApi()).toBe("http://127.0.0.1:3110");
    process.env.ORQUESTADOR_PORT = "3111";
    expect(orqApi()).toBe("http://127.0.0.1:3111");
    if (old === undefined) delete process.env.ORQUESTADOR_PORT; else process.env.ORQUESTADOR_PORT = old;
  });
});

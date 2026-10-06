import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { migrationDone } from "../../src/db/migrate.js";
import { db, schema } from "../../src/db/index.js";
import {
  listAccounts, createAccount, activateAccount, updateAccount, deleteAccount,
  getActiveAccount, requireActiveAccount, recordAgyCall, NoActiveAccountError, AccountValidationError,
} from "../../src/server/agy-accounts.js";
import { HOUR_MS } from "../../src/lib/usage-meter.js";
import type { AdapterExecutionResult } from "../../src/lib/types.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const ok = (tokens: number): AdapterExecutionResult => ({
  exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", summary: "ok", sessionId: "c", model: null,
  costUsd: 0, inputTokens: tokens, outputTokens: 0, errorMessage: null, errorFamily: null, retryNotBefore: null,
});
const quota = (resetAt: string | null): AdapterExecutionResult => ({
  ...ok(0), exitCode: 1, summary: "", errorMessage: "quota exceeded", errorFamily: "quota_exhausted", retryNotBefore: resetAt,
});

beforeAll(async () => { await migrationDone; });
beforeEach(async () => {
  await db.delete(schema.agyUsage);
  await db.delete(schema.agyAccounts);
});

describe("cuentas agy", () => {
  it("la primera cuenta queda activa; la segunda no", async () => {
    const a = await createAccount("Familia A · 1", NOW);
    const b = await createAccount("Familia A · 2", NOW);
    expect(a.active).toBe(true);
    expect(b.active).toBe(false);
  });

  it("activar una desactiva las demás", async () => {
    const a = await createAccount("A", NOW);
    const b = await createAccount("B", NOW);
    await activateAccount(b.id);
    const list = await listAccounts(NOW);
    expect(list.find((x) => x.id === a.id)?.active).toBe(false);
    expect(list.find((x) => x.id === b.id)?.active).toBe(true);
    expect((await getActiveAccount())?.id).toBe(b.id);
  });

  it("sin cuentas, requireActiveAccount lanza NoActiveAccountError", async () => {
    await expect(requireActiveAccount()).rejects.toBeInstanceOf(NoActiveAccountError);
  });

  it("valida etiqueta y topes", async () => {
    await expect(createAccount("   ", NOW)).rejects.toBeInstanceOf(AccountValidationError);
    const a = await createAccount("A", NOW);
    await expect(updateAccount(a.id, { manualLimit5h: -5 }, NOW)).rejects.toBeInstanceOf(AccountValidationError);
    await expect(updateAccount(a.id, { manualLimit5h: 1.5 }, NOW)).rejects.toBeInstanceOf(AccountValidationError);
  });

  it("registra consumo y lo refleja en las ventanas", async () => {
    const a = await createAccount("A", NOW);
    await recordAgyCall(a.id, ok(1000), "chat", NOW - 1 * HOUR_MS);
    await recordAgyCall(a.id, ok(2000), "plan", NOW - 6 * HOUR_MS);
    const [v] = await listAccounts(NOW);
    expect(v.usage.short.usedTokens).toBe(1000);
    expect(v.usage.long.usedTokens).toBe(3000);
    expect(v.warn.warn).toBe(false);
  });

  it("error de cuota calibra el tope de 5 h y bloquea; un éxito posterior limpia el bloqueo", async () => {
    const a = await createAccount("A", NOW);
    await recordAgyCall(a.id, ok(5000), "chat", NOW - 1 * HOUR_MS);
    await recordAgyCall(a.id, quota("2026-10-06T14:00:00Z"), "chat", NOW);
    let [v] = await listAccounts(NOW);
    expect(v.calibratedLimit5h).toBe(5000);
    expect(v.quotaBlockedUntil).toBe("2026-10-06T14:00:00.000Z");
    expect(v.usage.short.pct).toBe(100);
    expect(v.warn).toEqual({ warn: true, reason: "Cuota agotada: conviene cambiar de cuenta" });

    await recordAgyCall(a.id, ok(10), "chat", NOW + 1000);
    [v] = await listAccounts(NOW + 1000);
    expect(v.quotaBlockedUntil).toBeNull();
  });

  it("el tope manual manda en el porcentaje", async () => {
    const a = await createAccount("A", NOW);
    await recordAgyCall(a.id, ok(900), "chat", NOW - HOUR_MS);
    const v = await updateAccount(a.id, { manualLimit5h: 1000 }, NOW);
    expect(v.usage.short).toMatchObject({ limitSource: "manual", pct: 90 });
    expect(v.warn.warn).toBe(true);
  });

  it("borrar una cuenta borra su consumo; si era la activa, activa otra", async () => {
    const a = await createAccount("A", NOW);
    const b = await createAccount("B", NOW);
    await recordAgyCall(a.id, ok(10), "chat", NOW);
    await deleteAccount(a.id);
    const rows = await db.select().from(schema.agyUsage);
    expect(rows).toHaveLength(0);
    expect((await getActiveAccount())?.id).toBe(b.id);
  });
});

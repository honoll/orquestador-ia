import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrationDone } from "../../src/db/migrate.js";
import { db, schema } from "../../src/db/index.js";
import { createAccount, updateAccount, recordAgyCall } from "../../src/server/agy-accounts.js";
import {
  createWorker, listWorkers, updateWorker, deleteWorker, importWorkers, pickWorker, agyAvailability, acquireAgy,
  parallelLimit, markWorkerHealth, WorkerValidationError, MAX_PARALLEL_CEILING,
} from "../../src/server/agy-workers.js";
import type { AdapterExecutionResult } from "../../src/lib/types.js";

const NOW = Date.now();
const ok = (tokens: number): AdapterExecutionResult => ({
  exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", summary: "ok", sessionId: null, model: null,
  costUsd: 0, inputTokens: tokens, outputTokens: 0, errorMessage: null, errorFamily: null, retryNotBefore: null,
});
const blockedUntil = new Date(NOW + 3_600_000).toISOString();

beforeAll(async () => { await migrationDone; });
beforeEach(async () => {
  await db.delete(schema.agyWorkers);
  await db.delete(schema.agyUsage);
  await db.delete(schema.agyAccounts);
});

/** local (activa, sin trabajador) + trabajadores con su propia bolsa salvo que se indique. */
async function setup(names: { label: string; pool?: string; port?: number }[]) {
  const out: Record<string, { accountId: string; workerId?: string }> = {};
  for (const n of names) {
    const a = await createAccount(n.label, NOW);
    if (n.pool) await updateAccount(a.id, { pool: n.pool }, NOW);
    const w = n.port ? await createWorker({ accountId: a.id, port: n.port, keyPath: `C:/k/${n.label}.key` }) : undefined;
    out[n.label] = { accountId: a.id, workerId: w?.id };
  }
  return out;
}

describe("CRUD de trabajadores", () => {
  it("crea, lista, edita, deshabilita y borra; valida puerto y cuenta", async () => {
    const s = await setup([{ label: "local" }, { label: "agy2", port: 3121 }]);
    const [w] = await listWorkers();
    expect(w).toMatchObject({ accountId: s.agy2.accountId, accountLabel: "agy2", port: 3121, enabled: true });
    expect(JSON.stringify(w)).not.toMatch(/[0-9a-f]{64}/);
    await expect(createWorker({ accountId: "nada", port: 3122, keyPath: "x.key" })).rejects.toBeInstanceOf(WorkerValidationError);
    await expect(createWorker({ accountId: s.local.accountId, port: 80, keyPath: "x.key" })).rejects.toBeInstanceOf(WorkerValidationError);
    await expect(createWorker({ accountId: s.agy2.accountId, port: 3125, keyPath: "x.key" })).rejects.toBeInstanceOf(WorkerValidationError);
    expect((await updateWorker(w.id, { enabled: false, port: 3130 })).port).toBe(3130);
    await deleteWorker(w.id);
    expect(await listWorkers()).toHaveLength(0);
  });

  it("importa los .json del directorio (sin leer llaves) y no duplica", async () => {
    await createAccount("local", NOW);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workers-"));
    fs.writeFileSync(path.join(dir, "agy2.json"), JSON.stringify({ account: "agy2", port: 3121, windowsUser: "agy2" }));
    fs.writeFileSync(path.join(dir, "agy3.json"), JSON.stringify({ account: "agy3", port: 3122, windowsUser: "agy3" }));
    fs.writeFileSync(path.join(dir, "malo.json"), "{no json");
    fs.writeFileSync(path.join(dir, "agy2.key"), "b".repeat(64));
    const r = await importWorkers(dir);
    expect(r.imported.map((x) => x.account).sort()).toEqual(["agy2", "agy3"]);
    expect(r.skipped).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain("b".repeat(64));
    const ws = await listWorkers();
    expect(ws.map((w) => [w.accountLabel, w.port, w.pool, w.keyPath])).toContainEqual(["agy2", 3121, "agy2", path.join(dir, "agy2.key")]);
    const again = await importWorkers(dir);
    expect(again.imported.every((x) => !x.accountCreated && !x.workerCreated)).toBe(true);
    expect(await listWorkers()).toHaveLength(2);
    const accounts = await db.select().from(schema.agyAccounts);
    expect(accounts.filter((a) => a.active === 1).map((a) => a.label)).toEqual(["local"]);
  });
});

describe("pickWorker", () => {
  it("elige la bolsa con más cuota libre; la local cuenta como trabajador sin puerto", async () => {
    const s = await setup([{ label: "local" }, { label: "agy2", port: 3121 }]);
    await updateAccount(s.local.accountId, { manualLimit5h: 1000 }, NOW);
    await updateAccount(s.agy2.accountId, { manualLimit5h: 1000 }, NOW);
    await recordAgyCall(s.local.accountId, ok(800), "plan", NOW - 1000);
    await recordAgyCall(s.agy2.accountId, ok(100), "plan", NOW - 1000);
    const a = await pickWorker(NOW);
    expect(a).toMatchObject({ accountId: s.agy2.accountId, worker: { port: 3121 } });
    const b = await pickWorker(NOW);
    expect(b).toMatchObject({ accountId: s.local.accountId, worker: null });
    expect(await pickWorker(NOW)).toBeNull(); // las dos ocupadas
    a!.release();
    expect((await pickWorker(NOW))?.accountId).toBe(s.agy2.accountId);
  });

  it("concurrencia: dos picks simultáneos nunca reservan la misma cuenta", async () => {
    await setup([{ label: "local" }, { label: "agy2", port: 3121 }]);
    const picks = await Promise.all([pickWorker(NOW), pickWorker(NOW), pickWorker(NOW)]);
    const ids = picks.filter(Boolean).map((p) => p!.accountId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    picks.forEach((p) => p?.release());
  });

  it("salta cuentas bloqueadas y deshabilitadas; null si ninguna", async () => {
    const s = await setup([{ label: "local" }, { label: "agy2", port: 3121 }, { label: "agy3", port: 3122 }]);
    await db.update(schema.agyAccounts).set({ quotaBlockedUntil: blockedUntil });
    await updateWorker(s.agy3.workerId!, { enabled: false });
    expect(await pickWorker(NOW)).toBeNull();
    expect(await agyAvailability(NOW)).toEqual({ total: 2, usable: 0 });
  });

  it("bolsa primero, luego el trabajador libre menos usado recientemente dentro de ella", async () => {
    const s = await setup([
      { label: "local", pool: "Plan 1" },
      { label: "agy2", pool: "Plan 1", port: 3121 },
      { label: "agy3", pool: "Plan 2", port: 3122 },
      { label: "agy4", pool: "Plan 2", port: 3123 },
    ]);
    for (const id of [s.local.accountId, s.agy3.accountId]) await updateAccount(id, { manualLimit5h: 1000 }, NOW);
    await recordAgyCall(s.agy2.accountId, ok(600), "plan", NOW - 1000); // Plan 1 lleva 60 %
    await recordAgyCall(s.agy4.accountId, ok(100), "plan", NOW - 1000); // Plan 2 lleva 10 %
    const first = await pickWorker(NOW);
    expect([s.agy3.accountId, s.agy4.accountId]).toContain(first!.accountId);
    first!.release();
    const second = await pickWorker(NOW); // empate dentro de la bolsa → el menos usado recientemente
    expect(second!.accountId).not.toBe(first!.accountId);
    const third = await pickWorker(NOW);
    expect(third!.accountId).toBe(first!.accountId);
    const fourth = await pickWorker(NOW); // Plan 2 sin trabajadores libres → Plan 1
    expect(fourth!.pool).toBe("Plan 1");
    for (const l of [second, third, fourth]) l!.release();
  });

  it("exclusión por bolsa (cuota) y por cuenta (no disponible)", async () => {
    const s = await setup([{ label: "local", pool: "P1" }, { label: "agy2", pool: "P1", port: 3121 }, { label: "agy3", pool: "P2", port: 3122 }]);
    const p = await pickWorker(NOW, { pools: new Set(["P2"]), accounts: new Set([s.local.accountId]) });
    expect(p?.accountId).toBe(s.agy2.accountId);
    p!.release();
  });

  it("acquireAgy espera a que se libere una cuenta; null si todas están excluidas o bloqueadas", async () => {
    const s = await setup([{ label: "local" }]);
    const a = (await acquireAgy())!;
    let got: string | null = null;
    const waiting = acquireAgy().then((l) => { got = l?.accountId ?? null; l?.release(); });
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toBeNull();
    a.release();
    await waiting;
    expect(got).toBe(s.local.accountId);
    expect(await acquireAgy({ accounts: new Set([s.local.accountId]) })).toBeNull();
    const ac = new AbortController();
    const held = (await acquireAgy())!;
    const aborted = acquireAgy({}, ac.signal);
    ac.abort();
    expect(await aborted).toBeNull();
    held.release();
  });
});

describe("parallelLimit", () => {
  it("= trabajadores habilitados y sanos-o-desconocidos (local incluida), mínimo 3, tope 16", async () => {
    expect(await parallelLimit()).toBe(3);
    const s = await setup([{ label: "local" }, { label: "agy2", port: 3121 }, { label: "agy3", port: 3122 }, { label: "agy4", port: 3123 }, { label: "agy5", port: 3124 }]);
    expect(await parallelLimit()).toBe(5);
    markWorkerHealth(s.agy5.workerId!, false);
    await updateWorker(s.agy4.workerId!, { enabled: false });
    expect(await parallelLimit()).toBe(3);
    markWorkerHealth(s.agy5.workerId!, true);
    expect(await parallelLimit()).toBe(4);
    expect(MAX_PARALLEL_CEILING).toBe(16);
  });
});

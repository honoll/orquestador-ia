/**
 * Trabajadores agy (F10): una cuenta de Google por usuario de Windows, cada una con su trabajador HTTP.
 * La cuenta "local" es la activa sin fila de trabajador: corre agy aquí mismo, como siempre.
 * Reparto: bolsa (plan de Google) con más cuota libre estimada → trabajador libre de esa bolsa usado hace más tiempo.
 * Las llaves nunca se leen aquí: solo se guarda su ruta (el cliente la lee al llamar).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { broadcast } from "./ws.js";
import { listAccounts, getActiveAccount, poolKey, type AccountView } from "./agy-accounts.js";
import { DEFAULT_MAX_PARALLEL } from "./plan-dag.js";

export const DEFAULT_WORKERS_DIR = "C:\\ProgramData\\orquestador-ia\\workers";
export const MAX_PARALLEL_CEILING = 16;
export const MIN_PARALLEL_LIMIT = DEFAULT_MAX_PARALLEL; // el default de max_parallel siempre es válido aunque haya menos trabajadores

export type WorkerRow = typeof schema.agyWorkers.$inferSelect;

export interface WorkerView {
  id: string;
  accountId: string;
  accountLabel: string;
  pool: string | null;
  port: number;
  keyPath: string;
  enabled: boolean;
  /** null = sin saber (nunca se probó o se recuperó). */
  healthy: boolean | null;
  busy: boolean;
  createdAt: string;
}

export interface AgyLease {
  accountId: string;
  label: string;
  /** Clave de la bolsa (pool, o el id de la cuenta si no tiene). */
  pool: string;
  worker: { id: string; port: number; keyPath: string } | null;
  release: () => void;
}

export interface AgyExclude {
  /** Bolsas sin cuota en este paso. */
  pools?: ReadonlySet<string>;
  /** Cuentas cuyo trabajador no respondió en este paso. */
  accounts?: ReadonlySet<string>;
}

export class WorkerValidationError extends Error {}

// Estado en memoria del proceso (el orquestador es el único cliente de los trabajadores).
const reserved = new Set<string>();
const lastUsed = new Map<string, number>();
const health = new Map<string, boolean>();
const waiters = new Set<() => void>();
let useSeq = 0;
let releaseSeq = 0;

function notify() {
  broadcast({ type: "accounts:changed", timestamp: new Date().toISOString() } as any);
}

export function markWorkerHealth(workerId: string, ok: boolean): void {
  health.set(workerId, ok);
}

function validPort(v: unknown): number {
  if (!Number.isInteger(v) || (v as number) < 1024 || (v as number) > 65535) throw new WorkerValidationError("El puerto debe ser un entero entre 1024 y 65535");
  return v as number;
}

function validKeyPath(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 500) throw new WorkerValidationError("keyPath debe ser una ruta de 1 a 500 caracteres");
  return v.trim();
}

async function getWorker(id: string): Promise<WorkerRow> {
  const row = await db.select().from(schema.agyWorkers).where(eq(schema.agyWorkers.id, id)).then((r) => r[0]);
  if (!row) throw new WorkerValidationError("Trabajador no encontrado");
  return row;
}

export async function listWorkers(): Promise<WorkerView[]> {
  const [rows, accounts] = await Promise.all([
    db.select().from(schema.agyWorkers).orderBy(schema.agyWorkers.port),
    db.select().from(schema.agyAccounts),
  ]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return rows.map((w) => ({
    id: w.id,
    accountId: w.accountId,
    accountLabel: byId.get(w.accountId)?.label ?? "?",
    pool: byId.get(w.accountId)?.pool ?? null,
    port: w.port,
    keyPath: w.keyPath,
    enabled: w.enabled === 1,
    healthy: health.get(w.id) ?? null,
    busy: reserved.has(w.accountId),
    createdAt: w.createdAt,
  }));
}

async function viewById(id: string): Promise<WorkerView> {
  const v = (await listWorkers()).find((w) => w.id === id);
  if (!v) throw new WorkerValidationError("Trabajador no encontrado");
  return v;
}

export async function createWorker(input: { accountId: unknown; port: unknown; keyPath: unknown; enabled?: unknown }): Promise<WorkerView> {
  const port = validPort(input.port);
  const keyPath = validKeyPath(input.keyPath);
  if (typeof input.accountId !== "string") throw new WorkerValidationError("accountId requerido");
  const acc = await db.select().from(schema.agyAccounts).where(eq(schema.agyAccounts.id, input.accountId)).then((r) => r[0]);
  if (!acc) throw new WorkerValidationError("Cuenta no encontrada");
  const dup = await db.select().from(schema.agyWorkers).where(eq(schema.agyWorkers.accountId, acc.id)).then((r) => r[0]);
  if (dup) throw new WorkerValidationError("Esa cuenta ya tiene trabajador");
  const id = randomUUID();
  await db.insert(schema.agyWorkers).values({ id, accountId: acc.id, port, keyPath, enabled: input.enabled === false ? 0 : 1 });
  notify();
  return viewById(id);
}

export async function updateWorker(id: string, patch: { port?: unknown; keyPath?: unknown; enabled?: unknown }): Promise<WorkerView> {
  await getWorker(id);
  const set: Partial<WorkerRow> = {};
  if (patch.port !== undefined) set.port = validPort(patch.port);
  if (patch.keyPath !== undefined) set.keyPath = validKeyPath(patch.keyPath);
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new WorkerValidationError("enabled debe ser booleano");
    set.enabled = patch.enabled ? 1 : 0;
  }
  if (Object.keys(set).length) {
    await db.update(schema.agyWorkers).set(set).where(eq(schema.agyWorkers.id, id));
    health.delete(id); // otro puerto/llave: salud desconocida otra vez
  }
  notify();
  return viewById(id);
}

export async function deleteWorker(id: string): Promise<void> {
  await getWorker(id);
  await db.delete(schema.agyWorkers).where(eq(schema.agyWorkers.id, id));
  health.delete(id);
  notify();
}

/** Lee `<dir>/*.json` ({account, port}) y crea la cuenta (bolsa = su nombre) y el trabajador que falten. */
export async function importWorkers(dir: string = process.env.AGY_WORKERS_DIR || DEFAULT_WORKERS_DIR) {
  const imported: { account: string; port: number; accountCreated: boolean; workerCreated: boolean }[] = [];
  const skipped: { file: string; error: string }[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json"));
  } catch (err) {
    throw new WorkerValidationError(`No se pudo leer el directorio de trabajadores: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
  }
  for (const file of files) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { account?: unknown; port?: unknown };
      if (typeof cfg.account !== "string" || !/^[a-z0-9-]{1,40}$/i.test(cfg.account)) throw new Error("account inválido");
      const port = validPort(cfg.port);
      const accounts = await db.select().from(schema.agyAccounts);
      let acc = accounts.find((a) => a.label === cfg.account);
      const accountCreated = !acc;
      if (!acc) {
        // Inactiva a propósito: la cuenta local (activa) es la del usuario normal.
        const id = randomUUID();
        await db.insert(schema.agyAccounts).values({ id, label: cfg.account, pool: cfg.account, active: 0 });
        acc = (await db.select().from(schema.agyAccounts).where(eq(schema.agyAccounts.id, id)))[0];
      }
      const has = await db.select().from(schema.agyWorkers).where(eq(schema.agyWorkers.accountId, acc.id)).then((r) => r[0]);
      if (!has) await db.insert(schema.agyWorkers).values({ id: randomUUID(), accountId: acc.id, port, keyPath: path.join(dir, `${cfg.account}.key`), enabled: 1 });
      imported.push({ account: cfg.account, port, accountCreated, workerCreated: !has });
    } catch (err) {
      skipped.push({ file, error: (err as Error).message.slice(0, 200) });
    }
  }
  notify();
  return { dir, imported, skipped };
}

interface Candidate {
  view: AccountView;
  pool: string;
  worker: WorkerRow | null;
}

/** Cuentas que pueden correr pasos de plan: trabajadores habilitados + la activa sin trabajador (local). */
async function candidates(now: number): Promise<Candidate[]> {
  const [views, workers, active] = await Promise.all([listAccounts(now), db.select().from(schema.agyWorkers), getActiveAccount()]);
  const byAccount = new Map(workers.map((w) => [w.accountId, w]));
  return views.flatMap((v): Candidate[] => {
    const w = byAccount.get(v.id);
    if (w) return w.enabled === 1 ? [{ view: v, pool: poolKey(v), worker: w }] : [];
    return v.id === active?.id ? [{ view: v, pool: poolKey(v), worker: null }] : [];
  });
}

const isBlocked = (v: AccountView, now: number) => !!v.quotaBlockedUntil && Date.parse(v.quotaBlockedUntil) > now;
const poolPct = (v: AccountView) => Math.max(v.poolUsage.short.pct ?? 0, v.poolUsage.long.pct ?? 0);

function usable(c: Candidate, now: number, ex: AgyExclude): boolean {
  return !isBlocked(c.view, now) && !ex.pools?.has(c.pool) && !ex.accounts?.has(c.view.id);
}

/** total = cuentas candidatas; usable = no bloqueadas ni excluidas (ocupadas cuentan como usables). */
export async function agyAvailability(now: number = Date.now(), ex: AgyExclude = {}): Promise<{ total: number; usable: number }> {
  const cands = await candidates(now);
  return { total: cands.length, usable: cands.filter((c) => usable(c, now, ex)).length };
}

/**
 * Elige y RESERVA una cuenta libre: bolsa con más cuota libre estimada (menor % usado de la bolsa, luego menos
 * tokens en 5 h), dentro de ella la usada hace más tiempo. null si no hay ninguna libre.
 */
export async function pickWorker(now: number = Date.now(), ex: AgyExclude = {}): Promise<AgyLease | null> {
  const cands = (await candidates(now)).filter((c) => usable(c, now, ex));
  // Sin await desde aquí hasta reservar: dos pasos concurrentes nunca toman la misma cuenta.
  const pick = cands
    .filter((c) => !reserved.has(c.view.id))
    .sort((a, b) =>
      poolPct(a.view) - poolPct(b.view) ||
      a.view.poolUsage.short.usedTokens - b.view.poolUsage.short.usedTokens ||
      a.pool.localeCompare(b.pool) ||
      (lastUsed.get(a.view.id) ?? 0) - (lastUsed.get(b.view.id) ?? 0))[0];
  if (!pick) return null;
  const accountId = pick.view.id;
  reserved.add(accountId);
  lastUsed.set(accountId, ++useSeq);
  let released = false;
  return {
    accountId,
    label: pick.view.label,
    pool: pick.pool,
    worker: pick.worker ? { id: pick.worker.id, port: pick.worker.port, keyPath: pick.worker.keyPath } : null,
    release: () => {
      if (released) return;
      released = true;
      reserved.delete(accountId);
      releaseSeq++;
      for (const wake of [...waiters]) wake();
    },
  };
}

/** Como pickWorker, pero si todas las usables están ocupadas espera a que se libere una. null si no queda ninguna usable o se abortó. */
export async function acquireAgy(ex: AgyExclude = {}, signal?: AbortSignal): Promise<AgyLease | null> {
  for (;;) {
    if (signal?.aborted) return null;
    const seen = releaseSeq;
    const lease = await pickWorker(Date.now(), ex);
    if (lease) {
      if (signal?.aborted) { lease.release(); return null; }
      return lease;
    }
    if ((await agyAvailability(Date.now(), ex)).usable === 0) return null;
    if (signal?.aborted) return null;
    if (releaseSeq !== seen) continue; // se liberó una mientras se consultaba la base
    await new Promise<void>((resolve) => {
      const wake = () => { waiters.delete(wake); signal?.removeEventListener("abort", wake); resolve(); };
      waiters.add(wake);
      signal?.addEventListener("abort", wake, { once: true });
    });
  }
}

/** Tope de max_parallel: trabajadores habilitados sanos o sin saber (local incluida), entre 3 y 16. */
export async function parallelLimit(): Promise<number> {
  const [workers, active] = await Promise.all([db.select().from(schema.agyWorkers), getActiveAccount()]);
  const withWorker = new Set(workers.map((w) => w.accountId));
  const count = workers.filter((w) => w.enabled === 1 && health.get(w.id) !== false).length
    + (active && !withWorker.has(active.id) ? 1 : 0);
  return Math.min(MAX_PARALLEL_CEILING, Math.max(MIN_PARALLEL_LIMIT, count));
}

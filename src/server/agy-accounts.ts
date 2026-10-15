import { randomUUID } from "node:crypto";
import { eq, and, gte, ne, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { broadcast } from "./ws.js";
import type { AdapterExecutionResult } from "../lib/types.js";
import {
  HOUR_MS, WINDOWS, windowUsage, warnState, calibrateOnQuota, blockUntil,
  type UsagePoint, type WindowUsage, type WarnState,
} from "../lib/usage-meter.js";

export type AgyAccountRow = typeof schema.agyAccounts.$inferSelect;

export interface AccountView {
  id: string;
  label: string;
  active: boolean;
  manualLimit5h: number | null;
  manualLimit7d: number | null;
  calibratedLimit5h: number | null;
  quotaBlockedUntil: string | null;
  quotaBlockedAt: string | null;
  notes: string | null;
  /** Bolsa de cuota; null = la cuenta sola (clave = su id). */
  pool: string | null;
  /** Uso de esta cuenta (para mostrar). */
  usage: { short: WindowUsage; long: WindowUsage };
  /** Uso de toda su bolsa: es lo que decide bloqueo, aviso y reparto. */
  poolUsage: { short: WindowUsage; long: WindowUsage };
  warn: WarnState;
  /** Tiene trabajador (otro usuario de Windows): no se puede activar como cuenta local. */
  hasWorker: boolean;
}

export class NoActiveAccountError extends Error {
  constructor() {
    super("No hay cuenta de Antigravity activa: agrega o activa una en el panel de cuentas.");
  }
}

export class AccountValidationError extends Error {}
/** La acción choca con el estado (p. ej. activar una cuenta que corre en un trabajador): 409. */
export class AccountConflictError extends Error {}

function validLabel(label: string): string {
  const t = label.trim();
  if (!t || t.length > 80) throw new AccountValidationError("La etiqueta debe tener entre 1 y 80 caracteres");
  return t;
}

function validLimit(v: number | null | undefined): number | null | undefined {
  if (v === undefined || v === null) return v;
  if (!Number.isInteger(v) || v <= 0) throw new AccountValidationError("El tope debe ser un entero positivo de tokens");
  return v;
}

export const poolKey = (row: { id: string; pool: string | null }): string => row.pool ?? row.id;

async function usagePoints(accountIds: string[], now: number): Promise<(UsagePoint & { accountId: string })[]> {
  const from = new Date(now - WINDOWS.long * HOUR_MS).toISOString();
  const rows = await db.select().from(schema.agyUsage)
    .where(and(inArray(schema.agyUsage.accountId, accountIds), gte(schema.agyUsage.at, from)));
  return rows.map((r) => ({ at: Date.parse(r.at), tokens: r.inputTokens + r.outputTokens, accountId: r.accountId }));
}

const maxOf = (vals: (number | null)[]): number | null => {
  const v = vals.filter((x): x is number => x !== null);
  return v.length ? Math.max(...v) : null;
};

/** Ventanas 5 h / 7 d; un bloqueo vigente muestra la corta llena aunque el tope estimado diga otra cosa. */
function windows(points: UsagePoint[], now: number, blocked: number | null, l5h: number | null, cal5h: number | null, l7d: number | null) {
  let short = windowUsage(points, now, WINDOWS.short, l5h, cal5h);
  if (blocked !== null && blocked > now) short = { ...short, pct: 100, resetsAt: blocked };
  return { short, long: windowUsage(points, now, WINDOWS.long, l7d, null) };
}

async function poolMembers(row: AgyAccountRow): Promise<AgyAccountRow[]> {
  const all = await db.select().from(schema.agyAccounts);
  return all.filter((r) => poolKey(r) === poolKey(row));
}

async function toView(row: AgyAccountRow, now: number, all: AgyAccountRow[], withWorker: ReadonlySet<string>): Promise<AccountView> {
  const members = all.filter((r) => poolKey(r) === poolKey(row));
  const poolPoints = await usagePoints(members.map((m) => m.id), now);
  const points = poolPoints.filter((p) => p.accountId === row.id);
  const blocked = row.quotaBlockedUntil ? Date.parse(row.quotaBlockedUntil) : null;
  const { short, long } = windows(points, now, blocked, row.manualLimit5h, row.calibratedLimit5h, row.manualLimit7d);
  // Topes de la bolsa: el mayor que tenga algún miembro (la calibración se escribe igual en todos).
  const poolUsage = windows(poolPoints, now, blocked,
    maxOf(members.map((m) => m.manualLimit5h)), maxOf(members.map((m) => m.calibratedLimit5h)), maxOf(members.map((m) => m.manualLimit7d)));
  return {
    id: row.id,
    label: row.label,
    active: row.active === 1,
    manualLimit5h: row.manualLimit5h,
    manualLimit7d: row.manualLimit7d,
    calibratedLimit5h: row.calibratedLimit5h,
    quotaBlockedUntil: row.quotaBlockedUntil,
    quotaBlockedAt: row.quotaBlockedAt,
    notes: row.notes,
    pool: row.pool,
    usage: { short, long },
    poolUsage,
    warn: warnState([poolUsage.short, poolUsage.long], blocked, now),
    hasWorker: withWorker.has(row.id),
  };
}

function notify() {
  broadcast({ type: "accounts:changed", timestamp: new Date().toISOString() } as any);
}

const accountsWithWorker = async () => new Set((await db.select({ id: schema.agyWorkers.accountId }).from(schema.agyWorkers)).map((w) => w.id));

async function viewOf(id: string, now: number): Promise<AccountView> {
  const row = await getRow(id);
  return toView(row, now, await db.select().from(schema.agyAccounts), await accountsWithWorker());
}

async function getRow(id: string): Promise<AgyAccountRow> {
  const row = await db.select().from(schema.agyAccounts).where(eq(schema.agyAccounts.id, id)).then((r) => r[0]);
  if (!row) throw new AccountValidationError("Cuenta no encontrada");
  return row;
}

export async function listAccounts(now: number = Date.now()): Promise<AccountView[]> {
  const rows = await db.select().from(schema.agyAccounts).orderBy(schema.agyAccounts.createdAt);
  const withWorker = await accountsWithWorker();
  return Promise.all(rows.map((r) => toView(r, now, rows, withWorker)));
}

export async function getActiveAccount(): Promise<AgyAccountRow | null> {
  return db.select().from(schema.agyAccounts).where(eq(schema.agyAccounts.active, 1)).then((r) => r[0] ?? null);
}

export async function requireActiveAccount(): Promise<AgyAccountRow> {
  const row = await getActiveAccount();
  if (!row) throw new NoActiveAccountError();
  return row;
}

export async function createAccount(label: string, now: number = Date.now()): Promise<AccountView> {
  const clean = validLabel(label);
  const hasActive = (await getActiveAccount()) !== null;
  const id = randomUUID();
  await db.insert(schema.agyAccounts).values({ id, label: clean, pool: clean, active: hasActive ? 0 : 1, createdAt: new Date(now).toISOString() });
  notify();
  return viewOf(id, now);
}

export async function activateAccount(id: string): Promise<void> {
  await getRow(id);
  // La "activa" es la credencial del usuario normal (chat, voz, análisis y el asiento local): una cuenta de
  // trabajador corre con otro usuario de Windows, así que activarla cruzaría el uso y la cuota de dos bolsas.
  if ((await accountsWithWorker()).has(id)) {
    throw new AccountConflictError("Esa cuenta tiene trabajador (otro usuario de Windows): ya corre pasos de plan por su cuenta y no se puede usar como la cuenta local.");
  }
  await db.transaction(async (tx) => {
    // Primero desactivar, luego activar: respeta el índice único de cuenta activa.
    await tx.update(schema.agyAccounts).set({ active: 0 }).where(ne(schema.agyAccounts.id, id));
    await tx.update(schema.agyAccounts).set({ active: 1 }).where(eq(schema.agyAccounts.id, id));
  });
  notify();
}

export async function updateAccount(
  id: string,
  patch: { label?: string; pool?: string | null; manualLimit5h?: number | null; manualLimit7d?: number | null; notes?: string | null },
  now: number = Date.now(),
): Promise<AccountView> {
  await getRow(id);
  const set: Partial<AgyAccountRow> = {};
  if (patch.label !== undefined) set.label = validLabel(patch.label);
  if (patch.manualLimit5h !== undefined) set.manualLimit5h = validLimit(patch.manualLimit5h) ?? null;
  if (patch.manualLimit7d !== undefined) set.manualLimit7d = validLimit(patch.manualLimit7d) ?? null;
  if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null;
  if (patch.pool !== undefined) set.pool = patch.pool === null ? null : validLabel(patch.pool);
  if (Object.keys(set).length) await db.update(schema.agyAccounts).set(set).where(eq(schema.agyAccounts.id, id));
  notify();
  return viewOf(id, now);
}

export async function deleteAccount(id: string): Promise<void> {
  const row = await getRow(id);
  await db.transaction(async (tx) => {
    await tx.delete(schema.agyWorkers).where(eq(schema.agyWorkers.accountId, id));
    await tx.delete(schema.agyUsage).where(eq(schema.agyUsage.accountId, id));
    await tx.delete(schema.agyAccounts).where(eq(schema.agyAccounts.id, id));
    if (row.active === 1) {
      const next = await tx.select().from(schema.agyAccounts).orderBy(schema.agyAccounts.createdAt).then((r) => r[0]);
      if (next) await tx.update(schema.agyAccounts).set({ active: 1 }).where(eq(schema.agyAccounts.id, next.id));
    }
  });
  notify();
}

/** Registra el consumo de una llamada a agy; si fue error de cuota calibra y bloquea TODA la bolsa de la cuenta. */
export async function recordAgyCall(
  accountId: string,
  result: AdapterExecutionResult,
  source: "chat" | "plan" | "analysis" | "voice",
  now: number = Date.now(),
  startedAt: number = now,
): Promise<void> {
  const row = await getRow(accountId);
  await db.insert(schema.agyUsage).values({
    id: randomUUID(),
    accountId,
    at: new Date(now).toISOString(),
    inputTokens: result.inputTokens || 0,
    outputTokens: result.outputTokens || 0,
    source,
  });

  const members = await poolMembers(row);
  const ids = members.map((m) => m.id);
  if (result.errorFamily === "quota_exhausted") {
    const points = await usagePoints(ids, now);
    await db.update(schema.agyAccounts).set({
      calibratedLimit5h: calibrateOnQuota(points, now, maxOf(members.map((m) => m.calibratedLimit5h))),
      quotaBlockedUntil: new Date(blockUntil(result.retryNotBefore, now)).toISOString(),
      quotaBlockedAt: new Date(now).toISOString(),
    }).where(inArray(schema.agyAccounts.id, ids));
  } else if (
    result.exitCode === 0 && row.quotaBlockedUntil &&
    // Un éxito de una llamada que empezó antes del bloqueo no lo desmiente.
    (!row.quotaBlockedAt || startedAt > Date.parse(row.quotaBlockedAt))
  ) {
    await db.update(schema.agyAccounts).set({ quotaBlockedUntil: null, quotaBlockedAt: null }).where(inArray(schema.agyAccounts.id, ids));
  }
  notify();
}

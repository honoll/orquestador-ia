import { randomUUID } from "node:crypto";
import { eq, and, gte, ne } from "drizzle-orm";
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
  usage: { short: WindowUsage; long: WindowUsage };
  warn: WarnState;
}

export class NoActiveAccountError extends Error {
  constructor() {
    super("No hay cuenta de Antigravity activa: agrega o activa una en el panel de cuentas.");
  }
}

export class AccountValidationError extends Error {}

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

async function usagePoints(accountId: string, now: number): Promise<UsagePoint[]> {
  const from = new Date(now - WINDOWS.long * HOUR_MS).toISOString();
  const rows = await db.select().from(schema.agyUsage)
    .where(and(eq(schema.agyUsage.accountId, accountId), gte(schema.agyUsage.at, from)));
  return rows.map((r) => ({ at: Date.parse(r.at), tokens: r.inputTokens + r.outputTokens }));
}

async function toView(row: AgyAccountRow, now: number): Promise<AccountView> {
  const points = await usagePoints(row.id, now);
  const blocked = row.quotaBlockedUntil ? Date.parse(row.quotaBlockedUntil) : null;
  let short = windowUsage(points, now, WINDOWS.short, row.manualLimit5h, row.calibratedLimit5h);
  // Bloqueo vigente: la ventana corta se muestra llena aunque el tope estimado diga otra cosa.
  if (blocked !== null && blocked > now) short = { ...short, pct: 100, resetsAt: blocked };
  const long = windowUsage(points, now, WINDOWS.long, row.manualLimit7d, null);
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
    usage: { short, long },
    warn: warnState([short, long], blocked, now),
  };
}

function notify() {
  broadcast({ type: "accounts:changed", timestamp: new Date().toISOString() } as any);
}

async function getRow(id: string): Promise<AgyAccountRow> {
  const row = await db.select().from(schema.agyAccounts).where(eq(schema.agyAccounts.id, id)).then((r) => r[0]);
  if (!row) throw new AccountValidationError("Cuenta no encontrada");
  return row;
}

export async function listAccounts(now: number = Date.now()): Promise<AccountView[]> {
  const rows = await db.select().from(schema.agyAccounts).orderBy(schema.agyAccounts.createdAt);
  return Promise.all(rows.map((r) => toView(r, now)));
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
  await db.insert(schema.agyAccounts).values({ id, label: clean, active: hasActive ? 0 : 1, createdAt: new Date(now).toISOString() });
  notify();
  return toView(await getRow(id), now);
}

export async function activateAccount(id: string): Promise<void> {
  await getRow(id);
  await db.transaction(async (tx) => {
    // Primero desactivar, luego activar: respeta el índice único de cuenta activa.
    await tx.update(schema.agyAccounts).set({ active: 0 }).where(ne(schema.agyAccounts.id, id));
    await tx.update(schema.agyAccounts).set({ active: 1 }).where(eq(schema.agyAccounts.id, id));
  });
  notify();
}

export async function updateAccount(
  id: string,
  patch: { label?: string; manualLimit5h?: number | null; manualLimit7d?: number | null; notes?: string | null },
  now: number = Date.now(),
): Promise<AccountView> {
  await getRow(id);
  const set: Partial<AgyAccountRow> = {};
  if (patch.label !== undefined) set.label = validLabel(patch.label);
  if (patch.manualLimit5h !== undefined) set.manualLimit5h = validLimit(patch.manualLimit5h) ?? null;
  if (patch.manualLimit7d !== undefined) set.manualLimit7d = validLimit(patch.manualLimit7d) ?? null;
  if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null;
  if (Object.keys(set).length) await db.update(schema.agyAccounts).set(set).where(eq(schema.agyAccounts.id, id));
  notify();
  return toView(await getRow(id), now);
}

export async function deleteAccount(id: string): Promise<void> {
  const row = await getRow(id);
  await db.transaction(async (tx) => {
    await tx.delete(schema.agyUsage).where(eq(schema.agyUsage.accountId, id));
    await tx.delete(schema.agyAccounts).where(eq(schema.agyAccounts.id, id));
    if (row.active === 1) {
      const next = await tx.select().from(schema.agyAccounts).orderBy(schema.agyAccounts.createdAt).then((r) => r[0]);
      if (next) await tx.update(schema.agyAccounts).set({ active: 1 }).where(eq(schema.agyAccounts.id, next.id));
    }
  });
  notify();
}

/** Registra el consumo de una llamada a agy; calibra y bloquea si fue error de cuota. */
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

  if (result.errorFamily === "quota_exhausted") {
    const points = await usagePoints(accountId, now);
    await db.update(schema.agyAccounts).set({
      calibratedLimit5h: calibrateOnQuota(points, now, row.calibratedLimit5h),
      quotaBlockedUntil: new Date(blockUntil(result.retryNotBefore, now)).toISOString(),
      quotaBlockedAt: new Date(now).toISOString(),
    }).where(eq(schema.agyAccounts.id, accountId));
  } else if (
    result.exitCode === 0 && row.quotaBlockedUntil &&
    // Un éxito de una llamada que empezó antes del bloqueo no lo desmiente.
    (!row.quotaBlockedAt || startedAt > Date.parse(row.quotaBlockedAt))
  ) {
    await db.update(schema.agyAccounts).set({ quotaBlockedUntil: null, quotaBlockedAt: null }).where(eq(schema.agyAccounts.id, accountId));
  }
  notify();
}

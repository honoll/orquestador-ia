/**
 * Medidor ESTIMADO de uso por cuenta de Antigravity. Google no expone la cuota:
 * se suman los tokens que reporta cada llamada y se calibra el tope con el primer
 * error de cuota. Funciones puras con reloj inyectable (`now` en ms).
 */
export const HOUR_MS = 3_600_000;
export const WINDOWS = { short: 5, long: 168 } as const;
export const WARN_PCT = 85;

export interface UsagePoint {
  at: number;
  tokens: number;
}

export interface WindowUsage {
  windowHours: number;
  usedTokens: number;
  limitTokens: number | null;
  limitSource: "manual" | "calibrated" | null;
  pct: number | null;
  resetsAt: number | null;
}

export interface WarnState {
  warn: boolean;
  reason: string | null;
}

/** "YYYY-MM-DD HH:MM:SS" (SQLite, UTC) o ISO 8601 → ms. */
export function parseDbTime(s: string): number {
  return Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
}

function inWindow(points: UsagePoint[], now: number, windowHours: number): UsagePoint[] {
  const from = now - windowHours * HOUR_MS;
  return points.filter((p) => p.at > from && p.at <= now);
}

export function usedInWindow(points: UsagePoint[], now: number, windowHours: number): number {
  return inWindow(points, now, windowHours).reduce((sum, p) => sum + p.tokens, 0);
}

export function windowUsage(
  points: UsagePoint[],
  now: number,
  windowHours: number,
  manualLimit: number | null,
  calibratedLimit: number | null,
): WindowUsage {
  const pts = inWindow(points, now, windowHours);
  const usedTokens = pts.reduce((sum, p) => sum + p.tokens, 0);
  const limitTokens = manualLimit ?? calibratedLimit ?? null;
  const limitSource = manualLimit != null ? "manual" : calibratedLimit != null ? "calibrated" : null;
  const pct = limitTokens && limitTokens > 0 ? Math.min(100, Math.round((usedTokens * 100) / limitTokens)) : null;
  const oldest = pts.length ? Math.min(...pts.map((p) => p.at)) : null;
  return {
    windowHours,
    usedTokens,
    limitTokens,
    limitSource,
    pct,
    resetsAt: oldest === null ? null : oldest + windowHours * HOUR_MS,
  };
}

export function warnState(windows: WindowUsage[], blockedUntil: number | null, now: number): WarnState {
  if (blockedUntil !== null && blockedUntil > now) {
    return { warn: true, reason: "Cuota agotada: conviene cambiar de cuenta" };
  }
  const hot = windows
    .filter((w) => w.pct !== null && w.pct >= WARN_PCT)
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0];
  if (hot) {
    return { warn: true, reason: `~${hot.pct} % usado en la ventana de ${hot.windowHours} h: conviene cambiar de cuenta` };
  }
  return { warn: false, reason: null };
}

/** Al agotarse la cuota, lo gastado en la ventana corta se vuelve el tope calibrado. */
export function calibrateOnQuota(points: UsagePoint[], now: number, previousCalibrated: number | null): number | null {
  const used = usedInWindow(points, now, WINDOWS.short);
  return used > 0 ? used : previousCalibrated;
}

/** Hasta cuándo se considera bloqueada la cuenta tras un error de cuota. */
export function blockUntil(resetAt: string | null, now: number): number {
  const t = resetAt ? Date.parse(resetAt) : Number.NaN;
  return Number.isFinite(t) && t > now ? t : now + WINDOWS.short * HOUR_MS;
}

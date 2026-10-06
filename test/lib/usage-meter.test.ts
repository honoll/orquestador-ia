import { describe, it, expect } from "vitest";
import {
  HOUR_MS, WARN_PCT, parseDbTime, usedInWindow, windowUsage, warnState, calibrateOnQuota, blockUntil,
} from "../../src/lib/usage-meter.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const ago = (h: number) => NOW - h * HOUR_MS;
const pts = [
  { at: ago(0.5), tokens: 1000 },
  { at: ago(4.9), tokens: 2000 },
  { at: ago(6), tokens: 4000 },     // fuera de 5 h, dentro de 7 d
  { at: ago(200), tokens: 8000 },   // fuera de todo
];

describe("usage-meter", () => {
  it("parseDbTime acepta formato SQLite (UTC) e ISO", () => {
    expect(parseDbTime("2026-10-06 12:00:00")).toBe(NOW);
    expect(parseDbTime("2026-10-06T12:00:00.000Z")).toBe(NOW);
  });

  it("usedInWindow suma solo dentro de la ventana", () => {
    expect(usedInWindow(pts, NOW, 5)).toBe(3000);
    expect(usedInWindow(pts, NOW, 168)).toBe(7000);
  });

  it("sin tope: pct null y resetsAt = punto más viejo + ventana", () => {
    const w = windowUsage(pts, NOW, 5, null, null);
    expect(w).toEqual({ windowHours: 5, usedTokens: 3000, limitTokens: null, limitSource: null, pct: null, resetsAt: ago(4.9) + 5 * HOUR_MS });
  });

  it("el tope manual manda sobre el calibrado", () => {
    expect(windowUsage(pts, NOW, 5, 6000, 3000)).toMatchObject({ limitTokens: 6000, limitSource: "manual", pct: 50 });
    expect(windowUsage(pts, NOW, 5, null, 4000)).toMatchObject({ limitTokens: 4000, limitSource: "calibrated", pct: 75 });
  });

  it("pct se topa en 100", () => {
    expect(windowUsage(pts, NOW, 5, 1000, null).pct).toBe(100);
  });

  it("ventana vacía: usado 0 y sin reinicio", () => {
    expect(windowUsage([], NOW, 5, 100, null)).toMatchObject({ usedTokens: 0, pct: 0, resetsAt: null });
  });

  it(`aviso desde ${WARN_PCT} %`, () => {
    const at84 = windowUsage([{ at: ago(1), tokens: 84 }], NOW, 5, 100, null);
    const at85 = windowUsage([{ at: ago(1), tokens: 85 }], NOW, 5, 100, null);
    expect(warnState([at84], null, NOW).warn).toBe(false);
    expect(warnState([at85], null, NOW)).toEqual({ warn: true, reason: "~85 % usado en la ventana de 5 h: conviene cambiar de cuenta" });
  });

  it("bloqueo vigente avisa; bloqueo vencido no", () => {
    expect(warnState([], NOW + 1, NOW)).toEqual({ warn: true, reason: "Cuota agotada: conviene cambiar de cuenta" });
    expect(warnState([], NOW - 1, NOW).warn).toBe(false);
  });

  it("calibrateOnQuota toma lo gastado en 5 h; si fue 0 conserva el anterior", () => {
    expect(calibrateOnQuota(pts, NOW, null)).toBe(3000);
    expect(calibrateOnQuota([], NOW, 5000)).toBe(5000);
    expect(calibrateOnQuota([], NOW, null)).toBeNull();
  });

  it("blockUntil usa la hora de reinicio futura o estima ahora + 5 h", () => {
    expect(blockUntil("2026-10-06T15:00:00Z", NOW)).toBe(Date.parse("2026-10-06T15:00:00Z"));
    expect(blockUntil("2026-10-06T11:00:00Z", NOW)).toBe(NOW + 5 * HOUR_MS);
    expect(blockUntil(null, NOW)).toBe(NOW + 5 * HOUR_MS);
  });
});

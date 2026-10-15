import { describe, it, expect } from "vitest";
import { readView, refreshesOffice, sceneScale, planTag, queueTag, signLine, clock, appendLog, LOG_MAX, viewLocked, talkLabel, readOfficeMode } from "../../ui/src/lib/office-view.js";

describe("readView", () => {
  it("?vista=oficina gana sobre lo guardado", () => {
    expect(readView("?vista=oficina", "chat")).toBe("oficina");
    expect(readView("?x=1&vista=chat", "oficina")).toBe("chat");
  });
  it("sin parámetro usa lo guardado", () => {
    expect(readView("", "oficina")).toBe("oficina");
    expect(readView("", "chat")).toBe("chat");
    expect(readView("", "roles")).toBe("roles");
    expect(readView("?vista=roles", "chat")).toBe("roles");
  });
  it("localStorage inválido o vacío → chat", () => {
    expect(readView("", "basura")).toBe("chat");
    expect(readView("", null)).toBe("chat");
    expect(readView("?vista=otra", "nada")).toBe("chat");
  });
});

describe("readOfficeMode", () => {
  it("readOfficeMode: mundo por defecto; escritorios si está guardado; inválido → mundo", () => {
    expect(readOfficeMode(null)).toBe("mundo");
    expect(readOfficeMode("escritorios")).toBe("escritorios");
    expect(readOfficeMode("otro")).toBe("mundo");
  });
});

describe("refreshesOffice", () => {
  it.each(["plan:step", "plan:done", "run:status", "memory:indexed", "voice:assistant:turn-done", "accounts:changed"])("%s refresca", (t) => {
    expect(refreshesOffice(t)).toBe(true);
  });
  it.each(["log", "adapters:status", "planning", "memory:other"])("%s no refresca", (t) => {
    expect(refreshesOffice(t)).toBe(false);
  });
});

describe("sceneScale", () => {
  it("no agranda y reduce para caber", () => {
    expect(sceneScale(1200, 820)).toBe(1);
    expect(sceneScale(410, 820)).toBe(0.5);
    expect(sceneScale(0, 820)).toBe(1);
  });
});

describe("etiquetas", () => {
  it("planTag", () => {
    expect(planTag({ status: "running", pauseReason: null })).toEqual({ label: "EJECUTANDO", tone: "run" });
    expect(planTag({ status: "pending", pauseReason: "guard" })).toEqual({ label: "PAUSADO", tone: "wait" });
    expect(planTag({ status: "completed", pauseReason: "quota" }).label).toBe("COMPLETADO");
    expect(planTag({ status: "failed", pauseReason: null }).tone).toBe("err");
  });
  it("queueTag", () => {
    expect(queueTag({ status: "running", adapter: "agy" })).toEqual({ label: "AGY", tone: "run" });
    expect(queueTag({ status: "paused", adapter: "codex" }).label).toBe("GUARDIA");
    expect(queueTag({ status: "pending", adapter: "codex" }).label).toBe("EN COLA");
  });
  it("signLine cuenta planes distintos y pasos", () => {
    expect(signLine([])).toBe("SIN PLANES ACTIVOS");
    expect(signLine([{ planId: "a" }])).toBe("1 PLAN · 1 PASO");
    expect(signLine([{ planId: "a" }, { planId: "b" }, { planId: "a" }])).toBe("2 PLANES · 3 PASOS");
  });
  it("clock HH:MM", () => {
    expect(clock(new Date(2026, 0, 1, 7, 5))).toBe("07:05");
  });
});

describe("appendLog", () => {
  it("el más nuevo va primero", () => {
    expect(appendLog([1, 2], 3)).toEqual([3, 1, 2]);
  });
  it("recorta a los últimos 100", () => {
    expect(LOG_MAX).toBe(100);
    let log: number[] = [];
    for (let i = 0; i < 150; i++) log = appendLog(log, i);
    expect(log).toHaveLength(100);
    expect(log[0]).toBe(149);
    expect(log[99]).toBe(50);
  });
});

describe("viewLocked", () => {
  it("con plática solo bloquea cambiar a la otra vista", () => {
    expect(viewLocked("oficina", "chat", true)).toBe(true);
    expect(viewLocked("chat", "oficina", true)).toBe(true);
    expect(viewLocked("chat", "chat", true)).toBe(false);
    expect(viewLocked("oficina", "chat", false)).toBe(false);
  });
});

describe("talkLabel", () => {
  it("inactivo invita; activo muestra la fase", () => {
    expect(talkLabel("starting", false)).toBe("clic para platicar");
    expect(talkLabel("error", false)).toBe("clic para platicar");
    expect(talkLabel("listening", true)).toBe("ESCUCHANDO");
    expect(talkLabel("transcribing", true)).toBe("TRANSCRIBIENDO");
    expect(talkLabel("thinking", true)).toBe("PENSANDO");
    expect(talkLabel("speaking", true)).toBe("HABLANDO");
  });
});

import { groupByPool, seatLabel } from "../../ui/src/lib/office-view";
describe("groupByPool / seatLabel", () => {
  const a = (id: string, o = {}) => ({ id, label: id, active: false, pool: null as string | null, quotaBlockedUntil: null as string | null, poolShortPct: null as number | null, ...o });
  it("una columna por bolsa; sin pool usa el id; bloqueada si alguna cuenta lo está", () => {
    const now = 1000;
    const pools = groupByPool([
      a("local", { active: true, poolShortPct: 12 }),
      a("agy2", { pool: "p" }), a("agy3", { pool: "p", quotaBlockedUntil: new Date(now + 5000).toISOString(), poolShortPct: 40 }),
      a("agy4", { quotaBlockedUntil: new Date(now - 5000).toISOString() }),
    ], now);
    expect(pools.map((p) => [p.key, p.accounts.length, p.pct, p.blocked])).toEqual([["local", 1, 12, false], ["p", 2, 40, true], ["agy4", 1, null, false]]);
  });
  it("etiqueta de asiento", () => expect(seatLabel("agy3")).toBe("AGY · agy3"));
  it("con rol: ROL · cuenta", () => {
    expect(seatLabel("agy3", "dev")).toBe("DEV · agy3");
    expect(seatLabel("local", null)).toBe("AGY · local");
  });
});

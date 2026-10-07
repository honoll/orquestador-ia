import { describe, it, expect } from "vitest";
import {
  assistantPaths,
  endBody,
  parseAssistantEvent,
  readBargeIn,
  startBody,
  startErrorMessage,
  turnBody,
  turnOutcome,
  writeBargeIn,
} from "../../ui/src/lib/assistant.js";

describe("parseAssistantEvent", () => {
  it("acepta eventos de la sesión", () => {
    expect(parseAssistantEvent({ type: "voice:assistant:delta", sessionId: "s", turnId: "t", delta: "hola" }, "s")).toEqual({
      type: "delta", sessionId: "s", turnId: "t", delta: "hola",
    });
    expect(
      parseAssistantEvent({ type: "voice:assistant:turn-done", sessionId: "s", turnId: "t", speech: "ok", hasAction: true }, "s"),
    ).toEqual({ type: "turn-done", sessionId: "s", turnId: "t", speech: "ok", hasAction: true });
    expect(
      parseAssistantEvent({ type: "voice:assistant:turn-done", sessionId: "s", turnId: "t", speech: "", hasAction: false, error: "boom" }, "s"),
    ).toMatchObject({ error: "boom" });
    expect(parseAssistantEvent({ type: "voice:assistant:announce", sessionId: "s", text: "Listo" }, "s")).toEqual({
      type: "announce", sessionId: "s", text: "Listo",
    });
    expect(parseAssistantEvent({ type: "voice:assistant:ended", sessionId: "s", reason: "user", notePath: "a/b.md" }, "s")).toEqual({
      type: "ended", sessionId: "s", reason: "user", notePath: "a/b.md",
    });
    expect(parseAssistantEvent({ type: "voice:assistant:ended", sessionId: "s", reason: "idle", notePath: null }, "s")).toMatchObject({
      notePath: null,
    });
  });
  it("descarta otras sesiones, otros tipos y basura", () => {
    expect(parseAssistantEvent({ type: "voice:assistant:delta", sessionId: "x", turnId: "t", delta: "a" }, "s")).toBeNull();
    expect(parseAssistantEvent({ type: "run:status", sessionId: "s" }, "s")).toBeNull();
    expect(parseAssistantEvent({ type: "voice:assistant:delta", sessionId: "s", delta: "a" }, "s")).toBeNull();
    expect(parseAssistantEvent({ type: "voice:assistant:announce", sessionId: "s", text: "  " }, "s")).toBeNull();
    expect(parseAssistantEvent({ type: "voice:assistant:otro", sessionId: "s" }, "s")).toBeNull();
    expect(parseAssistantEvent(null, "s")).toBeNull();
    expect(parseAssistantEvent("x", "s")).toBeNull();
  });
});

describe("cuerpos y rutas", () => {
  it("startBody", () => {
    expect(JSON.parse(startBody("p1"))).toEqual({ projectId: "p1" });
    expect(JSON.parse(startBody(null))).toEqual({});
  });
  it("turnBody recorta", () => {
    expect(JSON.parse(turnBody("  hola  "))).toEqual({ text: "hola" });
  });
  it("endBody es JSON válido", () => {
    expect(JSON.parse(endBody())).toEqual({});
  });
  it("rutas escapan el id", () => {
    expect(assistantPaths.turn("a/b")).toBe("/api/voice/assistant/a%2Fb/turn");
    expect(assistantPaths.end("abc")).toBe("/api/voice/assistant/abc/end");
  });
});

describe("turnOutcome", () => {
  it("202 con turnId", () => {
    expect(turnOutcome(202, { turnId: "t" })).toEqual({ kind: "accepted", turnId: "t" });
  });
  it("200 discarded", () => {
    expect(turnOutcome(200, { discarded: true })).toEqual({ kind: "discarded" });
  });
  it("errores", () => {
    expect(turnOutcome(409, { error: "Ocupado" })).toEqual({ kind: "error", message: "Ocupado" });
    expect(turnOutcome(404, null)).toEqual({ kind: "error", message: "HTTP 404" });
    expect(turnOutcome(202, {})).toEqual({ kind: "error", message: "HTTP 202" });
  });
});

describe("startErrorMessage", () => {
  it("409 usa el mensaje del servidor", () => {
    expect(startErrorMessage(409, "Ya hay una sesión")).toBe("Ya hay una sesión");
    expect(startErrorMessage(409)).toMatch(/en curso/);
    expect(startErrorMessage(500, "x")).toBe("No se pudo iniciar la plática: x");
  });
});

describe("interruptor de barge-in", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it("por defecto apagado y guarda", () => {
    const s = mem();
    expect(readBargeIn(s)).toBe(false);
    writeBargeIn(s, true);
    expect(readBargeIn(s)).toBe(true);
    writeBargeIn(s, false);
    expect(readBargeIn(s)).toBe(false);
  });
  it("tolera almacenamiento que lanza o ausente", () => {
    const bad = {
      getItem: () => { throw new Error("x"); },
      setItem: () => { throw new Error("x"); },
    };
    expect(readBargeIn(bad)).toBe(false);
    expect(() => writeBargeIn(bad, true)).not.toThrow();
    expect(readBargeIn(null)).toBe(false);
  });
});

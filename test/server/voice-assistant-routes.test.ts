import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  class AssistantError extends Error {
    constructor(message: string, readonly status: 404 | 409) { super(message); }
  }
  return {
    AssistantError,
    start: vi.fn(),
    turn: vi.fn(),
    end: vi.fn(),
    active: vi.fn(),
  };
});
vi.mock("../../src/voice/assistant/session.js", () => ({
  AssistantError: h.AssistantError,
  startAssistant: h.start,
  assistantTurn: h.turn,
  endAssistant: h.end,
  activeAssistant: h.active,
  shutdownAssistant: vi.fn(),
}));

const { default: route } = await import("../../src/server/routes/voice-assistant.js");

const post = (p: string, body?: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
  route.request(p, { method: "POST", body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body), headers });

beforeEach(() => { h.start.mockReset(); h.turn.mockReset(); h.end.mockReset(); h.active.mockReset(); });

describe("POST /start", () => {
  it("200 con sessionId y conversationId; projectId opcional", async () => {
    h.start.mockResolvedValue({ sessionId: "s1", conversationId: "c1" });
    const r = await post("/start", { projectId: "p1" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ sessionId: "s1", conversationId: "c1" });
    expect(h.start).toHaveBeenCalledWith({ projectId: "p1" });
    await post("/start", {});
    expect(h.start).toHaveBeenLastCalledWith({ projectId: null });
    await post("/start", { projectId: null });
    expect(h.start).toHaveBeenLastCalledWith({ projectId: null });
  });
  it("409 sin cuenta agy activa", async () => {
    h.start.mockRejectedValue(new h.AssistantError("No hay cuenta", 409));
    const r = await post("/start", {});
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "No hay cuenta" });
  });
  it("400 si projectId no es string/null; 415 sin JSON; 413 enorme", async () => {
    expect((await post("/start", { projectId: 5 })).status).toBe(400);
    expect((await post("/start", "no json")).status).toBe(400);
    expect((await post("/start", "{}", { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post("/start", { projectId: "x".repeat(20000) })).status).toBe(413);
  });
});

describe("POST /:id/turn", () => {
  it("202 con turnId y texto recortado", async () => {
    h.turn.mockResolvedValue({ turnId: "t1" });
    const r = await post("/s1/turn", { text: "  hola, ¿cómo vas?  " });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ turnId: "t1" });
    expect(h.turn).toHaveBeenCalledWith("s1", "hola, ¿cómo vas?");
  });
  it("alucinación de Whisper: 200 discarded sin llamar a la sesión", async () => {
    const r = await post("/s1/turn", { text: "Gracias por ver el video" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ discarded: true });
    expect(h.turn).not.toHaveBeenCalled();
  });
  it("propaga 404 y 409 de la sesión", async () => {
    h.turn.mockResolvedValueOnce({ error: "Sesión no encontrada", status: 404 });
    const a = await post("/s1/turn", { text: "hola" });
    expect(a.status).toBe(404);
    expect(await a.json()).toEqual({ error: "Sesión no encontrada" });
    h.turn.mockResolvedValueOnce({ error: "Ya hay un turno en curso", status: 409 });
    expect((await post("/s1/turn", { text: "hola" })).status).toBe(409);
  });
  it.each([[{}], [{ text: 5 }], [{ text: "   " }], [{ text: "x".repeat(2001) }]])("400 con %j", async (b) => {
    expect((await post("/s1/turn", b)).status).toBe(400);
  });
  it("415 y 413", async () => {
    expect((await post("/s1/turn", "{}", { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post("/s1/turn", { text: "x".repeat(20000) })).status).toBe(413);
  });
});

describe("POST /:id/end", () => {
  it("200 con notePath", async () => {
    h.active.mockReturnValue({ sessionId: "s1", conversationId: "c1" });
    h.end.mockResolvedValue({ notePath: "Asistente/n.md" });
    const r = await post("/s1/end", undefined, {});
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ notePath: "Asistente/n.md" });
    expect(h.end).toHaveBeenCalledWith("s1", "user");
  });
  it("404 si no es la sesión activa", async () => {
    h.active.mockReturnValue({ sessionId: "otra", conversationId: "c" });
    const r = await post("/s1/end");
    expect(r.status).toBe(404);
    expect(h.end).not.toHaveBeenCalled();
  });
});

describe("GET /active", () => {
  it("devuelve la sesión o null", async () => {
    h.active.mockReturnValue({ sessionId: "s1", conversationId: "c1" });
    expect(await (await route.request("/active")).json()).toEqual({ sessionId: "s1", conversationId: "c1" });
    h.active.mockReturnValue(null);
    expect(await (await route.request("/active")).json()).toBeNull();
  });
});

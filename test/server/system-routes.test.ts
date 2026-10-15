import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock("../../src/server/ws.js", () => ({ broadcast: h.broadcast }));

const { createSystemRoute } = await import("../../src/server/routes/system.js");

const shutdown = vi.fn();
const route = createSystemRoute({ shutdown });
const post = (p: string, body?: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
  route.request(p, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body ?? {}), headers });

beforeEach(() => { shutdown.mockReset(); h.broadcast.mockReset(); vi.useRealTimers(); });

describe("POST /shutdown", () => {
  it("202 y apaga una sola vez, después de responder", async () => {
    vi.useFakeTimers();
    const r = await post("/shutdown", {});
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ ok: true });
    expect(shutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith(0);
  });
  it("415 sin JSON; 413 enorme", async () => {
    expect((await post("/shutdown", "{}", { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post("/shutdown", { x: "x".repeat(5000) })).status).toBe(413);
    expect(shutdown).not.toHaveBeenCalled();
  });
});

describe("POST /ui-intent", () => {
  it("platicar: 202 y broadcast", async () => {
    const r = await post("/ui-intent", { open: "platicar" });
    expect(r.status).toBe(202);
    expect(h.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "ui:intent", open: "platicar" }));
  });
  it("plan: 202 y broadcast con planId", async () => {
    const r = await post("/ui-intent", { open: "plan", planId: "abc-123" });
    expect(r.status).toBe(202);
    expect(h.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "ui:intent", open: "plan", planId: "abc-123" }));
  });
  it("400 en cualquier otro body", async () => {
    for (const b of [{}, { open: "x" }, { open: "plan" }, { open: "plan", planId: 5 }, { open: "plan", planId: "a b" }, "no json"]) {
      expect((await post("/ui-intent", b)).status).toBe(400);
    }
    expect(h.broadcast).not.toHaveBeenCalled();
  });
  it("415 sin JSON; 413 enorme", async () => {
    expect((await post("/ui-intent", "{}", { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post("/ui-intent", { open: "plan", planId: "x".repeat(5000) })).status).toBe(413);
  });
});

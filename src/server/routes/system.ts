import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { originGuard } from "../origin-guard.js";
import { broadcast } from "../ws.js";
import type { WsEvent } from "../../lib/types.js";

const limitBody = bodyLimit({
  maxSize: 1024,
  onError: (c) => c.json({ error: "Cuerpo demasiado grande" }, 413),
});
const isJson = (c: Context) => (c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json");
const NOT_JSON = { error: "El cuerpo debe ser JSON (Content-Type application/json)" };
const PLAN_ID = /^[A-Za-z0-9-]{1,64}$/;

export function createSystemRoute(deps: { shutdown: (code: number) => void }) {
  const app = new Hono();
  app.use("*", originGuard());

  app.post("/shutdown", limitBody, (c) => {
    if (!isJson(c)) return c.json(NOT_JSON, 415);
    // Responde primero; el apagado mata el proceso.
    setTimeout(() => deps.shutdown(0), 50);
    return c.json({ ok: true }, 202);
  });

  app.post("/ui-intent", limitBody, async (c) => {
    if (!isJson(c)) return c.json(NOT_JSON, 415);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "JSON inválido" }, 400);
    }
    const b = (body && typeof body === "object" ? body : {}) as { open?: unknown; planId?: unknown };
    const ts = new Date().toISOString();
    if (b.open === "platicar") {
      broadcast({ type: "ui:intent", open: "platicar", timestamp: ts } as unknown as WsEvent);
    } else if (b.open === "plan" && typeof b.planId === "string" && PLAN_ID.test(b.planId)) {
      broadcast({ type: "ui:intent", open: "plan", planId: b.planId, timestamp: ts } as unknown as WsEvent);
    } else {
      return c.json({ error: "open debe ser \"platicar\" o \"plan\" con planId válido" }, 400);
    }
    return c.json({ ok: true }, 202);
  });

  return app;
}

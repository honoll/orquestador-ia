import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { originGuard } from "../origin-guard.js";
import { activeAssistant, assistantTurn, AssistantError, endAssistant, startAssistant } from "../../voice/assistant/session.js";
import { isWhisperHallucination } from "../../voice/assistant/text.js";

export const MAX_ASSISTANT_BODY_BYTES = 16 * 1024;
export const MAX_UTTERANCE_CHARS = 2000;

const limitBody = bodyLimit({
  maxSize: MAX_ASSISTANT_BODY_BYTES,
  onError: (c) => c.json({ error: "Cuerpo demasiado grande" }, 413),
});
const isJson = (c: Context) => (c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json");
const NOT_JSON = { error: "El cuerpo debe ser JSON (Content-Type application/json)" };

const app = new Hono();
app.use("*", originGuard());

app.post("/start", limitBody, async (c) => {
  if (!isJson(c)) return c.json(NOT_JSON, 415);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSON inválido" }, 400);
  }
  const b = (body && typeof body === "object" ? body : {}) as { projectId?: unknown };
  if (b.projectId !== undefined && b.projectId !== null && typeof b.projectId !== "string") {
    return c.json({ error: "projectId debe ser texto o null" }, 400);
  }
  try {
    const r = await startAssistant({ projectId: b.projectId ?? null });
    return c.json({ sessionId: r.sessionId, conversationId: r.conversationId });
  } catch (err) {
    if (err instanceof AssistantError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

app.post("/:id/turn", limitBody, async (c) => {
  if (!isJson(c)) return c.json(NOT_JSON, 415);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSON inválido" }, 400);
  }
  const raw = (body && typeof body === "object" ? (body as { text?: unknown }).text : undefined);
  if (typeof raw !== "string") return c.json({ error: "text debe ser texto" }, 400);
  const text = raw.trim();
  if (text.length < 1 || text.length > MAX_UTTERANCE_CHARS) {
    return c.json({ error: `text debe tener entre 1 y ${MAX_UTTERANCE_CHARS} caracteres` }, 400);
  }
  if (isWhisperHallucination(text)) return c.json({ discarded: true }, 200);
  const r = await assistantTurn(c.req.param("id"), text);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  return c.json({ turnId: r.turnId }, 202);
});

app.post("/:id/end", async (c) => {
  const id = c.req.param("id");
  if (activeAssistant()?.sessionId !== id) return c.json({ error: "Sesión no encontrada" }, 404);
  const r = await endAssistant(id, "user");
  return c.json({ notePath: r.notePath });
});

app.get("/active", (c) => c.json(activeAssistant()));

export default app;

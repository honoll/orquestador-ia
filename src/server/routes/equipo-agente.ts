import { Hono, type Context } from "hono";
import { verifyRunToken, type TokenScope } from "../equipo/tokens.js";
import { addComment, createChildTask, inSubtree, taskContext, TeamError } from "../equipo/tasks.js";
import { CUERPO_MAX } from "../equipo/constants.js";

/** API que los agentes llaman con su token de turno (ORQ_TOKEN): solo su tarea y sus descendientes. */
export function createEquipoAgenteRoute(kick: (planId: string) => void = () => {}) {
  const app = new Hono();

  // Hono manda application/json sin charset y Invoke-RestMethod de PowerShell 5.1 lo lee como ISO-8859-1 (acentos rotos).
  app.use("*", async (c, next) => {
    await next();
    if (c.res.headers.get("content-type")?.startsWith("application/json") && !c.res.headers.get("content-type")?.includes("charset")) {
      c.res.headers.set("content-type", "application/json; charset=utf-8");
    }
  });

  const scopeOf = async (c: Context): Promise<TokenScope | null> => {
    const h = c.req.header("authorization") ?? "";
    return verifyRunToken(h.startsWith("Bearer ") ? h.slice(7).trim() : undefined);
  };
  const body = async (c: Context): Promise<Record<string, unknown>> => {
    const raw = await c.req.text();
    if (raw.length > CUERPO_MAX) throw new TeamError(400, "__413__");
    try {
      const v = JSON.parse(raw);
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
      return v as Record<string, unknown>;
    } catch { throw new TeamError(400, "El cuerpo debe ser un objeto JSON"); }
  };
  const fail = (c: Context, err: unknown) => {
    if (err instanceof TeamError) {
      if (err.message === "__413__") return c.json({ error: `Cuerpo mayor a ${CUERPO_MAX / 1024} KB` }, 413);
      return c.json({ error: err.message }, err.status);
    }
    throw err;
  };

  app.get("/tarea", async (c) => {
    const scope = await scopeOf(c);
    if (!scope) return c.json({ error: "Token inválido o vencido" }, 401);
    try { return c.json(await taskContext(scope.stepId)); } catch (err) { return fail(c, err); }
  });

  app.post("/tareas", async (c) => {
    const scope = await scopeOf(c);
    if (!scope) return c.json({ error: "Token inválido o vencido" }, 401);
    try {
      const { id } = await createChildTask(scope.planId, scope.stepId, await body(c));
      kick(scope.planId);
      return c.json({ id }, 201);
    } catch (err) { return fail(c, err); }
  });

  app.post("/comentarios", async (c) => {
    const scope = await scopeOf(c);
    if (!scope) return c.json({ error: "Token inválido o vencido" }, 401);
    try {
      const b = await body(c);
      const target = typeof b.tareaId === "string" && b.tareaId ? b.tareaId : scope.stepId;
      if (target !== scope.stepId && !(await inSubtree(scope.stepId, target))) {
        return c.json({ error: "Solo puedes comentar en tu tarea o en sus hijas" }, 403);
      }
      const { id } = await addComment(scope.planId, target, scope.stepId, b.texto);
      kick(scope.planId);
      return c.json({ id }, 201);
    } catch (err) { return fail(c, err); }
  });

  return app;
}

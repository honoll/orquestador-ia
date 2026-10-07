import type { MiddlewareHandler } from "hono";

/**
 * Defensa contra páginas web ajenas que le hablan al servidor local (CORS es "*"): las peticiones que cambian
 * estado solo se aceptan sin cabecera Origin (curl, scripts, el propio servidor) o desde la UI propia.
 * Los orígenes derivan del puerto configurado (ORQUESTADOR_PORT) y del del dev server de Vite (5173).
 */
export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const port = parseInt(env.ORQUESTADOR_PORT || "3100", 10) || 3100;
  const uiPort = parseInt(env.ORQUESTADOR_UI_PORT || "5173", 10) || 5173;
  const ports = [...new Set([port, uiPort])];
  return ports.flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function originGuard(env: NodeJS.ProcessEnv = process.env): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const origin = c.req.header("origin");
    if (origin !== undefined && !allowedOrigins(env).includes(origin)) {
      return c.json({ error: "Origen no permitido" }, 403);
    }
    if (c.req.header("sec-fetch-site") === "cross-site") {
      return c.json({ error: "Origen no permitido" }, 403);
    }
    return next();
  };
}

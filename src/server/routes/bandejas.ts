import { Hono } from "hono";
import { buildBandejas } from "../equipo/bandejas.js";

/** GET /api/equipo/bandejas: trabajo activo por rol para la barra lateral (lectura para la UI, sin token). */
export function createBandejasRoute() {
  const app = new Hono();
  app.get("/", async (c) => c.json(await buildBandejas()));
  return app;
}

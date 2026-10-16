import fs from "node:fs";
import { Hono } from "hono";
import { ESCENARIO_PNG, escenarioDir, readEscenario } from "../escenario.js";
import { resolveSpriteFile } from "../sprites.js";

export function createOfficeEscenarioRoute(dir?: string) {
  const app = new Hono();
  app.get("/", (c) => c.json(readEscenario(dir)));
  return app;
}

/** Atlas PNG del escenario (fuera del repo); los JSON nunca se sirven. */
export function createEscenarioFilesRoute(dir?: string) {
  const app = new Hono();
  app.get("/:file", (c) => {
    const real = resolveSpriteFile(c.req.param("file"), dir ?? escenarioDir(), ESCENARIO_PNG);
    if (!real) return c.json({ error: "Archivo no encontrado" }, 404);
    return c.body(fs.readFileSync(real), 200, {
      "Content-Type": "image/png", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox", "Cache-Control": "no-cache",
    });
  });
  return app;
}

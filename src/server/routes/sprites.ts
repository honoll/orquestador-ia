import fs from "node:fs";
import { Hono } from "hono";
import { readSpritesConfig, resolveSpriteFile, SPRITE_MIME } from "../sprites.js";

export function createSpritesRoute(dir?: string) {
  const app = new Hono();
  app.get("/:file", (c) => {
    const real = resolveSpriteFile(c.req.param("file"), dir);
    if (!real) return c.json({ error: "Sprite no encontrado" }, 404);
    const ext = real.slice(real.lastIndexOf(".") + 1).toLowerCase();
    return c.body(fs.readFileSync(real), 200, {
      "Content-Type": SPRITE_MIME[ext], "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox", "Cache-Control": "no-cache",
    });
  });
  return app;
}

export function createOfficeSpritesRoute(dir?: string) {
  const app = new Hono();
  app.get("/", (c) => c.json(readSpritesConfig(dir)));
  return app;
}

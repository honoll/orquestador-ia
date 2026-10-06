import { Hono } from "hono";
import { adapters } from "../../adapters/registry.js";

const app = new Hono();

app.get("/", async (c) => {
  const results: Record<string, any> = {};

  await Promise.all(
    Object.entries(adapters).map(async ([type, adapter]) => {
      const detection = await adapter.detect();
      results[type] = {
        ...adapter.meta,
        available: detection.available,
        resolvedPath: detection.resolvedPath,
      };
    }),
  );

  return c.json(results);
});

export default app;

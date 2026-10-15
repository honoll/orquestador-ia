import { Hono } from "hono";
import { buildOfficeState, collectOfficeInput } from "../office-state.js";

const app = new Hono();

app.get("/state", async (c) => {
  try {
    return c.json(buildOfficeState(await collectOfficeInput()));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default app;

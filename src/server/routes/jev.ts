import { Hono } from "hono";
import { jev } from "../../lib/jev.js";

const app = new Hono();
app.get("/status", (c) => c.json({ configured: jev.configured() }));
export default app;

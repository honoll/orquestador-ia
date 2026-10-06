import { Hono } from "hono";
import fs from "node:fs";
import nodePath from "node:path";

const CAVEMAN_FLAG_FILE = nodePath.join(process.env.HOME || process.env.USERPROFILE || "", ".claude", ".caveman-active");

const app = new Hono();

app.get("/status", async (c) => {
  try {
    if (!fs.existsSync(CAVEMAN_FLAG_FILE)) {
      return c.json({ active: false, mode: "" });
    }

    const mode = fs.readFileSync(CAVEMAN_FLAG_FILE, "utf-8").trim();

    return c.json({ active: true, mode });
  } catch {
    return c.json({ active: false, mode: "" });
  }
});

export default app;

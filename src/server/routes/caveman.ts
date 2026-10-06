import { Hono } from "hono";
import fs from "node:fs";

import { cavemanFlagFile } from "../../lib/caveman.js";
const HOME = process.env.HOME || process.env.USERPROFILE || "";
const CAVEMAN_FLAG_FILE = cavemanFlagFile(HOME);

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

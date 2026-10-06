import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { cancelRun } from "../runner.js";

const app = new Hono();

app.get("/", async (c) => {
  const rows = await db.select().from(schema.runs).orderBy(desc(schema.runs.startedAt));
  return c.json(rows);
});

app.get("/:id", async (c) => {
  const rows = await db.select().from(schema.runs).where(eq(schema.runs.id, c.req.param("id")));
  if (rows.length === 0) return c.json({ error: "Not found" }, 404);
  return c.json(rows[0]);
});

app.get("/task/:taskId", async (c) => {
  const rows = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.taskId, c.req.param("taskId")))
    .orderBy(desc(schema.runs.startedAt));
  return c.json(rows);
});

app.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const rows = await db.select().from(schema.runs).where(eq(schema.runs.id, id));
  if (rows.length === 0) return c.json({ error: "Not found" }, 404);

  const killed = cancelRun(id);

  if (killed || rows[0].status === "running") {
    await db.update(schema.runs)
      .set({ status: "cancelled", finishedAt: new Date().toISOString() })
      .where(eq(schema.runs.id, id));

    await db.update(schema.tasks)
      .set({ status: "cancelled", updatedAt: new Date().toISOString() })
      .where(eq(schema.tasks.id, rows[0].taskId));
  }

  return c.json({ ok: true, killed });
});

export default app;

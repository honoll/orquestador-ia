import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import fs from "node:fs";
import path from "node:path";

const app = new Hono();

app.get("/", async (c) => {
  const rows = await db.select().from(schema.projects).all();
  return c.json(rows);
});

app.get("/:id", async (c) => {
  const rows = await db.select().from(schema.projects).where(eq(schema.projects.id, c.req.param("id")));
  if (rows.length === 0) return c.json({ error: "Not found" }, 404);
  return c.json(rows[0]);
});

app.post("/", async (c) => {
  const body = await c.req.json<{ name: string; path: string; description?: string }>();
  const id = randomUUID();
  await db.insert(schema.projects).values({
    id,
    name: body.name,
    path: body.path,
    description: body.description ?? null,
  });
  const rows = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
  return c.json(rows[0], 201);
});

app.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ name?: string; path?: string; description?: string }>();
  const existing = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
  if (existing.length === 0) return c.json({ error: "Not found" }, 404);

  await db.update(schema.projects)
    .set({ ...body, updatedAt: new Date().toISOString() })
    .where(eq(schema.projects.id, id));

  const updated = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
  return c.json(updated[0]);
});

app.delete("/:id", async (c) => {
  const id = c.req.param("id");

  // Delete plan children first
  const projectPlans = await db.select({ id: schema.plans.id })
    .from(schema.plans)
    .where(eq(schema.plans.projectId, id));
  if (projectPlans.length > 0) {
    const planIds = projectPlans.map((p) => p.id);
    await db.delete(schema.planFileChanges).where(inArray(schema.planFileChanges.planId, planIds));
    await db.delete(schema.planSteps).where(inArray(schema.planSteps.planId, planIds));
    await db.delete(schema.plans).where(inArray(schema.plans.id, planIds));
  }

  // Delete task children first
  const projectTasks = await db.select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.projectId, id));
  if (projectTasks.length > 0) {
    const taskIds = projectTasks.map((t) => t.id);
    await db.delete(schema.runs).where(inArray(schema.runs.taskId, taskIds));
    await db.delete(schema.tasks).where(inArray(schema.tasks.id, taskIds));
  }

  await db.delete(schema.projects).where(eq(schema.projects.id, id));
  return c.json({ ok: true });
});

// List files in a project directory (for context picker)
app.get("/:id/files", async (c) => {
  const project = await db.select().from(schema.projects).where(eq(schema.projects.id, c.req.param("id"))).then(r => r[0]);
  if (!project) return c.json({ error: "Not found" }, 404);

  const subdir = c.req.query("dir") || "";
  const targetDir = subdir ? path.join(project.path, subdir) : project.path;

  try {
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".dart_tool", ".flutter-plugins"]);
    const files = entries
      .filter(e => !IGNORE.has(e.name) && !e.name.startsWith("."))
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : "file",
        relativePath: subdir ? path.join(subdir, e.name).replace(/\\/g, "/") : e.name,
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return c.json({ path: targetDir, files });
  } catch {
    return c.json({ error: "Cannot read directory" }, 400);
  }
});

// Read a specific file for context injection
app.get("/:id/file", async (c) => {
  const project = await db.select().from(schema.projects).where(eq(schema.projects.id, c.req.param("id"))).then(r => r[0]);
  if (!project) return c.json({ error: "Not found" }, 404);

  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path required" }, 400);

  const fullPath = path.join(project.path, filePath);
  // Security: ensure it's inside the project
  if (!fullPath.startsWith(project.path)) return c.json({ error: "Access denied" }, 403);

  try {
    const content = fs.readFileSync(fullPath, "utf8");
    const MAX = 50_000;
    return c.json({ path: filePath, content: content.slice(0, MAX), truncated: content.length > MAX });
  } catch {
    return c.json({ error: "Cannot read file" }, 400);
  }
});

export default app;

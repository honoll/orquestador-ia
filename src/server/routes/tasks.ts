import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { eq, desc, and, or, isNull } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { runTask } from "../runner.js";

const app = new Hono();

app.get("/", async (c) => {
  const projectId = c.req.query("projectId");
  const conversationId = c.req.query("conversationId");
  let rows;
  if (conversationId) {
    // Also match tasks where id = conversationId (pre-migration tasks with NULL conversation_id)
    rows = await db.select().from(schema.tasks)
      .where(or(
        eq(schema.tasks.conversationId, conversationId),
        eq(schema.tasks.id, conversationId),
      ))
      .orderBy(schema.tasks.createdAt);
  } else if (projectId) {
    rows = await db.select().from(schema.tasks)
      .where(eq(schema.tasks.projectId, projectId))
      .orderBy(desc(schema.tasks.createdAt));
  } else {
    rows = await db.select().from(schema.tasks).orderBy(desc(schema.tasks.createdAt));
  }
  return c.json(rows);
});

// Get distinct conversations for a project
app.get("/conversations", async (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) return c.json([]);

  // "none" = pláticas sin proyecto (p. ej. las del asistente de voz)
  const allTasks = await db.select().from(schema.tasks)
    .where(projectId === "none" ? isNull(schema.tasks.projectId) : eq(schema.tasks.projectId, projectId))
    .orderBy(schema.tasks.createdAt);

  // Group by conversation_id: title from first message, status/updatedAt from latest
  const convMap = new Map<string, {
    conversationId: string;
    title: string;
    adapter: string;
    model: string | null;
    status: string;
    messageCount: number;
    createdAt: string;
    updatedAt: string;
  }>();

  for (const task of allTasks) {
    const cid = task.conversationId || task.id;
    const existing = convMap.get(cid);
    if (!existing) {
      // First task in conversation (oldest) — use its title
      convMap.set(cid, {
        conversationId: cid,
        title: task.title,
        adapter: task.adapter,
        model: task.model,
        status: task.status,
        messageCount: 1,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      });
    } else {
      existing.messageCount++;
      // Keep latest status and updatedAt
      existing.status = task.status;
      existing.updatedAt = task.updatedAt;
    }
  }

  // Sort by most recently updated first
  const conversations = Array.from(convMap.values())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return c.json(conversations);
});

app.get("/:id", async (c) => {
  const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, c.req.param("id")));
  if (rows.length === 0) return c.json({ error: "Not found" }, 404);
  return c.json(rows[0]);
});

app.post("/", async (c) => {
  const body = await c.req.json<{
    projectId?: string;
    conversationId?: string;
    title: string;
    prompt: string;
    adapter: string;
    model?: string;
  }>();
  const id = randomUUID();
  // If no conversationId provided, this task starts a new conversation (self-referencing)
  const conversationId = body.conversationId || id;

  await db.insert(schema.tasks).values({
    id,
    projectId: body.projectId ?? null,
    conversationId,
    title: body.title,
    prompt: body.prompt,
    adapter: body.adapter,
    model: body.model ?? null,
  });
  const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return c.json(rows[0], 201);
});

app.post("/:id/run", async (c) => {
  const id = c.req.param("id");
  const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  if (rows.length === 0) return c.json({ error: "Not found" }, 404);
  const task = rows[0];

  const body = await c.req.json<{ cwd?: string; sessionId?: string; timeoutSec?: number }>().catch(() => ({}));

  let cwd = (body as any).cwd || process.cwd();
  if (task.projectId) {
    const projects = await db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId));
    if (projects.length > 0) cwd = projects[0].path;
  }

  // Auto-resolve sessionId from previous runs in the same conversation
  // IMPORTANT: only resume with sessions from the SAME adapter (e.g. don't use a Codex thread_id for agy)
  let sessionId = (body as any).sessionId;
  if (!sessionId && task.conversationId) {
    // Find previous tasks in this conversation that used the same adapter
    const prevTasks = await db.select().from(schema.tasks)
      .where(and(
        eq(schema.tasks.conversationId, task.conversationId),
        eq(schema.tasks.adapter, task.adapter),
      ))
      .orderBy(desc(schema.tasks.createdAt));

    // Look for the most recent run with a sessionId from the same adapter
    for (const pt of prevTasks) {
      if (pt.id === task.id) continue; // skip current task
      const prevRuns = await db.select().from(schema.runs)
        .where(eq(schema.runs.taskId, pt.id))
        .orderBy(desc(schema.runs.startedAt));
      const lastRun = prevRuns[0];
      if (lastRun?.sessionId) {
        sessionId = lastRun.sessionId;
        break;
      }
    }
  }

  const runId = await runTask({
    taskId: id,
    adapter: task.adapter,
    prompt: task.prompt,
    model: task.model ?? undefined,
    cwd,
    sessionId,
    timeoutSec: (body as any).timeoutSec,
  });

  return c.json({ runId }, 202);
});

app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await db.delete(schema.tasks).where(eq(schema.tasks.id, id));
  return c.json({ ok: true });
});

// Delete entire conversation
app.delete("/conversation/:conversationId", async (c) => {
  const conversationId = c.req.param("conversationId");

  // Find all tasks in this conversation
  const tasks = await db.select().from(schema.tasks)
    .where(eq(schema.tasks.conversationId, conversationId));

  // Delete runs for each task, then the tasks
  for (const task of tasks) {
    await db.delete(schema.runs).where(eq(schema.runs.taskId, task.id));
  }
  await db.delete(schema.tasks).where(eq(schema.tasks.conversationId, conversationId));

  return c.json({ ok: true });
});

export default app;

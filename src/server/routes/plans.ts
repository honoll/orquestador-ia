import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { eq, desc, asc, and } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { generatePlan, type GeneratedPlan } from "../planner.js";
import { defaultBudget } from "../plan-dag.js";
import { runPlanAll, runPlanStep } from "../plan-runner.js";
import { broadcast } from "../ws.js";
import { startWatch, stopWatch } from "../file-watcher.js";

const app = new Hono();

// Active plan-generation kill functions
const generatingKills = new Map<string, () => void>();

// List plans (optionally filtered by projectId)
app.get("/", async (c) => {
  const projectId = c.req.query("projectId");
  let rows;
  if (projectId) {
    rows = await db.select().from(schema.plans)
      .where(eq(schema.plans.projectId, projectId))
      .orderBy(desc(schema.plans.createdAt));
  } else {
    rows = await db.select().from(schema.plans).orderBy(desc(schema.plans.createdAt));
  }
  return c.json(rows);
});

// Get plan with steps
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((r) => r[0]);
  if (!plan) return c.json({ error: "Not found" }, 404);
  const steps = await db.select().from(schema.planSteps)
    .where(eq(schema.planSteps.planId, id))
    .orderBy(asc(schema.planSteps.stepIndex));
  return c.json({ ...plan, steps });
});

// Create plan — immediately returns plan ID, generates steps in background with streaming
app.post("/", async (c) => {
  const body = await c.req.json<{ description: string; projectId?: string; cwd?: string }>();
  if (!body.description?.trim()) return c.json({ error: "description required" }, 400);

  const project = body.projectId
    ? await db.select().from(schema.projects).where(eq(schema.projects.id, body.projectId)).then((r) => r[0])
    : null;

  const cwd = body.cwd || project?.path || process.cwd();

  const planId = randomUUID();
  await db.insert(schema.plans).values({
    id: planId,
    projectId: body.projectId ?? null,
    description: body.description,
    status: "generating",
  });

  // Generate in background, streaming progress via WS
  (async () => {
    const MAX_PLAN_GEN_RETRIES = 2;
    const RATE_LIMIT_WAIT_MS = 60_000;
    let generated: GeneratedPlan | null = null;
    let lastErr: any = null;

    for (let attempt = 0; attempt <= MAX_PLAN_GEN_RETRIES; attempt++) {
      try {
        generated = await generatePlan(
          body.description,
          cwd,
          project ? { name: project.name, path: project.path, projectDescription: project.description } : undefined,
          {
            onStream: (text) => {
              broadcast({
                type: "plan:generating",
                planId,
                data: text,
                timestamp: new Date().toISOString(),
              } as any);
            },
            onKillRegistered: (kill) => {
              generatingKills.set(planId, kill);
            },
          },
        );
        lastErr = null;
        break;
      } catch (err: any) {
        lastErr = err;
        const isRateLimit = typeof err.message === "string" && err.message.includes("Rate limit de Claude");
        if (isRateLimit && attempt < MAX_PLAN_GEN_RETRIES) {
          const waitMsg = `\n[esperando rate limit, reintentando en 60s... (intento ${attempt + 1}/${MAX_PLAN_GEN_RETRIES})]\n`;
          broadcast({ type: "plan:generating", planId, data: waitMsg, timestamp: new Date().toISOString() } as any);
          await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_MS));
          continue;
        }
        break;
      }
    }

    generatingKills.delete(planId);

    if (lastErr) {
      const isCancelled = lastErr.message === "cancelled";
      console.error("[plan generation error]", lastErr.message, lastErr.stack?.split("\n").slice(0,5).join(" | "));
      await db.update(schema.plans)
        .set({
          status: isCancelled ? "cancelled" : "failed",
          errorMessage: isCancelled ? null : String(lastErr.message ?? lastErr).slice(0, 2000),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.plans.id, planId));

      broadcast({
        type: "plan:error",
        planId,
        error: isCancelled ? "Generaci\u00f3n cancelada" : lastErr.message,
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    for (const step of generated!.steps) {
      await db.insert(schema.planSteps).values({
        id: randomUUID(),
        planId,
        stepIndex: step.stepIndex,
        stepKey: step.key,
        dependsOn: JSON.stringify(step.dependsOn),
        writes: step.writes ? 1 : 0,
        estimatedTokens: step.estimatedTokens,
        description: step.description,
        adapter: step.adapter,
        model: step.model || null,
        reason: step.reason,
        prompt: step.prompt,
        status: "pending",
      });
    }

    await db.update(schema.plans)
      .set({
        status: "pending",
        estimatedTokens: generated!.estimatedTokens,
        budgetTokens: defaultBudget(generated!.estimatedTokens),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.plans.id, planId));

    const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, planId)).then((r) => r[0]);
    const planSteps = await db.select().from(schema.planSteps)
      .where(eq(schema.planSteps.planId, planId))
      .orderBy(asc(schema.planSteps.stepIndex));

    broadcast({
      type: "plan:ready",
      planId,
      plan: { ...plan, steps: planSteps },
      timestamp: new Date().toISOString(),
    } as any);
  })();

  return c.json({ id: planId, status: "generating", description: body.description, steps: [] }, 202);
});

// Update plan metadata (e.g. assign to project)
app.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ projectId?: string | null }>();
  await db.update(schema.plans)
    .set({ ...body, updatedAt: new Date().toISOString() })
    .where(eq(schema.plans.id, id));
  const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((r) => r[0]);
  return c.json(plan);
});

// Update a step's prompt (edit plan)
app.patch("/:planId/steps/:stepId", async (c) => {
  const { stepId } = c.req.param();
  const body = await c.req.json<{ prompt?: string; description?: string; adapter?: string; model?: string }>();
  await db.update(schema.planSteps)
    .set({ ...body })
    .where(eq(schema.planSteps.id, stepId));
  const step = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId)).then((r) => r[0]);
  return c.json(step);
});

// Execute all steps
app.post("/:id/run-all", async (c) => {
  const id = c.req.param("id");
  const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((r) => r[0]);
  if (!plan) return c.json({ error: "Not found" }, 404);

  const project = plan.projectId
    ? await db.select().from(schema.projects).where(eq(schema.projects.id, plan.projectId)).then((r) => r[0])
    : null;

  const cwd = project?.path || process.cwd();
  runPlanAll(id, cwd).catch((err) => console.error("runPlanAll error:", err));
  return c.json({ ok: true, planId: id }, 202);
});

// Execute next pending step (step-by-step)
app.post("/:id/run-next", async (c) => {
  const id = c.req.param("id");
  const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((r) => r[0]);
  if (!plan) return c.json({ error: "Not found" }, 404);

  const allSteps = await db.select().from(schema.planSteps)
    .where(eq(schema.planSteps.planId, id))
    .orderBy(asc(schema.planSteps.stepIndex));

  const nextStep = allSteps.find((r) => r.status === "pending");
  if (!nextStep) return c.json({ done: true }, 200);

  const isLastPending = allSteps.filter((s) => s.status === "pending").length === 1;

  const project = plan.projectId
    ? await db.select().from(schema.projects).where(eq(schema.projects.id, plan.projectId)).then((r) => r[0])
    : null;
  const cwd = project?.path || process.cwd();

  // Start watcher for live preview (stop when this step finishes, or when plan:done fires)
  startWatch(id, cwd);

  runPlanStep({ planId: id, stepId: nextStep.id, cwd })
    .then(async () => {
      // If this was the last pending step, stop the watcher
      if (isLastPending) stopWatch(id);
    })
    .catch((err) => {
      stopWatch(id);
      console.error("runPlanStep error:", err);
    });

  return c.json({ ok: true, stepId: nextStep.id }, 202);
});

// Resume plan: reset failed steps to pending, then run all pending
app.post("/:id/resume", async (c) => {
  const id = c.req.param("id");
  const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((r) => r[0]);
  if (!plan) return c.json({ error: "Not found" }, 404);

  // Reset all failed steps back to pending
  await db.update(schema.planSteps)
    .set({ status: "pending", errorMessage: null, startedAt: null, finishedAt: null })
    .where(and(eq(schema.planSteps.planId, id), eq(schema.planSteps.status, "failed")));

  // Reset plan status to running
  await db.update(schema.plans)
    .set({ status: "running", updatedAt: new Date().toISOString() })
    .where(eq(schema.plans.id, id));

  const project = plan.projectId
    ? await db.select().from(schema.projects).where(eq(schema.projects.id, plan.projectId)).then((r) => r[0])
    : null;
  const cwd = project?.path || process.cwd();

  runPlanAll(id, cwd).catch((err) => console.error("runPlanAll resume error:", err));
  return c.json({ ok: true, planId: id }, 202);
});

// Retry a single step: reset it to pending and run it (plus remaining pending)
app.post("/:planId/steps/:stepId/retry", async (c) => {
  const { planId, stepId } = c.req.param();
  const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, planId)).then((r) => r[0]);
  if (!plan) return c.json({ error: "Not found" }, 404);

  // Reset this specific step to pending
  await db.update(schema.planSteps)
    .set({ status: "pending", errorMessage: null, result: null, startedAt: null, finishedAt: null })
    .where(eq(schema.planSteps.id, stepId));

  await db.update(schema.plans)
    .set({ status: "running", updatedAt: new Date().toISOString() })
    .where(eq(schema.plans.id, planId));

  const project = plan.projectId
    ? await db.select().from(schema.projects).where(eq(schema.projects.id, plan.projectId)).then((r) => r[0])
    : null;
  const cwd = project?.path || process.cwd();

  runPlanAll(planId, cwd).catch((err) => console.error("runPlanStep retry error:", err));
  return c.json({ ok: true, stepId }, 202);
});

// Cancel plan generation (while still generating)
app.post("/:id/cancel-generation", async (c) => {
  const id = c.req.param("id");
  const kill = generatingKills.get(id);
  if (kill) {
    kill();
    generatingKills.delete(id);
  }
  await db.update(schema.plans)
    .set({ status: "cancelled", updatedAt: new Date().toISOString() })
    .where(eq(schema.plans.id, id));
  broadcast({ type: "plan:error", planId: id, error: "Generación cancelada", timestamp: new Date().toISOString() } as any);
  return c.json({ ok: true });
});

// Cancel plan execution
app.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  stopWatch(id);
  await db.update(schema.plans)
    .set({ status: "cancelled", updatedAt: new Date().toISOString() })
    .where(eq(schema.plans.id, id));
  await db.update(schema.planSteps)
    .set({ status: "cancelled" })
    .where(and(eq(schema.planSteps.planId, id), eq(schema.planSteps.status, "pending")));
  broadcast({ type: "plan:done", planId: id, status: "cancelled", timestamp: new Date().toISOString() } as any);
  return c.json({ ok: true });
});

// Get file changes recorded for a plan
app.get("/:id/file-changes", async (c) => {
  const id = c.req.param("id");
  const rows = await db
    .select()
    .from(schema.planFileChanges)
    .where(eq(schema.planFileChanges.planId, id))
    .orderBy(asc(schema.planFileChanges.changedAt));
  return c.json(rows);
});

// Get chat history for a plan
app.get("/:planId/chat-history", async (c) => {
  const planId = c.req.param("planId");
  const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, planId)).then((r) => r[0]);
  if (!plan) return c.json({ error: "Not found" }, 404);
  if (!plan.chatHistory) return c.json({ messages: [] });
  try {
    const messages = JSON.parse(plan.chatHistory);
    return c.json({ messages });
  } catch {
    return c.json({ messages: [] });
  }
});

// Save chat history for a plan
app.post("/:planId/chat-history", async (c) => {
  const planId = c.req.param("planId");
  const body = await c.req.json<{ messages: Array<{ role: "user" | "assistant"; content: string; streaming?: boolean }> }>();
  await db.update(schema.plans)
    .set({ chatHistory: JSON.stringify(body.messages) })
    .where(eq(schema.plans.id, planId));
  return c.json({ ok: true });
});

// Delete plan
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  // Kill active generation if any
  const kill = generatingKills.get(id);
  if (kill) { kill(); generatingKills.delete(id); }
  await db.delete(schema.planSteps).where(eq(schema.planSteps.planId, id));
  await db.delete(schema.plans).where(eq(schema.plans.id, id));
  return c.json({ ok: true });
});

export default app;

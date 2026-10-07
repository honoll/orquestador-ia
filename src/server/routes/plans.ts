import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { eq, desc, asc, and, inArray } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { generatePlan, type GeneratedPlan } from "../planner.js";
import { defaultBudget, extendBudget, MAX_PARALLEL_LIMIT, toDagSteps, pickRunnable } from "../plan-dag.js";
import { ROUTABLE_ADAPTERS } from "../../config/models.js";
import { runPlanDag, cancelPlanRun, isPlanRunning, retrySynthesis } from "../plan-scheduler.js";
import { broadcast } from "../ws.js";
import { indexVault } from "../../memory/vault-index.js";
import { retrieveMemory, buildMemorySection, type MemoryResult } from "../../memory/retrieve.js";
import { createOllamaEmbedder } from "../../memory/ollama.js";
import { memoryConfig } from "../../memory/config.js";
import { classifyTier, trivialWrites, makeTrivialStep, addReviewStep, TRIVIAL_ESTIMATED_TOKENS } from "../plan-tier.js";

const app = new Hono();

async function planCwd(plan: typeof schema.plans.$inferSelect): Promise<string> {
  const project = plan.projectId
    ? await db.select().from(schema.projects).where(eq(schema.projects.id, plan.projectId)).then((r) => r[0])
    : null;
  return project?.path || process.cwd();
}
const RUNNING = { error: "El plan ya se está ejecutando" };
async function getPlan(id: string) {
  return db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((r) => r[0]);
}

/** Pasos que no terminaron (fallidos, cancelados o running huérfanos) vuelven a pending. */
async function resetUnfinishedSteps(planId: string) {
  await db.update(schema.planSteps)
    .set({ status: "pending", errorMessage: null, startedAt: null, finishedAt: null })
    .where(and(eq(schema.planSteps.planId, planId), inArray(schema.planSteps.status, ["failed", "cancelled", "running"])));
}
/** Una respuesta final vieja no sobrevive a un reintento. */
async function clearSynthesis(planId: string) {
  await db.update(schema.plans)
    .set({ synthesisStatus: null, synthesis: null, synthesisError: null, updatedAt: new Date().toISOString() })
    .where(eq(schema.plans.id, planId));
}

/** True si el plan ya no existe o la generación fue cancelada mientras corría el segundo plano. */
async function generationCancelled(planId: string): Promise<boolean> {
  const p = await getPlan(planId);
  return !p || p.status === "cancelled";
}

// Active plan-generation kill functions
const generatingKills = new Map<string, () => void>();

const MEMORY_INDEX_TIMEOUT_MS = 20_000;
/** La consulta de recuperación (un solo embedding) no espera más de esto. */
const MEMORY_QUERY_TIMEOUT_MS = 10_000;

/** Indexa (incremental) y recupera memoria de Cerebro; nunca lanza ni bloquea más de 20 s + 10 s. */
async function loadMemory(description: string, project: { name: string; path: string } | null | undefined): Promise<MemoryResult> {
  try {
    const cfg = memoryConfig();
    const embedder = createOllamaEmbedder(cfg);
    const queryEmbedder = createOllamaEmbedder({ timeoutMs: MEMORY_QUERY_TIMEOUT_MS });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        indexVault({ vaultPath: cfg.vaultPath, embedder, model: cfg.model }).catch(() => null),
        new Promise((resolve) => { timer = setTimeout(resolve, MEMORY_INDEX_TIMEOUT_MS); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return await retrieveMemory({ query: description, project, embedder: queryEmbedder });
  } catch (err) {
    console.error("[memoria] recuperación omitida:", (err as Error)?.message);
    return { notes: [], source: "none" };
  }
}

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
    let reviewKey: string | undefined;

    const tier = await classifyTier(body.description);
    if (await generationCancelled(planId)) return;
    await db.update(schema.plans)
      .set({ tier: tier.tier, tierConfidence: tier.confidence, tierSource: tier.source, updatedAt: new Date().toISOString() })
      .where(eq(schema.plans.id, planId));
    broadcast({ type: "plan:tier", planId, ...tier, timestamp: new Date().toISOString() } as any);
    const trivial = tier.tier === "trivial";

    if (trivial) {
      const writes = await trivialWrites(body.description);
      if (await generationCancelled(planId)) return;
      generated = {
        steps: [makeTrivialStep(body.description, writes)],
        estimatedTokens: TRIVIAL_ESTIMATED_TOKENS,
      };
    }

    let memorySection = "";
    if (!trivial) {
      broadcast({ type: "plan:memory", planId, source: "loading", timestamp: new Date().toISOString() } as any);
      const mem = await loadMemory(body.description, project ? { name: project.name, path: project.path } : null);
      if (await generationCancelled(planId)) return;
      memorySection = buildMemorySection(mem);
      const noExcerpt = mem.notes.map(({ excerpt: _excerpt, ...rest }) => rest);
      await db.update(schema.plans)
        .set({
          memoryNotes: JSON.stringify(noExcerpt),
          memorySource: mem.source,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.plans.id, planId));
      broadcast({ type: "plan:memory", planId, source: mem.source, notes: noExcerpt, timestamp: new Date().toISOString() } as any);
    }

    for (let attempt = 0; !trivial && attempt <= MAX_PLAN_GEN_RETRIES; attempt++) {
      try {
        generated = await generatePlan(
          body.description,
          cwd,
          project ? { name: project.name, path: project.path, projectDescription: project.description } : undefined,
          {
            memory: memorySection,
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

    if (await generationCancelled(planId)) return;

    if (tier.tier === "critical") {
      const withReview = addReviewStep(generated!, body.description);
      reviewKey = withReview.reviewKey;
      generated = withReview;
    }

    for (const step of generated!.steps) {
      await db.insert(schema.planSteps).values({
        id: randomUUID(),
        planId,
        stepIndex: step.stepIndex,
        stepKey: step.key,
        dependsOn: JSON.stringify(step.dependsOn),
        writes: step.writes ? 1 : 0,
        // Revisión crítica y trivial que solo lee: el adapter corre sin permisos de escritura.
        readOnly: step.key === reviewKey || (trivial && !step.writes) ? 1 : 0,
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

    if (trivial && !(await generationCancelled(planId))) {
      runPlanDag(planId, cwd, { mode: "all" }).catch((err) => console.error("runPlanDag trivial error:", err));
    }
  })();

  return c.json({ id: planId, status: "generating", description: body.description, steps: [] }, 202);
});

// Plan settings: token budget and parallelism (registered before PATCH /:id)
app.patch("/:id/settings", async (c) => {
  const id = c.req.param("id");
  const plan = await getPlan(id);
  if (!plan) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{ budgetTokens?: number | null; maxParallel?: number }>().catch(() => ({} as { budgetTokens?: number | null; maxParallel?: number }));
  const set: { budgetTokens?: number | null; maxParallel?: number; updatedAt: string } = { updatedAt: new Date().toISOString() };
  if (body.budgetTokens !== undefined) {
    const v = body.budgetTokens;
    if (!(v === null || (Number.isInteger(v) && (v as number) > 0))) {
      return c.json({ error: "budgetTokens debe ser null o un entero positivo" }, 400);
    }
    set.budgetTokens = v;
  }
  if (body.maxParallel !== undefined) {
    const m = body.maxParallel;
    if (!(Number.isInteger(m) && (m as number) >= 1 && (m as number) <= MAX_PARALLEL_LIMIT)) {
      return c.json({ error: `maxParallel debe ser un entero entre 1 y ${MAX_PARALLEL_LIMIT}` }, 400);
    }
    set.maxParallel = m;
  }
  await db.update(schema.plans).set(set).where(eq(schema.plans.id, id));
  return c.json(await getPlan(id));
});

// Update plan metadata: solo projectId (asignar a proyecto). Cualquier otro campo se ignora en silencio.
app.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const set: { projectId?: string | null; updatedAt: string } = { updatedAt: new Date().toISOString() };
  if (body.projectId === null || typeof body.projectId === "string") set.projectId = body.projectId;
  await db.update(schema.plans)
    .set(set)
    .where(eq(schema.plans.id, id));
  const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((r) => r[0]);
  return c.json(plan);
});

// Edit a step: solo description, adapter, model y prompt (adapter validado). Otros campos se ignoran en silencio.
app.patch("/:planId/steps/:stepId", async (c) => {
  const { planId, stepId } = c.req.param();
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const set: { description?: string; adapter?: string; model?: string | null; prompt?: string; guardApproved?: number; guardFlags?: string | null } = {};
  if (typeof body.description === "string") set.description = body.description;
  if (typeof body.prompt === "string") {
    set.prompt = body.prompt;
    // Un prompt nuevo invalida la aprobación y las banderas de la guardia.
    set.guardApproved = 0;
    set.guardFlags = null;
  }
  if (typeof body.model === "string" || body.model === null) set.model = body.model;
  // Cambiar el adapter de un paso readOnly es seguro: todos los ROUTABLE_ADAPTERS (claude, codex, agy) honran
  // readOnly. Si se agrega uno que no lo honre, aquí hay que rechazar (400) ese cambio para pasos readOnly.
  if (body.adapter !== undefined) {
    if (typeof body.adapter !== "string" || !(ROUTABLE_ADAPTERS as readonly string[]).includes(body.adapter)) {
      return c.json({ error: `adapter debe ser uno de: ${ROUTABLE_ADAPTERS.join(", ")}` }, 400);
    }
    set.adapter = body.adapter;
  }
  if (Object.keys(set).length > 0) {
    await db.update(schema.planSteps)
      .set(set)
      .where(eq(schema.planSteps.id, stepId));
  }
  if (set.prompt !== undefined) {
    // Un prompt nuevo ya no es el que detuvo la guardia: el plan sale de la pausa (se vuelve a evaluar al correr).
    await db.update(schema.plans)
      .set({ pauseReason: null, updatedAt: new Date().toISOString() })
      .where(and(eq(schema.plans.id, planId), eq(schema.plans.pauseReason, "guard")));
  }
  const step = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId)).then((r) => r[0]);
  return c.json(step);
});

// Execute all steps
app.post("/:id/run-all", async (c) => {
  const id = c.req.param("id");
  const plan = await getPlan(id);
  if (!plan) return c.json({ error: "Not found" }, 404);
  if (isPlanRunning(id)) return c.json(RUNNING, 409);
  const hasCancelled = await db.select({ id: schema.planSteps.id }).from(schema.planSteps)
    .where(and(eq(schema.planSteps.planId, id), eq(schema.planSteps.status, "cancelled"))).then((r) => r.length > 0);
  // Un plan pending con pasos cancelados (p. ej. tras reintentar un paso después de detener) también se reanuda.
  if (plan.status === "cancelled" || plan.status === "failed" || hasCancelled) await resetUnfinishedSteps(id);
  runPlanDag(id, await planCwd(plan), { mode: "all" }).catch((err) => console.error("runPlanDag error:", err));
  return c.json({ ok: true, planId: id }, 202);
});

// Execute next pending step (step-by-step)
app.post("/:id/run-next", async (c) => {
  const id = c.req.param("id");
  const plan = await getPlan(id);
  if (!plan) return c.json({ error: "Not found" }, 404);
  if (isPlanRunning(id)) return c.json(RUNNING, 409);

  let allSteps = await db.select().from(schema.planSteps)
    .where(eq(schema.planSteps.planId, id))
    .orderBy(asc(schema.planSteps.stepIndex));
  if (!allSteps.some((r) => r.status === "pending") && allSteps.some((r) => r.status === "cancelled")) {
    // Quedan pasos sin hacer (cancelados): se reanudan en vez de responder done.
    await db.update(schema.planSteps)
      .set({ status: "pending", errorMessage: null, startedAt: null, finishedAt: null })
      .where(and(eq(schema.planSteps.planId, id), eq(schema.planSteps.status, "cancelled")));
    allSteps = await db.select().from(schema.planSteps)
      .where(eq(schema.planSteps.planId, id))
      .orderBy(asc(schema.planSteps.stepIndex));
  }
  if (!allSteps.some((r) => r.status === "pending")) return c.json({ done: true }, 200);
  // El paso que el planificador realmente puede arrancar. Con el plan parado, un running es huérfano
  // (el planificador lo regresa a pending). La cuota de agy no se mira aquí: si bloquea, el planificador pausa.
  const dag = toDagSteps(allSteps).map((s) => (s.status === "running" ? { ...s, status: "pending" as const } : s));
  const [nextStep] = pickRunnable(dag, { maxParallel: plan.maxParallel, agyBlocked: false, limit: 1 });
  if (!nextStep) return c.json({ done: false, blocked: true }, 200);

  runPlanDag(id, await planCwd(plan), { mode: "next" }).catch((err) => console.error("runPlanDag next error:", err));
  return c.json({ ok: true, stepId: nextStep.id }, 202);
});

// Resume plan: failed/cancelled/running huérfanos → pending, borra la síntesis vieja y corre todo
app.post("/:id/resume", async (c) => {
  const id = c.req.param("id");
  const plan = await getPlan(id);
  if (!plan) return c.json({ error: "Not found" }, 404);
  if (isPlanRunning(id)) return c.json(RUNNING, 409);

  await resetUnfinishedSteps(id);
  await clearSynthesis(id);

  runPlanDag(id, await planCwd(plan), { mode: "all" }).catch((err) => console.error("runPlanDag resume error:", err));
  return c.json({ ok: true, planId: id }, 202);
});

// Approve a step flagged by the guard and relaunch the plan
app.post("/:planId/steps/:stepId/approve", async (c) => {
  const { planId, stepId } = c.req.param();
  const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, planId)).then((r) => r[0]);
  const step = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId)).then((r) => r[0]);
  if (!plan || !step || step.planId !== planId) return c.json({ error: "Not found" }, 404);
  if (isPlanRunning(planId)) return c.json(RUNNING, 409);
  if (plan.pauseReason !== "guard" || step.status !== "pending" || step.guardFlags == null) {
    return c.json({ error: "Solo se puede aprobar un paso detenido por la guardia" }, 409);
  }
  await db.update(schema.planSteps).set({ guardApproved: 1 }).where(eq(schema.planSteps.id, stepId));
  runPlanDag(planId, await planCwd(plan), { mode: "all" }).catch((err) => console.error("runPlanDag approve error:", err));
  return c.json({ ok: true }, 202);
});

// Retry a single step: reset it to pending and run it (plus remaining pending)
app.post("/:planId/steps/:stepId/retry", async (c) => {
  const { planId, stepId } = c.req.param();
  const plan = await getPlan(planId);
  if (!plan) return c.json({ error: "Not found" }, 404);
  if (isPlanRunning(planId)) return c.json(RUNNING, 409);

  await db.update(schema.planSteps)
    .set({ status: "pending", errorMessage: null, result: null, startedAt: null, finishedAt: null })
    .where(eq(schema.planSteps.id, stepId));
  await clearSynthesis(planId);

  runPlanDag(planId, await planCwd(plan), { mode: "all" }).catch((err) => console.error("runPlanDag retry error:", err));
  return c.json({ ok: true, stepId }, 202);
});

// Continue after a pause (extends the budget when paused by budget)
app.post("/:id/continue", async (c) => {
  const id = c.req.param("id");
  const plan = await getPlan(id);
  if (!plan) return c.json({ error: "Not found" }, 404);
  if (isPlanRunning(id)) return c.json(RUNNING, 409);

  let budgetTokens = plan.budgetTokens;
  if (plan.pauseReason === "budget") {
    budgetTokens = extendBudget(plan.budgetTokens, plan.usedTokens);
    await db.update(schema.plans)
      .set({ budgetTokens, updatedAt: new Date().toISOString() })
      .where(eq(schema.plans.id, id));
  }
  runPlanDag(id, await planCwd(plan), { mode: "all" }).catch((err) => console.error("runPlanDag continue error:", err));
  return c.json({ ok: true, budgetTokens }, 202);
});

// Retry only the synthesis
app.post("/:id/synthesis/retry", async (c) => {
  const id = c.req.param("id");
  const plan = await getPlan(id);
  if (!plan) return c.json({ error: "Not found" }, 404);
  if (isPlanRunning(id)) return c.json(RUNNING, 409);
  if (plan.status !== "completed" || plan.synthesisStatus !== "failed") {
    return c.json({ error: "Solo se puede reintentar una síntesis fallida de un plan completado" }, 409);
  }
  retrySynthesis(id).catch((err) => console.error("retrySynthesis error:", err));
  return c.json({ ok: true }, 202);
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
  cancelPlanRun(id);
  await db.update(schema.plans)
    .set({ status: "cancelled", pauseReason: null, updatedAt: new Date().toISOString() })
    .where(eq(schema.plans.id, id));
  // Una síntesis en curso queda sin estado; el texto previo (synthesis) no se toca.
  await db.update(schema.plans)
    .set({ synthesisStatus: null })
    .where(and(eq(schema.plans.id, id), eq(schema.plans.synthesisStatus, "running")));
  await db.update(schema.planSteps)
    .set({ status: "cancelled" })
    .where(and(eq(schema.planSteps.planId, id), inArray(schema.planSteps.status, ["pending", "running"])));
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
  cancelPlanRun(id); // mata la corrida en curso antes de borrar
  await db.delete(schema.planSteps).where(eq(schema.planSteps.planId, id));
  await db.delete(schema.plans).where(eq(schema.plans.id, id));
  return c.json({ ok: true });
});

export default app;

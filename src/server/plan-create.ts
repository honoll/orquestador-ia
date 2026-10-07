import { randomUUID } from "node:crypto";
import { eq, asc } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { generatePlan, type GeneratedPlan } from "./planner.js";
import { defaultBudget } from "./plan-dag.js";
import { runPlanDag, isPlanRunning } from "./plan-scheduler.js";
import { broadcast } from "./ws.js";
import { indexVault } from "../memory/vault-index.js";
import { buildMemorySection, retrieveMemory, type MemoryResult } from "../memory/retrieve.js";
import { createOllamaEmbedder } from "../memory/ollama.js";
import { memoryConfig } from "../memory/config.js";
import { classifyTier, trivialWrites, makeTrivialStep, addReviewStep, TRIVIAL_ESTIMATED_TOKENS } from "./plan-tier.js";

export async function planCwd(plan: typeof schema.plans.$inferSelect): Promise<string> {
  const project = plan.projectId
    ? await db.select().from(schema.projects).where(eq(schema.projects.id, plan.projectId)).then((r) => r[0])
    : null;
  return project?.path || process.cwd();
}

async function getPlan(id: string) {
  return db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((r) => r[0]);
}

/** True si el plan ya no existe o la generación fue cancelada mientras corría el segundo plano. */
async function generationCancelled(planId: string): Promise<boolean> {
  const p = await getPlan(planId);
  return !p || p.status === "cancelled";
}
// Active plan-generation kill functions
export const generatingKills = new Map<string, () => void>();

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

/**
 * Crea un plan: inserta la fila "generating" y lanza en segundo plano tier, memoria, generación,
 * pasos, plan:ready y (trivial) auto-ejecución. Devuelve de inmediato el id.
 */
export async function createPlan(input: { description: string; projectId?: string | null; cwd?: string | null }): Promise<{ id: string }> {
  const project = input.projectId
    ? await db.select().from(schema.projects).where(eq(schema.projects.id, input.projectId)).then((r) => r[0])
    : null;

  const cwd = input.cwd || project?.path || process.cwd();

  const planId = randomUUID();
  await db.insert(schema.plans).values({
    id: planId,
    projectId: input.projectId ?? null,
    description: input.description,
    status: "generating",
  });

  // Generate in background, streaming progress via WS
  (async () => {
    const MAX_PLAN_GEN_RETRIES = 2;
    const RATE_LIMIT_WAIT_MS = 60_000;
    let generated: GeneratedPlan | null = null;
    let lastErr: any = null;
    let reviewKey: string | undefined;

    const tier = await classifyTier(input.description);
    if (await generationCancelled(planId)) return;
    await db.update(schema.plans)
      .set({ tier: tier.tier, tierConfidence: tier.confidence, tierSource: tier.source, updatedAt: new Date().toISOString() })
      .where(eq(schema.plans.id, planId));
    broadcast({ type: "plan:tier", planId, ...tier, timestamp: new Date().toISOString() } as any);
    const trivial = tier.tier === "trivial";

    if (trivial) {
      const writes = await trivialWrites(input.description);
      if (await generationCancelled(planId)) return;
      generated = {
        steps: [makeTrivialStep(input.description, writes)],
        estimatedTokens: TRIVIAL_ESTIMATED_TOKENS,
      };
    }

    let memorySection = "";
    if (!trivial) {
      broadcast({ type: "plan:memory", planId, source: "loading", timestamp: new Date().toISOString() } as any);
      const mem = await loadMemory(input.description, project ? { name: project.name, path: project.path } : null);
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
          input.description,
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
      const withReview = addReviewStep(generated!, input.description);
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
  return { id: planId };
}

/** Arranca un plan desde código. Los planes críticos exigen aprobación explícita (la UI), nunca se lanzan aquí. */
export async function startPlanIfAllowed(planId: string): Promise<"started" | "needs-approval" | "not-ready" | "running"> {
  const plan = await getPlan(planId);
  if (!plan || plan.status === "generating" || plan.status === "failed") return "not-ready";
  if (isPlanRunning(planId)) return "running";
  if (plan.tier === "critical") return "needs-approval";
  runPlanDag(planId, await planCwd(plan), { mode: "all" }).catch((err) => console.error("runPlanDag error:", err));
  return "started";
}

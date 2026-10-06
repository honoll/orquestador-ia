import os from "node:os";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { db, schema } from "../db/index.js";
import { broadcast } from "./ws.js";
import { startWatch, stopWatch } from "./file-watcher.js";
import { runPlanStep, type StepOutcome } from "./plan-runner.js";
import { getActiveAccount } from "./agy-accounts.js";
import { guardStep } from "./plan-guard.js";
import { getAdapter } from "../adapters/registry.js";
import { PLANNER_MODEL } from "../config/models.js";
import {
  toDagSteps, pickRunnable, hasReadyAgyStep, budgetExceeded, buildStepPrompt, buildSynthesisPrompt, type DagStep,
} from "./plan-dag.js";

const log = pino({ name: "plan-scheduler" });

interface ActiveRun {
  cancelled: boolean;
  kills: Set<() => void>;
}

/** Planes en ejecución (en este proceso). El planificador es el único dueño del estado del plan. */
const active = new Map<string, ActiveRun>();

const now = () => new Date().toISOString();
const emit = (event: Record<string, unknown>) => broadcast({ ...event, timestamp: now() } as any);

/** Registra el kill de un proceso; si el run ya está cancelado, lo mata en cuanto aparece. */
function registerKill(run: ActiveRun, kill: () => void): void {
  run.kills.add(kill);
  if (run.cancelled) {
    try { kill(); } catch { /* proceso ya terminado */ }
  }
}

function killAll(run: ActiveRun): void {
  for (const kill of run.kills) {
    try { kill(); } catch { /* proceso ya terminado */ }
  }
}

export function isPlanRunning(planId: string): boolean {
  return active.has(planId);
}

/** Marca el plan como cancelado y mata los procesos en curso. */
export function cancelPlanRun(planId: string): boolean {
  const run = active.get(planId);
  if (!run) return false;
  run.cancelled = true;
  killAll(run);
  return true;
}

async function getPlan(planId: string) {
  const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, planId)).then((r) => r[0]);
  if (!plan) throw new Error(`Plan ${planId} not found`);
  return plan;
}

async function setPlan(planId: string, patch: Partial<typeof schema.plans.$inferInsert>) {
  await db.update(schema.plans).set({ ...patch, updatedAt: now() }).where(eq(schema.plans.id, planId));
}

/**
 * Salida por cancelación: la ruta de cancelar ya marcó el plan y emitió plan:done, pero el planificador
 * lo vuelve a escribir (idempotente) para que una carrera no deje el plan en running. No emite plan:done.
 */
async function markCancelled(planId: string): Promise<void> {
  await setPlan(planId, { status: "cancelled", pauseReason: null });
  await db.update(schema.plans).set({ synthesisStatus: null })
    .where(and(eq(schema.plans.id, planId), eq(schema.plans.synthesisStatus, "running")));
}

async function addUsedTokens(planId: string, tokens: number) {
  if (tokens > 0) {
    await db.update(schema.plans).set({ usedTokens: sql`${schema.plans.usedTokens} + ${tokens}` }).where(eq(schema.plans.id, planId));
  }
  const p = await getPlan(planId);
  emit({ type: "plan:budget", planId, usedTokens: p.usedTokens, budgetTokens: p.budgetTokens });
}

async function agyBlockedNow(): Promise<boolean> {
  const account = await getActiveAccount();
  return !!account?.quotaBlockedUntil && Date.parse(account.quotaBlockedUntil) > Date.now();
}

/**
 * Ejecuta el plan como grafo: arranca los pasos listos (lectores en paralelo, escritores en fila, hasta
 * maxParallel), pausa por cuota o presupuesto, y al terminar todo corre la síntesis de Opus.
 * mode "next": corre un solo paso y deja el plan en pending.
 */
export async function runPlanDag(planId: string, cwd: string, opts: { mode?: "all" | "next" } = {}): Promise<void> {
  if (active.has(planId)) return;
  const mode = opts.mode ?? "all";
  const run: ActiveRun = { cancelled: false, kills: new Set() };
  active.set(planId, run);

  try {
    // Huérfanos tras un reinicio: con el plan ya registrado aquí nadie más es dueño de sus pasos.
    await db.update(schema.planSteps).set({ status: "pending" })
      .where(and(eq(schema.planSteps.planId, planId), eq(schema.planSteps.status, "running")));
    await db.update(schema.plans).set({ synthesisStatus: null })
      .where(and(eq(schema.plans.id, planId), eq(schema.plans.synthesisStatus, "running")));
    await setPlan(planId, { status: "running", pauseReason: null });
    startWatch(planId, cwd);

    const inFlight = new Map<string, Promise<{ stepId: string; outcome: StepOutcome }>>();
    let failed = false;
    let pause: "quota" | "budget" | "guard" | null = null;
    let launched = 0;

    for (;;) {
      const plan = await getPlan(planId);
      const rows = await db.select().from(schema.planSteps).where(eq(schema.planSteps.planId, planId));
      const dag = toDagSteps(rows);
      const rowById = new Map(rows.map((r) => [r.id, r]));
      const dagByKey = new Map(dag.map((d) => [d.key, d]));

      let picks: DagStep[] = [];
      const stopLaunching = run.cancelled || failed || pause !== null || (mode === "next" && launched >= 1);
      if (!stopLaunching) {
        if (budgetExceeded(plan.usedTokens, plan.budgetTokens)) {
          pause = "budget";
        } else {
          const agyBlocked = await agyBlockedNow();
          picks = pickRunnable(dag, {
            maxParallel: plan.maxParallel,
            agyBlocked,
            limit: mode === "next" ? 1 - launched : undefined,
          });
          if (picks.length === 0 && inFlight.size === 0 && agyBlocked && hasReadyAgyStep(dag)) pause = "quota";
        }
      }

      for (const step of picks) {
        const row = rowById.get(step.id)!;
        const deps = step.dependsOn.map((k) => {
          const depRow = rowById.get(dagByKey.get(k)!.id)!;
          return { key: k, description: depRow.description, result: depRow.result };
        });
        // Guardia: solo escritores no aprobados; se evalúa el prompt ORIGINAL (sin el encabezado de buildStepPrompt).
        if (step.writes && row.guardApproved !== 1) {
          const guard = await guardStep({ prompt: row.prompt, deps: deps.map((d) => ({ key: d.key, result: d.result })), projectPath: cwd });
          // La guardia puede tardar (JEV con reintento): si cancelaron mientras tanto, no se lanza.
          if (run.cancelled) continue;
          if (guard.flagged) {
            await db.update(schema.planSteps).set({ guardFlags: JSON.stringify(guard.flags) }).where(eq(schema.planSteps.id, step.id));
            emit({ type: "plan:guard", planId, stepId: step.id, flags: guard.flags, source: guard.source });
            pause = "guard";
            continue; // no se lanza; los lectores de esta misma vuelta sí
          }
          await db.update(schema.planSteps).set({ guardFlags: null }).where(eq(schema.planSteps.id, step.id));
        }
        // Marcar running aquí (no solo dentro de runPlanStep) para que la siguiente vuelta no lo vuelva a elegir.
        await db.update(schema.planSteps).set({ status: "running", startedAt: now(), errorMessage: null }).where(eq(schema.planSteps.id, step.id));
        launched++;
        const promise = runPlanStep({
          planId,
          stepId: step.id,
          cwd,
          promptOverride: buildStepPrompt(row.prompt, deps),
          // Si cancelaron entre el arranque del paso y el spawn, se mata en cuanto haya proceso.
          onKillRegistered: (kill) => registerKill(run, kill),
        })
          .catch(async (err: Error) => {
            log.error({ err, stepId: step.id }, "runPlanStep lanzó una excepción");
            await db.update(schema.planSteps).set({ status: "failed", errorMessage: err.message, finishedAt: now() }).where(eq(schema.planSteps.id, step.id));
            emit({ type: "plan:step", planId, stepId: step.id, status: "failed", error: err.message });
            return { status: "failed", tokensUsed: 0 } as StepOutcome;
          })
          .then((outcome) => ({ stepId: step.id, outcome }));
        inFlight.set(step.id, promise);
      }

      if (inFlight.size === 0) break;

      const { stepId, outcome } = await Promise.race(inFlight.values());
      inFlight.delete(stepId);
      await addUsedTokens(planId, outcome.tokensUsed);

      if (run.cancelled) {
        await db.update(schema.planSteps).set({ status: "cancelled", finishedAt: now() }).where(eq(schema.planSteps.id, stepId));
        emit({ type: "plan:step", planId, stepId, status: "cancelled" });
        continue;
      }
      if (outcome.status === "failed") failed = true;
      if (outcome.status === "paused_quota") pause = "quota";
    }

    stopWatch(planId);
    if (run.cancelled) {
      await markCancelled(planId); // la ruta de cancelar ya emitió plan:done
      return;
    }

    if (failed) {
      await setPlan(planId, { status: "failed" });
      emit({ type: "plan:done", planId, status: "failed" });
      return;
    }
    if (pause) {
      await setPlan(planId, { status: "pending", pauseReason: pause });
      emit({ type: "plan:done", planId, status: "pending", paused: pause });
      return;
    }

    const finalRows = await db.select().from(schema.planSteps).where(eq(schema.planSteps.planId, planId));
    // Cancelados no cuentan como hechos: el plan queda pending hasta que se reanude.
    const allDone = finalRows.length > 0 && finalRows.every((s) => s.status === "succeeded" || s.status === "skipped");
    if (!allDone) {
      await setPlan(planId, { status: "pending" });
      // En modo next que sí lanzó un paso, la UI espera "continuar"; si no lanzó nada, sale del paso a paso.
      if (mode !== "next" || launched === 0) emit({ type: "plan:done", planId, status: "pending" });
      return;
    }

    const plan = await getPlan(planId);
    if (plan.synthesisStatus === "succeeded") {
      await setPlan(planId, { status: "completed" });
      emit({ type: "plan:done", planId, status: "completed" });
      return;
    }
    await runSynthesis(planId, run);
  } catch (err) {
    // Error inesperado (p. ej. la base de datos): matar lo que corre y dejar el plan failed, sin relanzar.
    log.error({ err, planId }, "runPlanDag falló de forma inesperada");
    killAll(run);
    if (run.cancelled) {
      // Cancelar nunca deja el plan failed.
      try { await markCancelled(planId); } catch (dbErr) { log.error({ err: dbErr, planId }, "No se pudo marcar el plan como cancelled"); }
      return;
    }
    const message = (err as Error)?.message ?? String(err);
    try {
      await setPlan(planId, { status: "failed", errorMessage: message.slice(0, 2000) });
    } catch (dbErr) {
      log.error({ err: dbErr, planId }, "No se pudo marcar el plan como failed");
    }
    emit({ type: "plan:done", planId, status: "failed", error: message });
  } finally {
    stopWatch(planId); // idempotente: cubre la salida por excepción
    active.delete(planId);
  }
}

/** Opus 5.5 junta los resultados en la respuesta final. Asume que el plan no tiene pasos corriendo. */
export async function runSynthesis(planId: string, run?: ActiveRun): Promise<void> {
  const plan = await getPlan(planId);
  if (budgetExceeded(plan.usedTokens, plan.budgetTokens)) {
    await setPlan(planId, { status: "pending", pauseReason: "budget" });
    emit({ type: "plan:done", planId, status: "pending", paused: "budget" });
    return;
  }

  await setPlan(planId, { status: "running", synthesisStatus: "running", synthesisError: null, pauseReason: null });
  emit({ type: "plan:synthesis", planId, status: "running" });

  const rows = (await db.select().from(schema.planSteps).where(eq(schema.planSteps.planId, planId)))
    .sort((a, b) => a.stepIndex - b.stepIndex);
  const dag = toDagSteps(rows);
  const keyById = new Map(dag.map((d) => [d.id, d.key]));
  const prompt = buildSynthesisPrompt(
    plan.description,
    rows.filter((r) => r.status === "succeeded").map((r) => ({ key: keyById.get(r.id)!, description: r.description, adapter: r.adapter, result: r.result })),
  );

  const claude = getAdapter("claude");
  let errorMessage: string | null = null;
  let text = "";
  try {
    if (!claude) throw new Error("Adapter claude no disponible para la síntesis");
    const result = await claude.execute({
      runId: randomUUID(),
      prompt,
      model: PLANNER_MODEL,
      cwd: os.tmpdir(), // sin CLAUDE.md del proyecto
      timeoutSec: 600,
      readOnly: true,
      onLog: (stream, data) => emit({ type: "plan:synthesis:log", planId, stream, data }),
      onKill: run ? (kill) => registerKill(run, kill) : undefined,
    });
    await addUsedTokens(planId, (result.inputTokens || 0) + (result.outputTokens || 0));
    text = result.summary?.trim() ?? "";
    if (result.exitCode !== 0 || result.timedOut || !text) {
      errorMessage = result.errorMessage ?? (text ? `exit ${result.exitCode}` : "La síntesis vino vacía");
    }
  } catch (err) {
    errorMessage = (err as Error).message;
  }

  // Cancelado durante la síntesis: la ruta ya emitió plan:done; solo se reescribe el estado (idempotente).
  if (run?.cancelled) {
    await markCancelled(planId);
    return;
  }

  if (errorMessage) {
    await setPlan(planId, { status: "completed", synthesisStatus: "failed", synthesisError: errorMessage.slice(0, 2000) });
    emit({ type: "plan:synthesis", planId, status: "failed", error: errorMessage });
  } else {
    await setPlan(planId, { status: "completed", synthesisStatus: "succeeded", synthesis: text });
    emit({ type: "plan:synthesis", planId, status: "succeeded", synthesis: text });
  }
  emit({ type: "plan:done", planId, status: "completed" });
}

/** Reintento manual de la síntesis (botón de la UI). */
export async function retrySynthesis(planId: string): Promise<boolean> {
  if (active.has(planId)) return false;
  const run: ActiveRun = { cancelled: false, kills: new Set() };
  active.set(planId, run);
  try {
    await runSynthesis(planId, run);
  } finally {
    active.delete(planId);
  }
  return true;
}

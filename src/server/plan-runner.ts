import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "../db/index.js";
import { getAdapter } from "../adapters/registry.js";
import { broadcast } from "./ws.js";
import { claudeProfileManager } from "../adapters/claude/profile-manager.js";
import { recordAgyCall, NoActiveAccountError } from "./agy-accounts.js";
import { pickWorker, agyAvailability, markWorkerHealth, markWorkerBusy, tagLease, cwdAllowsWorkers, type AgyLease } from "./agy-workers.js";
import { WorkerUnavailableError } from "../adapters/agy/worker-client.js";
import { parseStepStatus } from "./step-status.js";
import { getRole } from "./roles.js";
import { ensureOutputsDir, ensureGitignore, gitSnapshot, changedOutside } from "./outputs.js";
import pino from "pino";

const log = pino({ name: "plan-runner" });

const TRANSIENT_RE = /429|503|529|overloaded|rate.limit|capacity|too many requests|rate limit de claude/i;
const UNKNOWN_SESSION_RE = /unknown session|session.*not found|invalid.*session/i;
const MAX_RETRIES = 2;
export const QUOTA_PAUSE_PREFIX = "Pausado por cuota";

/** requeued: el paso agy volvió a pending sin gastar llamada porque no había cuenta libre (el planificador lo relanza). */
export type StepOutcomeStatus = "succeeded" | "failed" | "paused_quota" | "requeued";
export interface StepOutcome {
  status: StepOutcomeStatus;
  tokensUsed: number;
  /** requeued: reintentos ya gastados, para seguir la cuenta al relanzar (startAttempt). */
  attempt?: number;
}

export interface StepRunOptions {
  planId: string;
  stepId: string;
  cwd: string;
  /** Reemplaza el prompt guardado del paso (p. ej. con contexto de pasos previos) */
  promptOverride?: string;
  /** Kill handle set externally to allow cancellation */
  onKillRegistered?: (kill: () => void) => void;
  /** agy: cuenta ya reservada por el planificador para el primer intento (se libera siempre al terminar). */
  agyLease?: AgyLease;
  /** Reintentos ya gastados en un lanzamiento anterior que terminó requeued. */
  startAttempt?: number;
}

/** No quedó cuenta de agy para el paso: cancelado, sin cuentas, todas las bolsas sin cuota (pausa) o trabajadores caídos. */
async function agyNoAccount(o: { planId: string; stepId: string; lastQuotaLabel: string | null; lastError: string | null; tokensUsed: number; localOnly: boolean }): Promise<StepOutcome> {
  const { planId, stepId, tokensUsed } = o;
  const avail = await agyAvailability(Date.now(), { localOnly: o.localOnly });
  if (avail.total > 0 && avail.usable === 0) {
    const msg = `${QUOTA_PAUSE_PREFIX}: todas las bolsas de agy están sin cuota${o.lastQuotaLabel ? ` (última cuenta: "${o.lastQuotaLabel}")` : ""}; vuelve a ejecutar el plan cuando se libere alguna.`;
    await db.update(schema.planSteps).set({ status: "pending", errorMessage: msg }).where(eq(schema.planSteps.id, stepId));
    broadcast({ type: "plan:step", planId, stepId, status: "pending", adapter: "agy", error: msg, timestamp: new Date().toISOString() } as any);
    return { status: "paused_quota", tokensUsed };
  }
  const msg = avail.total === 0
    ? new NoActiveAccountError().message
    : `Ningún trabajador de agy disponible${o.lastError ? ` (último error: ${o.lastError})` : ""}`;
  await db.update(schema.planSteps).set({ status: "failed", errorMessage: msg, finishedAt: new Date().toISOString() }).where(eq(schema.planSteps.id, stepId));
  broadcast({ type: "plan:step", planId, stepId, status: "failed", adapter: "agy", error: msg, timestamp: new Date().toISOString() } as any);
  return { status: "failed", tokensUsed };
}

/** Hay cuentas usables pero todas ocupadas: el paso vuelve a pending en vez de quedarse "running" esperando. */
async function requeue(planId: string, stepId: string, tokensUsed: number, attempt: number): Promise<StepOutcome> {
  await db.update(schema.planSteps).set({ status: "pending", startedAt: null }).where(eq(schema.planSteps.id, stepId));
  broadcast({ type: "plan:step", planId, stepId, status: "pending", adapter: "agy", timestamp: new Date().toISOString() } as any);
  return { status: "requeued", tokensUsed, attempt };
}

/** Execute a single plan step with retry logic. Solo ejecuta: no toca el estado del plan. */
export async function runPlanStep(options: StepRunOptions): Promise<StepOutcome> {
  try {
    return await runPlanStepInner(options);
  } finally {
    options.agyLease?.release(); // idempotente: cubre las salidas antes del primer intento
  }
}

async function runPlanStepInner(options: StepRunOptions): Promise<StepOutcome> {
  const { planId, stepId, cwd } = options;

  const stepRows = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId));
  if (stepRows.length === 0) throw new Error(`Step ${stepId} not found`);
  const step = stepRows[0];
  let prompt = options.promptOverride ?? step.prompt;
  const planLog = (stream: "stdout" | "stderr", data: string) =>
    broadcast({ type: "plan:log", planId, stepId, stream, data, timestamp: new Date().toISOString() } as any);

  // F11: los roles que escriben "salidas" (imagen) guardan todo en una carpeta propia del plan, dentro del proyecto.
  let gitBefore: Set<string> | null = null;
  if (step.role && getRole(step.role)?.escribe === "salidas") {
    try {
      if (ensureGitignore(cwd)) planLog("stdout", "\n[orquestador] se agregó .orquestador/ al .gitignore del proyecto\n");
      const outDir = ensureOutputsDir(cwd, planId);
      prompt += `\n\nCARPETA DE SALIDAS de este plan: ${outDir}\nGuarda TODO lo que generes únicamente aquí; no escribas ni modifiques nada fuera de esa carpeta.`;
      gitBefore = await gitSnapshot(cwd);
    } catch (err) { log.error({ err, stepId }, "No se pudo preparar la carpeta de salidas"); }
  }

  const adapter = getAdapter(step.adapter);
  if (!adapter) throw new Error(`Unknown adapter: ${step.adapter}`);

  await db.update(schema.planSteps)
    .set({ status: "running", startedAt: new Date().toISOString(), errorMessage: null, statusDetail: null })
    .where(eq(schema.planSteps.id, stepId));

  broadcast({ type: "plan:step", planId, stepId, status: "running", adapter: step.adapter, timestamp: new Date().toISOString() } as any);

  // agy (F10): cada intento toma una cuenta libre (local o trabajador), sin esperar. Cuota → se excluye su bolsa;
  // trabajador caído → se excluye la cuenta; ninguno de los dos gasta reintento. Sin cuenta libre → requeued.
  const isAgy = step.adapter === "agy";
  const quotaPools = new Set<string>();
  const downAccounts = new Set<string>();
  let preLease = options.agyLease ?? null;
  let lastQuotaLabel: string | null = null;
  const localOnly = isAgy && !cwdAllowsWorkers(cwd);

  let sessionId = step.sessionId ?? undefined;
  let lastError: string | null = null;
  let tokensUsed = 0;
  // For Claude steps: track which profile we're using across retries (only if API keys configured)
  let claudeProfile = step.adapter === "claude"
    ? claudeProfileManager.getBestProfile()
    : null;
  let claudeProfileEnv = claudeProfile
    ? claudeProfileManager.getEnvForProfile(claudeProfile.id)
    : undefined;

  let linkedRunId = step.runId ?? null;
  for (let attempt = Math.max(0, options.startAttempt ?? 0); attempt <= MAX_RETRIES; attempt++) {
    // Retry delay for transient errors
    // Al relanzar tras un requeued la espera de este intento ya se hizo antes de quedarse sin cuenta.
    if (attempt > 0 && attempt > (options.startAttempt ?? 0)) {
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }

    let lease: AgyLease | null = null;
    if (isAgy) {
      const ex = { pools: quotaPools, accounts: downAccounts, localOnly };
      lease = preLease ?? await pickWorker(Date.now(), ex);
      preLease = null;
      if (lease) tagLease(lease.accountId, step.description, step.model ?? null);
      if (!lease) {
        if ((await agyAvailability(Date.now(), ex)).usable > 0) return requeue(planId, stepId, tokensUsed, attempt);
        return agyNoAccount({ planId, stepId, lastQuotaLabel, lastError, tokensUsed, localOnly });
      }
    }

    const runId = randomUUID();
    let prevRunId: string | null = linkedRunId;

    // Create a task + run record for traceability
    const taskId = randomUUID();
    try {
      await db.insert(schema.tasks).values({
        id: taskId,
        title: step.description.slice(0, 80),
        prompt,
        adapter: step.adapter,
        model: step.model ?? null,
        status: "running",
      });
      await db.insert(schema.runs).values({
        id: runId,
        taskId,
        adapter: step.adapter,
        model: step.model ?? null,
        status: "running",
        prompt,
        cwd,
      });
      // Liga el paso a su run desde el arranque: la Oficina excluye estos runs del "chat suelto".
      await db.update(schema.planSteps).set({ runId }).where(eq(schema.planSteps.id, stepId));
      prevRunId = linkedRunId;
      linkedRunId = runId;
    } catch (err) {
      lease?.release(); // un error de base no deja la cuenta reservada para siempre
      throw err;
    }

    try {
      const callStartedAt = Date.now();
      const result = await adapter.execute({
        runId,
        prompt,
        model: step.model ?? undefined,
        cwd,
        sessionId,
        timeoutSec: 1800,
        readOnly: step.readOnly === 1,
        claudeProfileEnv,
        agyWorker: lease?.worker ? { port: lease.worker.port, keyPath: lease.worker.keyPath } : undefined,
        onLog: (stream, chunk) => {
          broadcast({
            type: "plan:log",
            planId,
            stepId,
            stream,
            data: chunk,
            timestamp: new Date().toISOString(),
          } as any);
        },
        onKill: (kill) => options.onKillRegistered?.(kill),
      });

      tokensUsed += (result.inputTokens || 0) + (result.outputTokens || 0);

      if (lease) {
        if (lease.worker) markWorkerHealth(lease.worker.id, true);
        try { await recordAgyCall(lease.accountId, result, "plan", Date.now(), callStartedAt); } catch (err) { log.error({ err, stepId }, "No se pudo registrar el consumo de agy"); }
      }

      if (lease && result.errorFamily === "quota_exhausted") {
        // recordAgyCall ya bloqueó toda la bolsa; el paso se reintenta en otra (sin gastar un reintento).
        await db.update(schema.runs).set({ status: "failed", errorMessage: result.errorMessage, errorFamily: result.errorFamily, result: result.stdout, finishedAt: new Date().toISOString() }).where(eq(schema.runs.id, runId));
        await db.update(schema.tasks).set({ status: "failed", updatedAt: new Date().toISOString() }).where(eq(schema.tasks.id, taskId));
        quotaPools.add(lease.pool);
        lastQuotaLabel = lease.label;
        broadcast({ type: "plan:log", planId, stepId, stream: "stdout", data: `\n[orquestador] sin cuota en la bolsa "${lease.pool}" (${lease.label}); probando otra cuenta...\n`, timestamp: new Date().toISOString() } as any);
        attempt--;
        continue;
      }

      const succeeded = result.exitCode === 0 && !result.timedOut;
      const isSilentRateLimit = step.adapter === "claude" && result.exitCode === 1 && !(result.stderr ?? "").trim();
      const isTransient = TRANSIENT_RE.test((result.errorMessage ?? "") + result.stderr) || isSilentRateLimit;
      const isUnknownSession = UNKNOWN_SESSION_RE.test(result.stderr + (result.errorMessage ?? ""));

      // Update the run record
      await db.update(schema.runs)
        .set({
          status: succeeded ? "succeeded" : "failed",
          result: result.stdout,
          summary: result.summary,
          sessionId: result.sessionId,
          exitCode: result.exitCode,
          costUsd: result.costUsd,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          errorMessage: result.errorMessage,
          errorFamily: result.errorFamily,
          retryNotBefore: result.retryNotBefore,
          model: result.model,
          finishedAt: new Date().toISOString(),
        })
        .where(eq(schema.runs.id, runId));

      await db.update(schema.tasks)
        .set({ status: succeeded ? "succeeded" : "failed", updatedAt: new Date().toISOString() })
        .where(eq(schema.tasks.id, taskId));

      // F11: un paso con rol debe cerrar con su estado final; bloqueado, necesita o sin estado → failed sin reintento.
      const finalStatus = succeeded && step.role ? parseStepStatus(result.summary || result.stdout) : null;
      if (succeeded && step.role && finalStatus?.kind !== "terminado") {
        const statusDetail = finalStatus ? (finalStatus.detalle ?? "(sin detalle)") : "sin estado final";
        const msg = finalStatus ? `${finalStatus.kind}: ${statusDetail}` : statusDetail;
        await db.update(schema.planSteps)
          .set({ status: "failed", result: result.summary || result.stdout.slice(0, 4000), errorMessage: msg, statusDetail, finishedAt: new Date().toISOString() })
          .where(eq(schema.planSteps.id, stepId));
        broadcast({ type: "plan:step", planId, stepId, status: "failed", adapter: step.adapter, error: msg, timestamp: new Date().toISOString() } as any);
        return { status: "failed", tokensUsed };
      }

      let statusDetail = finalStatus?.detalle ?? null;
      if (succeeded && gitBefore) {
        const after = await gitSnapshot(cwd);
        const outside = after ? changedOutside(gitBefore, after) : [];
        if (outside.length) {
          const warn = `AVISO: el paso de salidas tocó archivos fuera de su carpeta: ${outside.slice(0, 10).join(", ")}${outside.length > 10 ? ` y ${outside.length - 10} más` : ""}`;
          planLog("stderr", `\n[orquestador] ${warn}\n`);
          statusDetail = statusDetail ? `${statusDetail} — ${warn}` : warn;
        }
      }

      if (succeeded) {
        await db.update(schema.planSteps)
          .set({
            status: "succeeded",
            statusDetail,
            runId,
            result: result.summary || result.stdout.slice(0, 4000),
            costUsd: result.costUsd,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            sessionId: result.sessionId,
            finishedAt: new Date().toISOString(),
          })
          .where(eq(schema.planSteps.id, stepId));

        broadcast({ type: "plan:step", planId, stepId, status: "succeeded", adapter: step.adapter, timestamp: new Date().toISOString() } as any);
        return { status: "succeeded", tokensUsed };
      }

      lastError = result.errorMessage ?? `Exit code ${result.exitCode}`;

      // Unknown session: retry without --resume
      if (isUnknownSession && sessionId) {
        log.warn({ stepId, attempt }, "Unknown session, retrying without --resume");
        sessionId = undefined;
        attempt--;
        continue;
      }

      // Claude rate-limit: rotate to next profile if it has an API key configured
      if (isTransient && step.adapter === "claude" && claudeProfile) {
        claudeProfileManager.markRateLimited(claudeProfile.id, result.retryNotBefore);
        const next = claudeProfileManager.getNextProfile(claudeProfile.id);
        if (next && claudeProfileManager.getEnvForProfile(next.id).ANTHROPIC_API_KEY) {
          log.info({ stepId, from: claudeProfile.id, to: next.id }, "Claude rate-limited in plan step, switching profile");
          broadcast({ type: "plan:log", planId, stepId, stream: "stdout", data: `\n[orquestador] rate-limit en ${claudeProfile.label}, cambiando a ${next.label}...\n`, timestamp: new Date().toISOString() } as any);
          claudeProfile = next;
          claudeProfileEnv = claudeProfileManager.getEnvForProfile(next.id);
          continue;
        }
      }

      // Transient error: respect retryNotBefore
      if (isTransient && result.retryNotBefore) {
        const waitMs = Math.max(0, new Date(result.retryNotBefore).getTime() - Date.now());
        if (waitMs > 0 && waitMs < 120_000) {
          log.info({ stepId, waitMs }, "Transient error, waiting retryNotBefore");
          await new Promise((r) => setTimeout(r, waitMs));
        }
        continue;
      }

      if (!isTransient) break;

    } catch (err: any) {
      lastError = err.message;
      if (lease && err instanceof WorkerUnavailableError) {
        // El trabajador no tomó el paso: no es fallo del paso, se prueba otra cuenta.
        downAccounts.add(lease.accountId);
        // Sin respuesta, 401 o 5xx = caído (60 s, para todos). 409 = ocupado. Otro 4xx (400/413) es del paso:
        // se salta esa cuenta solo aquí, sin run fallido; si ninguna lo toma, el paso falla una vez con este error.
        const down = err.status === undefined || err.status === 401 || err.status >= 500;
        if (!down) {
          if (err.status === 409 && lease.worker) markWorkerBusy(lease.worker.id);
          await db.update(schema.planSteps).set({ runId: prevRunId }).where(eq(schema.planSteps.id, stepId));
          linkedRunId = prevRunId;
          await db.delete(schema.runs).where(eq(schema.runs.id, runId));
          await db.delete(schema.tasks).where(eq(schema.tasks.id, taskId));
        } else {
          if (lease.worker) markWorkerHealth(lease.worker.id, false);
          await db.update(schema.runs).set({ status: "failed", errorMessage: err.message, errorFamily: "worker_unavailable", finishedAt: new Date().toISOString() }).where(eq(schema.runs.id, runId));
          await db.update(schema.tasks).set({ status: "failed", updatedAt: new Date().toISOString() }).where(eq(schema.tasks.id, taskId));
        }
        broadcast({ type: "plan:log", planId, stepId, stream: "stderr", data: `\n[orquestador] ${err.message}; probando otra cuenta...\n`, timestamp: new Date().toISOString() } as any);
        attempt--;
        continue;
      }
      log.error({ err, stepId, attempt }, "Step execution threw");
    } finally {
      lease?.release();
    }
  }

  // All retries exhausted
  await db.update(schema.planSteps)
    .set({
      status: "failed",
      errorMessage: lastError,
      finishedAt: new Date().toISOString(),
    })
    .where(eq(schema.planSteps.id, stepId));

  broadcast({ type: "plan:step", planId, stepId, status: "failed", adapter: step.adapter, error: lastError, timestamp: new Date().toISOString() } as any);
  return { status: "failed", tokensUsed };
}

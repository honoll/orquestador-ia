import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "../db/index.js";
import { getAdapter } from "../adapters/registry.js";
import { broadcast } from "./ws.js";
import { claudeProfileManager } from "../adapters/claude/profile-manager.js";
import { recordAgyCall, NoActiveAccountError } from "./agy-accounts.js";
import { acquireAgy, agyAvailability, markWorkerHealth, type AgyLease } from "./agy-workers.js";
import { WorkerUnavailableError } from "../adapters/agy/worker-client.js";
import pino from "pino";

const log = pino({ name: "plan-runner" });

const TRANSIENT_RE = /429|503|529|overloaded|rate.limit|capacity|too many requests|rate limit de claude/i;
const UNKNOWN_SESSION_RE = /unknown session|session.*not found|invalid.*session/i;
const MAX_RETRIES = 2;
export const QUOTA_PAUSE_PREFIX = "Pausado por cuota";

export type StepOutcomeStatus = "succeeded" | "failed" | "paused_quota";
export interface StepOutcome { status: StepOutcomeStatus; tokensUsed: number }

export interface StepRunOptions {
  planId: string;
  stepId: string;
  cwd: string;
  /** Reemplaza el prompt guardado del paso (p. ej. con contexto de pasos previos) */
  promptOverride?: string;
  /** Kill handle set externally to allow cancellation */
  onKillRegistered?: (kill: () => void) => void;
}

/** No quedó cuenta de agy para el paso: cancelado, sin cuentas, todas las bolsas sin cuota (pausa) o trabajadores caídos. */
async function agyNoAccount(o: { planId: string; stepId: string; aborted: boolean; lastQuotaLabel: string | null; lastError: string | null; tokensUsed: number }): Promise<StepOutcome> {
  const { planId, stepId, tokensUsed } = o;
  if (o.aborted) return { status: "failed", tokensUsed }; // cancelado mientras esperaba: el planificador lo marca cancelled
  const avail = await agyAvailability();
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

/** Execute a single plan step with retry logic. Solo ejecuta: no toca el estado del plan. */
export async function runPlanStep(options: StepRunOptions): Promise<StepOutcome> {
  const { planId, stepId, cwd } = options;

  const stepRows = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId));
  if (stepRows.length === 0) throw new Error(`Step ${stepId} not found`);
  const step = stepRows[0];
  const prompt = options.promptOverride ?? step.prompt;

  const adapter = getAdapter(step.adapter);
  if (!adapter) throw new Error(`Unknown adapter: ${step.adapter}`);

  await db.update(schema.planSteps)
    .set({ status: "running", startedAt: new Date().toISOString(), errorMessage: null })
    .where(eq(schema.planSteps.id, stepId));

  broadcast({ type: "plan:step", planId, stepId, status: "running", adapter: step.adapter, timestamp: new Date().toISOString() } as any);

  // agy (F10): cada intento toma una cuenta (local o trabajador). Cuota → se excluye su bolsa; trabajador caído →
  // se excluye la cuenta; ninguna cuenta ni intento cuenta como reintento.
  const isAgy = step.adapter === "agy";
  const quotaPools = new Set<string>();
  const downAccounts = new Set<string>();
  const waitAbort = new AbortController();
  if (isAgy) options.onKillRegistered?.(() => waitAbort.abort());
  let lastQuotaLabel: string | null = null;

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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Retry delay for transient errors
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }

    let lease: AgyLease | null = null;
    if (isAgy) {
      lease = await acquireAgy({ pools: quotaPools, accounts: downAccounts }, waitAbort.signal);
      if (!lease) return agyNoAccount({ planId, stepId, aborted: waitAbort.signal.aborted, lastQuotaLabel, lastError, tokensUsed });
    }

    const runId = randomUUID();

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

      if (succeeded) {
        await db.update(schema.planSteps)
          .set({
            status: "succeeded",
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
        if (lease.worker) markWorkerHealth(lease.worker.id, false);
        downAccounts.add(lease.accountId);
        await db.update(schema.runs).set({ status: "failed", errorMessage: err.message, errorFamily: "worker_unavailable", finishedAt: new Date().toISOString() }).where(eq(schema.runs.id, runId));
        await db.update(schema.tasks).set({ status: "failed", updatedAt: new Date().toISOString() }).where(eq(schema.tasks.id, taskId));
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

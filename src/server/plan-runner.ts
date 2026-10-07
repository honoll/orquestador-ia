import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "../db/index.js";
import { getAdapter } from "../adapters/registry.js";
import { broadcast } from "./ws.js";
import { claudeProfileManager } from "../adapters/claude/profile-manager.js";
import { getActiveAccount, recordAgyCall, NoActiveAccountError } from "./agy-accounts.js";
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

  broadcast({ type: "plan:step", planId, stepId, status: "running", timestamp: new Date().toISOString() } as any);

  const agyAccount = step.adapter === "agy" ? await getActiveAccount() : null;
  if (step.adapter === "agy" && !agyAccount) {
    const msg = new NoActiveAccountError().message;
    await db.update(schema.planSteps).set({ status: "failed", errorMessage: msg, finishedAt: new Date().toISOString() }).where(eq(schema.planSteps.id, stepId));
    broadcast({ type: "plan:step", planId, stepId, status: "failed", error: msg, timestamp: new Date().toISOString() } as any);
    return { status: "failed", tokensUsed: 0 };
  }

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

    const runId = randomUUID();

    // Create a task + run record for traceability
    const taskId = randomUUID();
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

      if (agyAccount) {
        try { await recordAgyCall(agyAccount.id, result, "plan", Date.now(), callStartedAt); } catch (err) { log.error({ err, stepId }, "No se pudo registrar el consumo de agy"); }
      }

      if (step.adapter === "agy" && result.errorFamily === "quota_exhausted") {
        const msg = `${QUOTA_PAUSE_PREFIX} en la cuenta "${agyAccount?.label ?? "?"}": cambia de cuenta en el panel y vuelve a ejecutar el plan.`;
        await db.update(schema.runs).set({ status: "failed", errorMessage: result.errorMessage, errorFamily: result.errorFamily, result: result.stdout, finishedAt: new Date().toISOString() }).where(eq(schema.runs.id, runId));
        await db.update(schema.tasks).set({ status: "failed", updatedAt: new Date().toISOString() }).where(eq(schema.tasks.id, taskId));
        await db.update(schema.planSteps).set({ status: "pending", errorMessage: msg, runId }).where(eq(schema.planSteps.id, stepId));
        broadcast({ type: "plan:step", planId, stepId, status: "pending", error: msg, timestamp: new Date().toISOString() } as any);
        return { status: "paused_quota", tokensUsed };
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

        broadcast({ type: "plan:step", planId, stepId, status: "succeeded", timestamp: new Date().toISOString() } as any);
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
      log.error({ err, stepId, attempt }, "Step execution threw");
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

  broadcast({ type: "plan:step", planId, stepId, status: "failed", error: lastError, timestamp: new Date().toISOString() } as any);
  return { status: "failed", tokensUsed };
}

import { eq, and, asc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "../db/index.js";
import { getAdapter } from "../adapters/registry.js";
import { broadcast } from "./ws.js";
import { claudeProfileManager } from "../adapters/claude/profile-manager.js";
import { startWatch, stopWatch } from "./file-watcher.js";
import pino from "pino";

const log = pino({ name: "plan-runner" });

const TRANSIENT_RE = /429|503|529|overloaded|rate.limit|capacity|too many requests|rate limit de claude/i;
const UNKNOWN_SESSION_RE = /unknown session|session.*not found|invalid.*session/i;
const MAX_RETRIES = 2;

export interface StepRunOptions {
  planId: string;
  stepId: string;
  cwd: string;
  /** Kill handle set externally to allow cancellation */
  onKillRegistered?: (kill: () => void) => void;
}

/** Execute a single plan step with retry logic. Returns the stepId. */
export async function runPlanStep(options: StepRunOptions): Promise<void> {
  const { planId, stepId, cwd } = options;

  const stepRows = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId));
  if (stepRows.length === 0) throw new Error(`Step ${stepId} not found`);
  const step = stepRows[0];

  const adapter = getAdapter(step.adapter);
  if (!adapter) throw new Error(`Unknown adapter: ${step.adapter}`);

  await db.update(schema.planSteps)
    .set({ status: "running", startedAt: new Date().toISOString() })
    .where(eq(schema.planSteps.id, stepId));

  await db.update(schema.plans)
    .set({ status: "running", updatedAt: new Date().toISOString() })
    .where(eq(schema.plans.id, planId));

  broadcast({ type: "plan:step", planId, stepId, status: "running", timestamp: new Date().toISOString() } as any);

  let sessionId = step.sessionId ?? undefined;
  let lastError: string | null = null;
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
      prompt: step.prompt,
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
      prompt: step.prompt,
      cwd,
    });

    try {
      const result = await adapter.execute({
        runId,
        prompt: step.prompt,
        model: step.model ?? undefined,
        cwd,
        sessionId,
        timeoutSec: 1800,
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
        return;
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
}

/** Execute all pending steps of a plan sequentially */
export async function runPlanAll(planId: string, cwd: string): Promise<void> {
  // Start watching the project directory for live file preview
  startWatch(planId, cwd);

  const steps = await db.select().from(schema.planSteps)
    .where(and(eq(schema.planSteps.planId, planId), eq(schema.planSteps.status, "pending")))
    .orderBy(asc(schema.planSteps.stepIndex));

  for (const step of steps) {
    await runPlanStep({ planId, stepId: step.id, cwd });

    // Re-fetch to check if it failed
    const updated = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, step.id)).then((r) => r[0]);
    if (updated?.status === "failed") {
      stopWatch(planId);
      await db.update(schema.plans)
        .set({ status: "failed", updatedAt: new Date().toISOString() })
        .where(eq(schema.plans.id, planId));
      broadcast({ type: "plan:done", planId, status: "failed", timestamp: new Date().toISOString() } as any);
      return;
    }
  }

  // Check if all steps are done
  const allSteps = await db.select().from(schema.planSteps).where(eq(schema.planSteps.planId, planId));
  const allDone = allSteps.every((s) => ["succeeded", "skipped", "cancelled"].includes(s.status));

  const finalStatus = allDone ? "completed" : "failed";
  stopWatch(planId);
  await db.update(schema.plans)
    .set({ status: finalStatus, updatedAt: new Date().toISOString() })
    .where(eq(schema.plans.id, planId));

  broadcast({ type: "plan:done", planId, status: finalStatus, timestamp: new Date().toISOString() } as any);
}

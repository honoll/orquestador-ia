import { randomUUID } from "node:crypto";
import { eq, and, ne, asc, desc } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { getAdapter } from "../adapters/registry.js";
import { broadcast } from "./ws.js";
import { claudeProfileManager } from "../adapters/claude/profile-manager.js";
import type { AdapterExecutionResult } from "../lib/types.js";
import pino from "pino";
import fs from "node:fs";

import { cavemanFlagFile, findCavemanSkill } from "../lib/caveman.js";
const HOME = process.env.HOME || process.env.USERPROFILE || "";
const log = pino({ name: "runner" });

// Active kill functions keyed by runId
const activeKills = new Map<string, () => void>();

export function cancelRun(runId: string): boolean {
  const kill = activeKills.get(runId);
  if (!kill) return false;
  kill();
  return true;
}

// Max previous turns to inject as context (user+assistant pairs)
const MAX_HISTORY_TURNS = 20;

// Default timeout per adapter (seconds). Prevents agentic loops from hanging forever.
const DEFAULT_TIMEOUT: Record<string, number> = {
  claude: 300,  // 5 min — Claude headless is reliable
  codex: 180,   // 3 min
  gemini: 120,  // 2 min — Gemini can loop with tool errors
  agy: 600,
};

const RATE_LIMIT_RE = /429|503|529|overloaded|rate.limit|capacity|too many requests/i;

export interface RunTaskInput {
  taskId: string;
  adapter: string;
  prompt: string;
  model?: string;
  cwd: string;
  sessionId?: string;
  timeoutSec?: number;
  env?: Record<string, string>;
}

/**
 * Builds a conversation history prefix to inject into the prompt when
 * an adapter doesn't have a native session to resume (cross-adapter or first run).
 * Returns "" if there's no history or the adapter already has a sessionId.
 */
async function buildHistoryPrefix(taskId: string, sessionId: string | undefined): Promise<string> {
  // If the adapter already has a session to resume, it has its own context — skip injection
  if (sessionId) return "";

  const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).then((r) => r[0]);
  if (!task?.conversationId) return "";

  // Fetch previous tasks in the same conversation, oldest first, excluding current task
  const prevTasks = await db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.conversationId, task.conversationId),
        ne(schema.tasks.id, taskId),
      ),
    )
    .orderBy(asc(schema.tasks.createdAt))
    .limit(MAX_HISTORY_TURNS);

  if (prevTasks.length === 0) return "";

  const lines: string[] = [
    "The following is the conversation history so far. Use it as context for your response.",
    "",
  ];

  for (const pt of prevTasks) {
    lines.push(`User: ${pt.prompt}`);

    // Get the latest successful run for this task
    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, pt.id))
      .orderBy(desc(schema.runs.startedAt))
      .limit(1);

    const run = runs[0];
    if (run?.summary) {
      lines.push(`Assistant: ${run.summary}`);
    } else {
      lines.push("Assistant: (no response)");
    }
    lines.push("");
  }

  lines.push("Now respond to the following message:");
  lines.push("");

  return lines.join("\n");
}

async function buildCavemanPrefix(): Promise<string> {
  try {
    if (!fs.existsSync(cavemanFlagFile(HOME))) return "";
    const skillPath = findCavemanSkill(HOME);
    if (!skillPath) return "";
    const skillMd = fs.readFileSync(skillPath, "utf-8");
    return skillMd.trim() + "\n\n";
  } catch {
    return "";
  }
}

export async function runTask(input: RunTaskInput): Promise<string> {
  const adapter = getAdapter(input.adapter);
  if (!adapter) throw new Error(`Unknown adapter: ${input.adapter}`);

  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    taskId: input.taskId,
    adapter: input.adapter,
    model: input.model ?? null,
    status: "running",
    prompt: input.prompt,
    cwd: input.cwd,
    timeoutSec: input.timeoutSec ?? null,
  });

  await db.update(schema.tasks)
    .set({ status: "running", updatedAt: new Date().toISOString() })
    .where(eq(schema.tasks.id, input.taskId));

  broadcast({
    type: "run:status",
    runId,
    status: "running",
    timestamp: new Date().toISOString(),
  });

  executeInBackground(runId, input, adapter);

  return runId;
}

async function executeInBackground(
  runId: string,
  input: RunTaskInput,
  adapter: { execute: (ctx: any) => Promise<AdapterExecutionResult> },
) {
  let result: AdapterExecutionResult;
  try {
    const historyPrefix = await buildHistoryPrefix(input.taskId, input.sessionId);
    const cavemanPrefix = await buildCavemanPrefix();
    const effectivePrompt = cavemanPrefix + (historyPrefix ? historyPrefix + input.prompt : input.prompt);
    const timeoutSec = input.timeoutSec ?? DEFAULT_TIMEOUT[input.adapter] ?? 180;

    // For Claude: pick best available profile (failover on rate-limit requires API keys)
    const claudeProfile = input.adapter === "claude"
      ? claudeProfileManager.getBestProfile()
      : null;
    const claudeProfileEnv = claudeProfile
      ? claudeProfileManager.getEnvForProfile(claudeProfile.id)
      : undefined;

    const makeCtx = (profileEnv?: Record<string, string>) => ({
      runId,
      prompt: effectivePrompt,
      model: input.model,
      cwd: input.cwd,
      sessionId: input.sessionId,
      timeoutSec,
      env: input.env,
      claudeProfileEnv: profileEnv,
      onLog: (stream: "stdout" | "stderr", chunk: string) => {
        broadcast({ type: "log", runId, stream, data: chunk, timestamp: new Date().toISOString() });
      },
      onKill: (kill: () => void) => { activeKills.set(runId, kill); },
    });

    result = await adapter.execute(makeCtx(claudeProfileEnv));

    // Claude: if rate-limited and has multiple profiles with API keys, rotate and retry
    if (
      input.adapter === "claude" &&
      claudeProfile &&
      result.exitCode !== 0 &&
      RATE_LIMIT_RE.test((result.errorMessage ?? "") + result.stderr)
    ) {
      claudeProfileManager.markRateLimited(claudeProfile.id, result.retryNotBefore);
      const next = claudeProfileManager.getNextProfile(claudeProfile.id);
      if (next && claudeProfileManager.getEnvForProfile(next.id).ANTHROPIC_API_KEY) {
        log.info({ from: claudeProfile.id, to: next.id }, "Claude rate-limited, retrying with next profile");
        broadcast({ type: "log", runId, stream: "stdout", data: `\n[orquestador] rate-limit en ${claudeProfile.label}, reintentando con ${next.label}...\n`, timestamp: new Date().toISOString() });
        result = await adapter.execute(makeCtx(claudeProfileManager.getEnvForProfile(next.id)));
        if (result.exitCode === 0) claudeProfileManager.clearRateLimit(claudeProfile.id);
      }
    }
  } catch (err: any) {
    activeKills.delete(runId);
    log.error({ err, runId }, "Adapter execution error");
    result = {
      exitCode: -1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: err.message || "Unknown error",
      summary: "",
      sessionId: null,
      model: null,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      errorMessage: err.message || "Unknown error",
      errorFamily: "internal",
      retryNotBefore: null,
    };
  }

  const status = result.timedOut
    ? "timed_out"
    : result.exitCode === 0
      ? "succeeded"
      : "failed";

  const taskStatus = status === "succeeded" ? "succeeded" : "failed";

  activeKills.delete(runId);

  await db.update(schema.runs)
    .set({
      status,
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
    .set({ status: taskStatus, updatedAt: new Date().toISOString() })
    .where(eq(schema.tasks.id, input.taskId));

  broadcast({
    type: "run:status",
    runId,
    status,
    result,
    timestamp: new Date().toISOString(),
  });
}

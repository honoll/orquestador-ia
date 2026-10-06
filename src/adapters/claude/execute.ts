import { runProcess } from "../../lib/process-runner.js";
import { parse } from "./parse.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../../lib/types.js";

export function buildClaudeArgs(model?: string, sessionId?: string, opts: { readOnly?: boolean } = {}): string[] {
  const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
  // readOnly: sin el flag, en modo print las tools que piden permiso se niegan solas.
  if (!opts.readOnly) args.push("--dangerously-skip-permissions");
  if (model) args.push("--model", model);
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const args = buildClaudeArgs(ctx.model, ctx.sessionId, { readOnly: ctx.readOnly });

  // Multi-account: merge profile API key into env (overrides default auth)
  const env = ctx.claudeProfileEnv
    ? { ...ctx.env, ...ctx.claudeProfileEnv }
    : ctx.env;

  const { promise, kill } = runProcess({
    command: "claude",
    args,
    cwd: ctx.cwd,
    stdin: ctx.prompt,
    timeoutSec: ctx.timeoutSec,
    graceSec: ctx.graceSec,
    env,
    onStdout: (chunk) => ctx.onLog("stdout", chunk),
    onStderr: (chunk) => ctx.onLog("stderr", chunk),
  });
  ctx.onKill?.(kill);

  const proc = await promise;
  return parse(proc);
}

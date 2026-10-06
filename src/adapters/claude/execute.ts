import { runProcess } from "../../lib/process-runner.js";
import { parse } from "./parse.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../../lib/types.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const args = [
    "--print", "-",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];

  if (ctx.model) args.push("--model", ctx.model);
  if (ctx.sessionId) args.push("--resume", ctx.sessionId);

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

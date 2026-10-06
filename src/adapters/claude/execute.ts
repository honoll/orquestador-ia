import { runProcess } from "../../lib/process-runner.js";
import { parse } from "./parse.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../../lib/types.js";

/** Tools que la síntesis (readOnly) no puede usar: escriben, ejecutan o salen a la red. */
export const READ_ONLY_DISALLOWED_TOOLS = "Bash Edit Write NotebookEdit WebFetch WebSearch";

export function buildClaudeArgs(model?: string, sessionId?: string, opts: { readOnly?: boolean } = {}): string[] {
  const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
  if (opts.readOnly) {
    // Sin --dangerously-skip-permissions las tools que piden permiso se niegan solas en modo print; además se
    // niegan explícitamente (claude --help: lista separada por espacios o comas) y no se carga ningún MCP.
    args.push("--disallowedTools", READ_ONLY_DISALLOWED_TOOLS, "--strict-mcp-config");
  } else {
    args.push("--dangerously-skip-permissions");
  }
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

import { runProcess } from "../../lib/process-runner.js";
import { parse } from "./parse.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../../lib/types.js";

/**
 * codex exec [OPTIONS] [PROMPT]
 * - "-" como prompt: codex lo lee de stdin (evita problemas de escape en la shell).
 * - --json: eventos JSONL por stdout. -m: modelo.
 * - --full-auto: aprueba solo + sandbox con escritura (sin esto codex solo lee).
 * - readOnly: --sandbox read-only (verificado en `codex exec --help`: read-only | workspace-write | danger-full-access).
 */
export function buildCodexArgs(model?: string, opts: { readOnly?: boolean } = {}): string[] {
  const args = ["exec", "--json", ...(opts.readOnly ? ["--sandbox", "read-only"] : ["--full-auto"]), "--skip-git-repo-check"];
  if (model) args.push("-m", model);
  args.push("-");
  return args;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const args = buildCodexArgs(ctx.model, { readOnly: ctx.readOnly });

  const { promise, kill } = runProcess({
    command: "codex",
    args,
    cwd: ctx.cwd,
    stdin: ctx.prompt,
    timeoutSec: ctx.timeoutSec,
    graceSec: ctx.graceSec,
    env: ctx.env,
    onStdout: (chunk) => ctx.onLog("stdout", chunk),
    onStderr: (chunk) => ctx.onLog("stderr", chunk),
  });
  ctx.onKill?.(kill);

  const proc = await promise;
  return parse(proc);
}

import { runProcess } from "../../lib/process-runner.js";
import { resolveAgyPath } from "../../lib/agy-path.js";
import { parse } from "./parse.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../../lib/types.js";

export function buildAgyArgs(model?: string, conversationId?: string, opts: { readOnly?: boolean } = {}): string[] {
  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--print=", // vacío y pegado: el prompt llega por stdin (ver spike)
  ];
  if (!opts.readOnly) args.push("--dangerously-skip-permissions");
  if (model) args.push("--model", model);
  if (conversationId) args.push("--conversation", conversationId);
  return args;
}

export function buildAgyStdin(prompt: string): string {
  return JSON.stringify({ event: "user", message: { content: prompt } }) + "\n";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const exe = resolveAgyPath();
  if (!exe) {
    return parse({
      exitCode: -1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "agy no encontrado: instala Antigravity CLI o define AGY_PATH",
    });
  }

  // shell:false — agy.exe es nativo; nada del prompt pasa por cmd.exe.
  const { promise, kill } = runProcess({
    command: exe,
    args: buildAgyArgs(ctx.model, ctx.sessionId, { readOnly: ctx.readOnly }),
    cwd: ctx.cwd,
    stdin: buildAgyStdin(ctx.prompt),
    shell: false,
    timeoutSec: ctx.timeoutSec,
    graceSec: ctx.graceSec,
    env: ctx.env,
    onStdout: (chunk) => ctx.onLog("stdout", chunk),
    onStderr: (chunk) => ctx.onLog("stderr", chunk),
  });
  ctx.onKill?.(kill);

  return parse(await promise);
}

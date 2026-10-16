import { runProcess } from "../../lib/process-runner.js";
import { resolveAgyPath } from "../../lib/agy-path.js";
import { parse } from "./parse.js";
import { runOnWorker, MAX_WORKER_TIMEOUT_SEC } from "./worker-client.js";
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

/** Al trabajador solo viajan las variables del modo equipo: worker.mjs rechaza cualquier otra. */
function orqEnv(env?: Record<string, string>): Record<string, string> | undefined {
  const out = Object.fromEntries(Object.entries(env ?? {}).filter(([k]) => k === "ORQ_API" || k === "ORQ_TAREA" || k === "ORQ_TOKEN"));
  return Object.keys(out).length ? out : undefined;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  if (ctx.agyWorker) {
    // Otra cuenta (otro usuario de Windows): mismo NDJSON, mismo parse. WorkerUnavailableError sube al llamador.
    const { promise, kill } = runOnWorker(ctx.agyWorker, {
      prompt: ctx.prompt,
      cwd: ctx.cwd,
      model: ctx.model,
      readOnly: ctx.readOnly === true,
      timeoutSec: Math.min(ctx.timeoutSec ?? MAX_WORKER_TIMEOUT_SEC, MAX_WORKER_TIMEOUT_SEC),
      env: orqEnv(ctx.env),
      sessionId: ctx.sessionId,
    }, { onLog: ctx.onLog, graceSec: ctx.graceSec });
    ctx.onKill?.(kill);
    return parse(await promise);
  }

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

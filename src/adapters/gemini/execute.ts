import { runProcess } from "../../lib/process-runner.js";
import { parse } from "./parse.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../../lib/types.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  // gemini -p/--prompt <text> : non-interactive (headless) mode
  // -m/--model <model>
  // -y / --yolo : auto-approve all actions (equivalent to --dangerously-skip-permissions)
  // -o/--output-format stream-json : JSONL streaming output
  const args = [
    "--prompt", ctx.prompt,
    "--output-format", "stream-json",
    "-y",
  ];

  if (ctx.model) args.push("--model", ctx.model);
  if (ctx.sessionId) args.push("--resume", ctx.sessionId);

  const { promise, kill } = runProcess({
    command: "gemini",
    args,
    cwd: ctx.cwd,
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

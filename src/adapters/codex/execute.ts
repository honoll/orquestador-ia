import { runProcess } from "../../lib/process-runner.js";
import { parse } from "./parse.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../../lib/types.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  // codex exec [OPTIONS] [PROMPT]
  // Use "-" as prompt placeholder so codex reads from stdin (avoids shell escaping issues)
  // --json prints events as JSONL to stdout
  // -m / --model sets model
  // --full-auto: auto-approves actions + writable sandbox (without this, codex runs in read-only sandbox
  //   and can only read files — it won't create or edit anything)
  const args = ["exec", "--json", "--full-auto", "--skip-git-repo-check"];

  if (ctx.model) args.push("-m", ctx.model);

  // Pass "-" to tell codex to read prompt from stdin
  args.push("-");

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

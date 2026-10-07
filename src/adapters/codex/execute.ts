import { runProcess } from "../../lib/process-runner.js";
import { parse } from "./parse.js";
import { MODEL_CATALOG } from "../../config/models.js";
import { codexProfile } from "../../lib/worker-profile.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../../lib/types.js";

/**
 * codex exec [OPTIONS] [PROMPT]
 * - "-" como prompt: codex lo lee de stdin (evita problemas de escape en la shell).
 * - --json: eventos JSONL por stdout. -m: modelo.
 * - Escritor: --sandbox workspace-write + approval_policy never. NO usar --full-auto: está deprecado y, con
 *   --ignore-user-config, dejaba al escritor en solo lectura. En Windows además windows.sandbox elevated.
 * - Los valores de -c usan literales TOML con comillas simples ('never'): sin comillas dobles que cmd.exe/quoteWindowsArg puedan alterar.
 * - readOnly: --sandbox read-only (verificado en `codex exec --help`: read-only | workspace-write | danger-full-access).
 * - Aislamiento (F3a): --ignore-user-config + --disable de funciones que inflan el contexto (spike: 17.3k -> 10.7k tokens base).
 */
export const CODEX_DISABLED_FEATURES: readonly string[] = ["plugins", "apps", "hooks", "browser_use", "computer_use", "image_generation", "skill_search", "multi_agent", "goals", "tool_suggest", "personality"];

export function buildCodexArgs(model?: string, opts: { readOnly?: boolean; platform?: NodeJS.Platform } = {}): string[] {
  const platform = opts.platform ?? process.platform;
  const sandbox = opts.readOnly
    ? ["--sandbox", "read-only", "-c", "approval_policy='never'"]
    : ["--sandbox", "workspace-write", "-c", "approval_policy='never'", ...(platform === "win32" ? ["-c", "windows.sandbox='elevated'"] : [])];
  const args = ["exec", "--json", ...sandbox, "--skip-git-repo-check", "--ignore-user-config", ...CODEX_DISABLED_FEATURES.flatMap((f) => ["--disable", f])];
  if (model) args.push("-m", model);
  args.push("-");
  return args;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const args = buildCodexArgs(ctx.model || MODEL_CATALOG.codex.defaultModel, { readOnly: ctx.readOnly });
  const isolationEnv = await codexProfile.envForWorker();

  const { promise, kill } = runProcess({
    command: "codex",
    args,
    cwd: ctx.cwd,
    stdin: ctx.prompt,
    timeoutSec: ctx.timeoutSec,
    graceSec: ctx.graceSec,
    env: { ...ctx.env, ...isolationEnv },
    onStdout: (chunk) => ctx.onLog("stdout", chunk),
    onStderr: (chunk) => ctx.onLog("stderr", chunk),
  });
  ctx.onKill?.(kill);

  const proc = await promise;
  return parse(proc);
}

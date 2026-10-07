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

/**
 * Modos del sandbox:
 * - readOnly: --sandbox read-only.
 * - escritor con perfil de trabajador (CODEX_HOME propio): --sandbox danger-full-access. Paridad con los escritores de
 *   claude/agy (--dangerously-skip-permissions); la protección viene de la guardia F4 y del cwd del proyecto. Motivo: la
 *   virtualización MSIX de AppData rompe la preparación del sandbox elevado de Windows para un segundo CODEX_HOME.
 * - escritor sin perfil: --sandbox workspace-write (+ windows.sandbox elevated en Windows).
 */
export function buildCodexArgs(model?: string, opts: { readOnly?: boolean; platform?: NodeJS.Platform; workerProfile?: boolean } = {}): string[] {
  const platform = opts.platform ?? process.platform;
  const never = ["-c", "approval_policy='never'"];
  const sandbox = opts.readOnly
    ? ["--sandbox", "read-only", ...never]
    : opts.workerProfile
      ? ["--sandbox", "danger-full-access", ...never]
      : ["--sandbox", "workspace-write", ...never, ...(platform === "win32" ? ["-c", "windows.sandbox='elevated'"] : [])];
  const args = ["exec", "--json", ...sandbox, "--skip-git-repo-check", "--ignore-user-config", ...CODEX_DISABLED_FEATURES.flatMap((f) => ["--disable", f])];
  if (model) args.push("-m", model);
  args.push("-");
  return args;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const isolationEnv = await codexProfile.envForWorker();
  const args = buildCodexArgs(ctx.model || MODEL_CATALOG.codex.defaultModel, { readOnly: ctx.readOnly, workerProfile: "CODEX_HOME" in isolationEnv });

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

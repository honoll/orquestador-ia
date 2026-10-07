import os from "node:os";
import { runProcess } from "../lib/process-runner.js";

export interface RunnerResult {
  exitCode: number | null;
  stderr: string;
}

export type Runner = (
  command: string,
  args: string[],
  opts?: { stdin?: string; timeoutSec?: number },
) => Promise<RunnerResult>;

/** Ejecuta un .exe nativo sin shell y con el entorno sin secretos del orquestador. */
export const defaultRunner: Runner = async (command, args, opts = {}) => {
  const { promise } = runProcess({
    command,
    args,
    cwd: os.tmpdir(),
    shell: false,
    stdin: opts.stdin,
    timeoutSec: opts.timeoutSec ?? 60,
  });
  const r = await promise;
  return { exitCode: r.timedOut ? -1 : r.exitCode, stderr: r.stderr };
};

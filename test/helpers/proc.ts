import type { RunProcessResult } from "../../src/lib/process-runner.js";

export function makeProc(partial: Partial<RunProcessResult> = {}): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    ...partial,
  };
}

export const jsonl = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join("\n");

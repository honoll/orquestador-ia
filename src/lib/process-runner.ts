import { spawn, type ChildProcess } from "node:child_process";

/**
 * Quotes a single argument for cmd.exe (Windows shell).
 * Without this, spawn() with shell:true joins args with spaces and any arg
 * containing spaces gets split into separate tokens — breaking --flag "value with spaces".
 */
export function quoteWindowsArg(arg: string): string {
  if (arg.length === 0) return '""';
  // No quoting needed for simple args with no shell-special chars
  if (!/[\s"&|<>^%!();,]/.test(arg)) return arg;
  // Escape runs of backslashes that precede a quote or end-of-string, then wrap in "..."
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
}

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: string;
  /** default: true en Windows (para .cmd). Usar false para .exe nativos como agy. */
  shell?: boolean;
  timeoutSec?: number;
  graceSec?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export function runProcess(options: RunProcessOptions): { promise: Promise<RunProcessResult>; kill: () => void } {
  const {
    command,
    args,
    cwd,
    env,
    stdin,
    shell,
    timeoutSec = 0,
    graceSec = 20,
    onStdout,
    onStderr,
  } = options;

  let child: ChildProcess;
  let timedOut = false;
  let killed = false;

  const mergedEnv = { ...process.env, ...env } as NodeJS.ProcessEnv;

  const promise = new Promise<RunProcessResult>((resolve) => {
    // On Windows, shell:true is required to run .CMD/.BAT files (codex.CMD, gemini.CMD).
    // But when shell:true, Node joins args with spaces without quoting, so any arg with
    // spaces (like a prompt) gets split into tokens. Fix: build the quoted command string
    // ourselves and pass it as the sole argument so cmd.exe receives it verbatim.
    const useShell = shell ?? process.platform === "win32";
    const spawnCommand = useShell
      ? [command, ...args.map(quoteWindowsArg)].join(" ")
      : command;
    const spawnArgs = useShell ? [] : args;

    child = spawn(spawnCommand, spawnArgs, {
      cwd,
      env: mergedEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: useShell,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
    });

    if (stdin && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let graceHandle: ReturnType<typeof setTimeout> | null = null;

    if (timeoutSec > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        graceHandle = setTimeout(() => {
          child.kill("SIGKILL");
        }, graceSec * 1000);
      }, timeoutSec * 1000);
    }

    child.on("close", (code, signal) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (graceHandle) clearTimeout(graceHandle);
      resolve({
        exitCode: code,
        signal: signal?.toString() ?? null,
        timedOut,
        stdout,
        stderr,
      });
    });

    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (graceHandle) clearTimeout(graceHandle);
      resolve({
        exitCode: -1,
        signal: null,
        timedOut: false,
        stdout,
        stderr: stderr + "\n" + err.message,
      });
    });
  });

  const kill = () => {
    if (!killed) {
      killed = true;
      child?.kill("SIGTERM");
      setTimeout(() => child?.kill("SIGKILL"), graceSec * 1000);
    }
  };

  return { promise, kill };
}

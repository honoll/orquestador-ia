import { spawn } from "node:child_process";
import { withoutOrchestratorSecrets } from "./process-runner.js";

/** Comando para abrir una consola visible con `codex login` del perfil de trabajadores. */
export function buildCodexLoginCommand(): { command: string; args: string[] } {
  return { command: "cmd.exe", args: ["/c", 'start "Codex - perfil de trabajadores" cmd /k codex login'] };
}

/** `home` sale de codexWorkerHome(), nunca de datos del usuario. */
export function openCodexLoginTerminal(home: string): void {
  if (process.platform !== "win32") throw new Error("Abrir la terminal de Codex solo está implementado en Windows");
  const { command, args } = buildCodexLoginCommand();
  spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: { ...withoutOrchestratorSecrets(process.env), CODEX_HOME: home },
    windowsVerbatimArguments: true,
  }).unref();
}

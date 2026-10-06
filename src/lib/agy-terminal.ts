import { spawn } from "node:child_process";

/** Comando para abrir una consola visible con agy interactivo (login/logout oficial). */
export function buildTerminalCommand(exe: string): { command: string; args: string[] } {
  return { command: "cmd.exe", args: ["/c", `start "Antigravity - cambiar cuenta" "${exe}"`] };
}

/** `exe` sale de resolveAgyPath(), nunca de datos del usuario. */
export function openAgyTerminal(exe: string): void {
  if (process.platform !== "win32") throw new Error("Abrir la terminal de agy solo está implementado en Windows");
  const { command, args } = buildTerminalCommand(exe);
  spawn(command, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
}

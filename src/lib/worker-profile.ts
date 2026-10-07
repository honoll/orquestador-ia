import fs from "node:fs";
import path from "node:path";
import { runProcess } from "./process-runner.js";

/**
 * Perfil de trabajador de Codex (F3a): CODEX_HOME propio del orquestador, sin el AGENTS.md global ni las skills del
 * usuario. Tiene su propia sesión (el usuario la inicia con `codex login`); aquí solo se consulta `codex login status`.
 * Nunca se leen ni copian credenciales.
 */
export const CODEX_STATUS_TTL_MS = 60_000;

export function orchestratorDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORQUESTADOR_DATA_DIR || path.join(env.USERPROFILE || env.HOME || ".", ".orquestador-ia");
}

export function codexWorkerHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = path.join(orchestratorDataRoot(env), "workers", "codex");
  fs.mkdirSync(home, { recursive: true });
  return home;
}

export type LoginChecker = (codexHome: string) => Promise<boolean>;

export const checkCodexLogin: LoginChecker = async (codexHome) => {
  // runProcess mezcla process.env con este env y quita los secretos del orquestador.
  const { promise } = runProcess({
    command: "codex",
    args: ["login", "status"],
    cwd: codexHome,
    env: { CODEX_HOME: codexHome },
    timeoutSec: 20,
  });
  const r = await promise;
  return r.exitCode === 0;
};

export function createCodexProfile(opts: { checker?: LoginChecker; now?: () => number; env?: NodeJS.ProcessEnv } = {}) {
  const checker = opts.checker ?? checkCodexLogin;
  const now = opts.now ?? Date.now;
  let cache: { at: number; loggedIn: boolean } | null = null;

  async function status(): Promise<{ home: string; loggedIn: boolean }> {
    const home = codexWorkerHome(opts.env);
    if (!cache || now() - cache.at > CODEX_STATUS_TTL_MS) {
      let loggedIn = false;
      try { loggedIn = await checker(home); } catch { loggedIn = false; }
      cache = { at: now(), loggedIn };
    }
    return { home, loggedIn: cache.loggedIn };
  }

  return {
    status,
    async envForWorker(): Promise<Record<string, string>> {
      const s = await status();
      return s.loggedIn ? { CODEX_HOME: s.home } : {};
    },
    invalidate() { cache = null; },
  };
}

export const codexProfile = createCodexProfile();

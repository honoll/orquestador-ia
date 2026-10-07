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

/** Ruta del perfil; intenta crearla pero nunca lanza (disco de solo lectura, ruta inválida...). */
export function codexWorkerHome(env: NodeJS.ProcessEnv = process.env): string {
  return ensureCodexWorkerHome(env).home;
}

function ensureCodexWorkerHome(env: NodeJS.ProcessEnv): { home: string; ok: boolean } {
  const home = path.join(orchestratorDataRoot(env), "workers", "codex");
  try {
    fs.mkdirSync(home, { recursive: true });
    return { home, ok: true };
  } catch {
    return { home, ok: false };
  }
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
  let inflight: Promise<boolean> | null = null;
  let generation = 0;

  async function status(): Promise<{ home: string; loggedIn: boolean }> {
    const { home, ok } = ensureCodexWorkerHome(opts.env ?? process.env);
    if (!ok) return { home, loggedIn: false };
    if (!cache || now() - cache.at > CODEX_STATUS_TTL_MS) {
      // Una sola consulta en curso: las llamadas simultáneas con caché frío la comparten.
      if (!inflight) {
        const gen = generation;
        const p = (async () => {
          let loggedIn = false;
          try { loggedIn = await checker(home); } catch { loggedIn = false; }
          // Si invalidate() ocurrió durante la consulta, no se guarda un resultado ya obsoleto.
          if (gen === generation) cache = { at: now(), loggedIn };
          return loggedIn;
        })();
        inflight = p;
        void p.finally(() => { if (inflight === p) inflight = null; });
      }
      return { home, loggedIn: await inflight };
    }
    return { home, loggedIn: cache.loggedIn };
  }

  return {
    status,
    async envForWorker(): Promise<Record<string, string>> {
      const s = await status();
      return s.loggedIn ? { CODEX_HOME: s.home } : {};
    },
    invalidate() { cache = null; inflight = null; generation++; },
  };
}

export const codexProfile = createCodexProfile();

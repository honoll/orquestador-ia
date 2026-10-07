import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { orchestratorDataRoot } from "../lib/worker-profile.js";
import { withoutOrchestratorSecrets } from "../lib/process-runner.js";

/**
 * Audio ducking (F5): baja el volumen de las demás apps mientras el usuario graba (mic) o Piper lee (speak) y lo
 * restaura después. Usa un helper de larga vida con Core Audio por sesión: un .exe compilado una sola vez desde
 * scripts/voice/DuckHelper.cs (Add-Type, ver build-duck-helper.ps1) y lanzado con detached:true. No es un script
 * PowerShell porque libuv mete a los hijos no-detached en un job object con KILL_ON_JOB_CLOSE: si node muere de
 * golpe, el helper moriría antes de restaurar. Detached sobrevive, ve el EOF de stdin y restaura.
 */
export type DuckReason = "mic" | "speak";
export const DUCK_REASONS: readonly DuckReason[] = ["mic", "speak"];
export const DEFAULT_LEASE_MS = 45_000;
export const DEFAULT_DUCK_LEVEL = 0.2;
const REQUEST_TIMEOUT_MS = 10_000;

/** Lista cerrada: solo estos nombres de proceso llegan jamás al helper. */
export const BROWSER_ALLOWLIST = ["firefox", "chrome", "msedge", "brave", "opera", "claude"] as const;

export function browserProcessNames(userAgent: string | undefined | null): string[] {
  const ua = userAgent ?? "";
  if (/Firefox\//i.test(ua)) return ["firefox"];
  if (/Edg\//.test(ua)) return ["msedge"];
  if (/OPR\//.test(ua)) return ["opera"];
  if (/Electron/i.test(ua) || /Claude/.test(ua)) return ["claude"];
  if (/Chrome\//.test(ua)) return ["chrome", "brave"];
  return [...BROWSER_ALLOWLIST];
}

export function duckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VOICE_DUCK !== "0";
}

export function duckLevel(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VOICE_DUCK_LEVEL;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DUCK_LEVEL;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DUCK_LEVEL;
  return Math.min(1, Math.max(0, n));
}

export interface HelperProc {
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: () => void): void;
  /** Cierra stdin (el helper restaura y termina). */
  close(): void;
  kill(): void;
}

export interface DuckEntry {
  pid: number;
  name: string;
  id?: string;
  saved: number;
  ducked: number;
}

export interface DuckerDeps {
  platform?: NodeJS.Platform;
  /** Lanza el helper (recibe la ruta del exe ya compilado). */
  spawnHelper?: (exePath: string) => HelperProc;
  /** Garantiza que el exe exista y devuelve su ruta; lanza si no puede compilarse. Los tests lo inyectan. */
  ensureExe?: () => Promise<string>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  fs?: {
    write(p: string, data: string): void;
    read(p: string): string | null;
    remove(p: string): void;
  };
  statePath?: string;
  level?: () => number;
  enabled?: () => boolean;
  leaseMs?: number;
  log?: (msg: string, extra?: unknown) => void;
}

export interface DuckStatus {
  supported: boolean;
  active: DuckReason[];
  /** Presente si el helper no pudo compilarse/lanzarse (el ducking queda desactivado, nada más falla). */
  error?: string;
}

interface HelperReply {
  ok?: boolean;
  ready?: boolean;
  error?: string;
  active?: DuckEntry[];
}

const HELPER_SOURCE = path.resolve(import.meta.dirname, "../../scripts/voice/DuckHelper.cs");
const BUILD_SCRIPT = path.resolve(import.meta.dirname, "../../scripts/voice/build-duck-helper.ps1");
const BUILD_TIMEOUT_MS = 120_000;

let exeBuild: Promise<string> | null = null;

/** Compila (una vez por proceso y por contenido del .cs) el exe del helper en <data dir>/voice/. Las llamadas concurrentes comparten la compilación. */
export function ensureHelperExe(): Promise<string> {
  exeBuild ??= buildHelperExe();
  return exeBuild;
}

async function buildHelperExe(): Promise<string> {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(HELPER_SOURCE)).digest("hex").slice(0, 12);
  const exe = path.join(orchestratorDataRoot(), "voice", `duck-helper-${hash}.exe`);
  if (fs.existsSync(exe)) return exe;
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", BUILD_SCRIPT, "-Source", HELPER_SOURCE, "-Out", exe],
      { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: withoutOrchestratorSecrets(process.env) },
    );
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      err = (err + d).slice(-500);
    });
    const timer = setTimeout(() => child.kill(), BUILD_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`compilación del helper falló (código ${code}): ${err.trim()}`));
    });
  });
  if (!fs.existsSync(exe)) throw new Error("compilación del helper no produjo el exe");
  return exe;
}

function realSpawnHelper(exePath: string): HelperProc {
  // detached: en Windows saca al hijo del job object (KILL_ON_JOB_CLOSE) de node; así, si node muere de golpe, el
  // helper ve el EOF de stdin y restaura los volúmenes. Sin unref(): seguimos leyendo su stdout.
  const child = spawn(exePath, [], {
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
    env: withoutOrchestratorSecrets(process.env),
  });
  let buf = "";
  const lineCbs: Array<(l: string) => void> = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (l) lineCbs.forEach((cb) => cb(l));
    }
  });
  child.stdin.on("error", () => {
    /* helper muerto: onExit lo gestiona */
  });
  return {
    send: (line) => {
      child.stdin.write(line + "\n");
    },
    onLine: (cb) => {
      lineCbs.push(cb);
    },
    onExit: (cb) => {
      child.on("exit", cb);
      child.on("error", cb);
    },
    close: () => {
      try {
        child.stdin.end();
      } catch {
        /* ya cerrado */
      }
    },
    kill: () => {
      try {
        child.kill();
      } catch {
        /* ya muerto */
      }
    },
  };
}

export function createDucker(deps: DuckerDeps = {}) {
  const platform = deps.platform ?? process.platform;
  const supported = platform === "win32";
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const spawnHelper = deps.spawnHelper ?? realSpawnHelper;
  const ensureExe = deps.ensureExe ?? (deps.spawnHelper ? async () => "" : ensureHelperExe);
  let setupError: string | null = null;
  const level = deps.level ?? (() => duckLevel());
  const enabled = deps.enabled ?? (() => duckEnabled());
  const log = deps.log ?? (() => {});
  const statePath = deps.statePath ?? path.join(orchestratorDataRoot(), "voice-duck.json");
  const store = deps.fs ?? {
    write: (p: string, d: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, d);
    },
    read: (p: string) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    remove: (p: string) => {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* nada */
      }
    },
  };

  const leases = new Map<DuckReason, { expires: number; timer: unknown }>();
  let speakExclude: string[] = [];
  let helper: HelperProc | null = null;
  let helperAlive = false;
  let pending: { resolve: (r: HelperReply | null) => void; timer: unknown } | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let lastEntries: DuckEntry[] = [];

  function failPending() {
    if (!pending) return;
    clearTimer(pending.timer);
    const p = pending;
    pending = null;
    p.resolve(null);
  }

  async function ensureHelper(): Promise<HelperProc | null> {
    if (helper && helperAlive) return helper;
    try {
      const exe = await ensureExe();
      if (helper && helperAlive) return helper;
      const h = spawnHelper(exe);
      setupError = null;
      helper = h;
      helperAlive = true;
      h.onLine((line) => {
        let msg: HelperReply;
        try {
          msg = JSON.parse(line) as HelperReply;
        } catch {
          return;
        }
        if (msg.ready || !pending) return;
        clearTimer(pending.timer);
        const p = pending;
        pending = null;
        p.resolve(msg);
      });
      h.onExit(() => {
        if (helper === h) {
          helperAlive = false;
          helper = null;
        }
        failPending();
      });
      return h;
    } catch (err) {
      helperAlive = false;
      helper = null;
      setupError = String((err as Error)?.message ?? err);
      log("duck: no se pudo lanzar el helper", setupError);
      return null;
    }
  }

  function request(payload: object): Promise<HelperReply | null> {
    const run = async (): Promise<HelperReply | null> => {
      const h = await ensureHelper();
      if (!h) return null;
      return new Promise<HelperReply | null>((resolve) => {
        const timer = setTimer(() => {
          if (pending) {
            pending = null;
            resolve(null);
          }
        }, REQUEST_TIMEOUT_MS);
        pending = { resolve, timer };
        try {
          h.send(JSON.stringify(payload));
        } catch {
          failPending();
        }
      });
    };
    const p = chain.then(run, run);
    chain = p.catch(() => null);
    return p;
  }

  function persist(entries: DuckEntry[]) {
    lastEntries = entries;
    try {
      if (entries.length === 0) store.remove(statePath);
      else store.write(statePath, JSON.stringify({ entries }));
    } catch (err) {
      log("duck: no se pudo guardar el estado", String((err as Error)?.message ?? err));
    }
  }

  function activeReasons(): DuckReason[] {
    return DUCK_REASONS.filter((r) => leases.has(r));
  }

  function status(): DuckStatus {
    return setupError ? { supported, active: activeReasons(), error: setupError } : { supported, active: activeReasons() };
  }

  /** Aplica el estado deseado según los motivos activos. Nunca lanza. */
  async function sync(): Promise<void> {
    try {
      if (activeReasons().length === 0) {
        // Sin helper vivo y sin nada ducked no hay nada que restaurar (no se lanza powershell en vano).
        if (!helperAlive && lastEntries.length === 0) return;
        const r = await request({ cmd: "restore" });
        if (r?.ok) persist([]);
        return;
      }
      const exclude = leases.has("mic") ? [] : speakExclude;
      const r = await request({ cmd: "apply", level: level(), exclude });
      if (r?.ok && Array.isArray(r.active)) persist(r.active);
      else log("duck: apply falló", r?.error);
    } catch (err) {
      log("duck: sync falló", String((err as Error)?.message ?? err));
    }
  }

  function dropLease(reason: DuckReason) {
    const l = leases.get(reason);
    if (l) clearTimer(l.timer);
    leases.delete(reason);
  }

  async function acquire(reason: DuckReason, browserNames: string[] = []): Promise<DuckStatus> {
    if (!supported || !enabled()) return { supported: false, active: [] };
    dropLease(reason);
    const timer = setTimer(() => {
      void release(reason);
    }, leaseMs);
    leases.set(reason, { expires: now() + leaseMs, timer });
    if (reason === "speak") {
      const allowed = new Set<string>(BROWSER_ALLOWLIST);
      speakExclude = browserNames.filter((n) => allowed.has(n));
    }
    await sync();
    return status();
  }

  async function release(reason: DuckReason): Promise<DuckStatus> {
    if (!supported) return { supported: false, active: [] };
    dropLease(reason);
    await sync();
    return status();
  }

  /** Restaura todo y suelta los motivos. */
  async function restoreAll(): Promise<void> {
    for (const r of DUCK_REASONS) dropLease(r);
    if (!supported) return;
    await sync();
  }

  /** Arranque del servidor: si quedó estado de una sesión anterior, restaura esas sesiones y borra el archivo. */
  async function recover(): Promise<void> {
    if (!supported) return;
    try {
      const raw = store.read(statePath);
      if (raw === null) return;
      let entries: DuckEntry[] = [];
      try {
        const parsed = JSON.parse(raw) as { entries?: unknown };
        if (Array.isArray(parsed.entries)) {
          entries = parsed.entries.filter((e): e is DuckEntry => {
            const x = e as Partial<DuckEntry> | null;
            return (
              !!x &&
              typeof x === "object" &&
              Number.isInteger(x.pid) &&
              typeof x.name === "string" &&
              typeof x.saved === "number" &&
              typeof x.ducked === "number"
            );
          });
        }
      } catch {
        /* archivo corrupto: solo se borra */
      }
      if (entries.length > 0) await request({ cmd: "restore", entries });
      store.remove(statePath);
      lastEntries = [];
    } catch (err) {
      log("duck: recuperación falló", String((err as Error)?.message ?? err));
    }
  }

  /** Salida síncrona (exit/señales): cierra stdin; el helper restaura al ver EOF. Si muere antes, el archivo basta. */
  function closeHelper() {
    for (const r of DUCK_REASONS) dropLease(r);
    if (helper) {
      try {
        helper.close();
      } catch {
        /* nada */
      }
    }
    helper = null;
    helperAlive = false;
  }

  return { acquire, release, restoreAll, recover, closeHelper, status, supported: () => supported };
}

export type Ducker = ReturnType<typeof createDucker>;

let shared: Ducker | null = null;
/** Instancia compartida, creada de forma perezosa (la config se lee al usarla, no al importar). */
export function getDucker(): Ducker {
  return (shared ??= createDucker());
}

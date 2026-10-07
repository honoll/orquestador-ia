import { spawn } from "node:child_process";
import fs from "node:fs";
import { withoutOrchestratorSecrets } from "../lib/process-runner.js";
import { voiceConfig, type VoiceConfig } from "./config.js";

export type WhisperState = "stopped" | "starting" | "warming" | "ready" | "failed";

export interface WhisperDeps {
  spawnServer(args: string[]): { kill(): void; onExit(cb: () => void): void };
  fetchImpl: typeof fetch;
  wait(ms: number): Promise<void>;
  /** Existencia de exe/modelo; por defecto fs.existsSync. */
  exists?(p: string): boolean;
}

const HEALTH_POLL_MS = 500;
const HEALTH_MAX_POLLS = 120; // 60 s
const INFERENCE_TIMEOUT_MS = 120_000;

export function buildWhisperServerArgs(cfg: Pick<VoiceConfig, "whisperModel" | "whisperPort">): string[] {
  return ["-m", cfg.whisperModel, "--host", "127.0.0.1", "--port", String(cfg.whisperPort), "-l", "es"];
}

/** 1 s de silencio, WAV 16 kHz mono PCM s16, en memoria. */
export function silentWav(seconds = 1): Buffer {
  const samples = 16000 * seconds;
  const dataLen = samples * 2;
  const b = Buffer.alloc(44 + dataLen);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + dataLen, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(dataLen, 40);
  return b;
}

function defaultDeps(getCfg: () => VoiceConfig): WhisperDeps {
  return {
    spawnServer(args) {
      const child = spawn(getCfg().whisperExe, args, {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
        env: withoutOrchestratorSecrets(process.env),
      });
      let exitCb: (() => void) | null = null;
      let exited = false;
      const fire = () => {
        if (exited) return;
        exited = true;
        exitCb?.();
      };
      child.on("exit", fire);
      child.on("error", fire);
      return {
        kill: () => {
          try { child.kill(); } catch { /* ya terminó */ }
        },
        onExit: (cb) => {
          exitCb = cb;
          if (exited) cb();
        },
      };
    },
    fetchImpl: (...a) => fetch(...a),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** La página de whisper-server (GET /) es un formulario que apunta a /inference. */
export function isWhisperServerPage(body: string): boolean {
  return /whisper/i.test(body) && body.includes("/inference");
}

/**
 * `cfg` puede ser una función: se evalúa en cada uso (no al importar), así el `.env` que
 * index.ts carga después de los imports sí aplica.
 */
export function createWhisper(cfg: VoiceConfig | (() => VoiceConfig) = voiceConfig, deps?: WhisperDeps) {
  const getCfg = typeof cfg === "function" ? cfg : () => cfg;
  const d = deps ?? defaultDeps(getCfg);
  const exists = d.exists ?? ((p: string) => fs.existsSync(p));
  let lastError: string | null = null;
  let state: WhisperState = "stopped";
  let proc: { kill(): void } | null = null;
  let startPromise: Promise<boolean> | null = null;
  let generation = 0;

  async function post(wav: Buffer): Promise<string | null> {
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
      form.append("response_format", "json");
      form.append("language", "es");
      const res = await d.fetchImpl(`http://127.0.0.1:${getCfg().whisperPort}/inference`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { text?: unknown };
      return typeof json.text === "string" ? json.text.trim() : null;
    } catch {
      return null;
    }
  }

  /** "ours": responde la página de whisper-server; "foreign": responde otra cosa; "down": nadie. */
  async function probe(): Promise<"ours" | "foreign" | "down"> {
    try {
      const res = await d.fetchImpl(`http://127.0.0.1:${getCfg().whisperPort}/`, { signal: AbortSignal.timeout(2000) });
      const body = (await res.text()).slice(0, 8192);
      return isWhisperServerPage(body) ? "ours" : "foreign";
    } catch {
      return "down";
    }
  }

  function foreignPort(): boolean {
    lastError = `El puerto ${getCfg().whisperPort} está ocupado por otro servicio que no es whisper-server (cambia WHISPER_PORT o libéralo)`;
    state = "failed";
    return false;
  }

  function warmUp(gen: number): void {
    state = "warming";
    // Calentamiento en segundo plano: la primera inferencia compila (JIT) y tarda ~40 s.
    void post(silentWav(1)).finally(() => {
      if (gen === generation && state === "warming") state = "ready";
    });
  }

  async function start(): Promise<boolean> {
    const c = getCfg();
    lastError = null;
    if (!exists(c.whisperExe) || !exists(c.whisperModel)) {
      lastError = "Faltan whisper-server.exe o el modelo";
      state = "failed";
      return false;
    }
    const gen = ++generation;
    state = "starting";
    // Antes de lanzar nada: ¿ya hay alguien en el puerto? (p. ej. un whisper-server huérfano de
    // una ejecución anterior que Windows no dejó apagar). Si es genuino se ADOPTA (sin proc:
    // stop() no lo mata); si es otra cosa, error claro en vez de lanzar procesos que mueren.
    const pre = await probe();
    if (gen !== generation) return false;
    if (pre === "foreign") return foreignPort();
    if (pre === "ours") {
      warmUp(gen);
      return true;
    }
    let exited = false;
    let child: ReturnType<WhisperDeps["spawnServer"]>;
    try {
      child = d.spawnServer(buildWhisperServerArgs(c));
    } catch {
      lastError = "No se pudo lanzar whisper-server";
      state = "failed";
      return false;
    }
    proc = child;
    child.onExit(() => {
      exited = true;
      if (gen === generation) {
        state = "stopped";
        proc = null;
      }
    });
    for (let i = 0; i < HEALTH_MAX_POLLS; i++) {
      if (exited || gen !== generation) return false;
      const p = await probe();
      if (p === "ours") {
        if (exited || gen !== generation) return false;
        warmUp(gen);
        return true;
      }
      if (p === "foreign") {
        if (gen === generation) {
          try { child.kill(); } catch { /* nada */ }
          proc = null;
          return foreignPort();
        }
        return false;
      }
      await d.wait(HEALTH_POLL_MS);
    }
    if (gen === generation) {
      lastError = "whisper-server no respondió a tiempo";
      state = "failed";
      try { child.kill(); } catch { /* nada */ }
      proc = null;
    }
    return false;
  }

  function ensureStarted(): Promise<boolean> {
    if (state === "ready" || state === "warming") return Promise.resolve(true);
    if (startPromise) return startPromise;
    startPromise = start()
      .catch(() => {
        state = "failed";
        return false;
      })
      .finally(() => {
        startPromise = null;
      });
    return startPromise;
  }

  return {
    ensureStarted,
    async transcribe(wav16k: Buffer): Promise<string | null> {
      try {
        if (!(await ensureStarted())) return null;
        return await post(wav16k);
      } catch {
        return null;
      }
    },
    status: (): WhisperState => state,
    lastError: (): string | null => lastError,
    stop(): void {
      generation++;
      startPromise = null;
      const p = proc;
      proc = null;
      state = "stopped";
      try { p?.kill(); } catch { /* nada */ }
    },
  };
}

export const whisper = createWhisper();

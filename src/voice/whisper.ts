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

function defaultDeps(cfg: VoiceConfig): WhisperDeps {
  return {
    spawnServer(args) {
      const child = spawn(cfg.whisperExe, args, {
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

export function createWhisper(cfg: VoiceConfig = voiceConfig(), deps: WhisperDeps = defaultDeps(cfg)) {
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const base = `http://127.0.0.1:${cfg.whisperPort}`;
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
      const res = await deps.fetchImpl(`${base}/inference`, {
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

  async function healthy(): Promise<boolean> {
    try {
      await deps.fetchImpl(`${base}/`, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      return false;
    }
  }

  async function start(): Promise<boolean> {
    if (!exists(cfg.whisperExe) || !exists(cfg.whisperModel)) {
      state = "failed";
      return false;
    }
    const gen = ++generation;
    state = "starting";
    let exited = false;
    let child: ReturnType<WhisperDeps["spawnServer"]>;
    try {
      child = deps.spawnServer(buildWhisperServerArgs(cfg));
    } catch {
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
      if (await healthy()) {
        if (exited || gen !== generation) return false;
        state = "warming";
        // Calentamiento en segundo plano: la primera inferencia compila (JIT) y tarda ~40 s.
        void post(silentWav(1)).finally(() => {
          if (gen === generation && state === "warming") state = "ready";
        });
        return true;
      }
      await deps.wait(HEALTH_POLL_MS);
    }
    if (gen === generation) {
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
    stop(): void {
      generation++;
      const p = proc;
      proc = null;
      state = "stopped";
      try { p?.kill(); } catch { /* nada */ }
    },
  };
}

export const whisper = createWhisper();

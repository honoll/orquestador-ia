import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgyPath } from "../../lib/agy-path.js";
import { buildAgyArgs, buildAgyStdin } from "../../adapters/agy/execute.js";
import { withoutOrchestratorSecrets } from "../../lib/process-runner.js";
import { QUOTA_RE, extractResetAt } from "../../adapters/agy/parse.js";
import { AGY_VOICE_MODEL } from "../../config/models.js";

export type AgyTurnResult = {
  ok: boolean;
  text: string;
  error?: string;
  quota: boolean;
  retryNotBefore: string | null;
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
};

export type AgyProc = {
  stdin: { write(s: string): void; end(): void };
  onLine(cb: (l: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
};

const STALLED = "agy dejó de responder";
const CLOSED = "sesión cerrada";

/**
 * Argumentos del agy de voz: plática de solo lectura. Además de no auto-aprobar permisos, desactiva la
 * expansión de slash commands/skills y corre con las restricciones de terminal (--sandbox). Solo para voz.
 */
export function buildVoiceAgyArgs(): string[] {
  return [...buildAgyArgs(AGY_VOICE_MODEL, undefined, { readOnly: true }), "--disable-slash-commands", "--sandbox"];
}
const DEFAULT_TURN_TIMEOUT_MS = 60_000;
const CLOSE_GRACE_MS = 2000;

/** Parte chunks arbitrarios en líneas completas (por \n, tolera \r). */
export function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      onLine(line);
    }
  };
}

/** Spawn real: agy en solo lectura, cwd temporal vacío, sin secretos del orquestador, shell:false. */
function defaultSpawn(): AgyProc | null {
  const exe = resolveAgyPath();
  if (!exe) return null;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orq-voz-"));
  const cleanup = () => fs.rm(cwd, { recursive: true, force: true }, () => {});
  let child;
  try {
    child = nodeSpawn(exe, buildVoiceAgyArgs(), {
      cwd,
      shell: false,
      windowsHide: true,
      env: withoutOrchestratorSecrets(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    cleanup();
    throw e;
  }
  child.stdout.setEncoding("utf8");
  child.stderr.resume();
  child.stdin.on("error", () => {});
  let exitCb: (code: number | null) => void = () => {};
  let exited = false;
  const done = (code: number | null) => {
    if (exited) return;
    exited = true;
    cleanup();
    exitCb(code);
  };
  child.on("error", () => done(null));
  child.on("close", (code) => done(code));
  return {
    stdin: { write: (s) => void child.stdin.write(s), end: () => void child.stdin.end() },
    onLine: (cb) => child.stdout.on("data", createLineSplitter(cb)),
    onExit: (cb) => {
      exitCb = cb;
    },
    kill: () => {
      try {
        child.kill();
      } catch {
        /* ya murió */
      }
    },
  };
}

type Turn = {
  onDelta: (d: string) => void;
  deltas: string[];
  startedAt: number;
  finish: (r: AgyTurnResult) => void;
};

export function createAgySession(deps: { spawn?: () => AgyProc | null; now?: () => number; turnTimeoutMs?: number } = {}) {
  const spawn = deps.spawn ?? defaultSpawn;
  const now = deps.now ?? Date.now;
  const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

  let proc: AgyProc | null = null;
  let turn: Turn | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  // Una vez cerrada, la sesión nunca relanza agy (ni para turnos que ya estaban en cola).
  let closed = false;

  const fail = (error: string, startedAt: number): AgyTurnResult => ({
    ok: false, text: "", error, quota: false, retryNotBefore: null, inputTokens: 0, outputTokens: 0, startedAt,
  });

  function ensureProc(): AgyProc | null {
    if (proc) return proc;
    const p = spawn();
    if (!p) return null;
    proc = p;
    p.onLine((line) => {
      if (proc === p) handleLine(line);
    });
    p.onExit(() => {
      if (proc !== p) return;
      proc = null;
      const t = turn;
      if (t) t.finish(fail(STALLED, t.startedAt));
    });
    return p;
  }

  function handleLine(raw: string) {
    const t = turn;
    if (!t) return;
    const line = raw.trim();
    if (!line) return;
    let evt: {
      event?: string;
      step_update?: { step_type?: string; text_delta?: string };
      result?: { status?: string; response?: string; error?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    };
    try {
      evt = JSON.parse(line);
    } catch {
      return;
    }
    if (!evt || typeof evt !== "object") return;
    if (evt.event === "step_update" && evt.step_update?.step_type === "agent_response" && evt.step_update.text_delta) {
      t.deltas.push(evt.step_update.text_delta);
      try {
        t.onDelta(evt.step_update.text_delta);
      } catch {
        /* un callback con fallo no debe tumbar el turno */
      }
    } else if (evt.event === "result" && evt.result) {
      const r = evt.result;
      const isOk = r.status === "SUCCESS";
      const error = isOk ? undefined : r.error || r.response || `agy terminó con estado ${r.status ?? "desconocido"}`;
      const quota = !isOk && QUOTA_RE.test(error ?? "");
      t.finish({
        ok: isOk,
        text: isOk ? (r.response ? r.response : t.deltas.join("")) : "",
        ...(error !== undefined ? { error } : {}),
        quota,
        retryNotBefore: quota ? extractResetAt(error ?? "", now()) : null,
        inputTokens: r.usage?.input_tokens ?? 0,
        outputTokens: r.usage?.output_tokens ?? 0,
        startedAt: t.startedAt,
      });
    }
  }

  function runTurn(text: string, onDelta: (d: string) => void): Promise<AgyTurnResult> {
    const startedAt = now();
    if (closed) return Promise.resolve(fail(CLOSED, startedAt));
    let p: AgyProc | null;
    try {
      p = ensureProc();
    } catch (e) {
      return Promise.resolve(fail(`no se pudo lanzar agy: ${e instanceof Error ? e.message : String(e)}`, startedAt));
    }
    if (!p) return Promise.resolve(fail("agy no encontrado", startedAt));
    const target = p;

    return new Promise<AgyTurnResult>((resolve) => {
      let settled = false;
      const t: Turn = {
        onDelta,
        deltas: [],
        startedAt,
        finish: (r) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (turn === t) turn = null;
          resolve(r);
        },
      };
      turn = t;
      const timer = setTimeout(() => {
        if (proc === target) proc = null;
        try {
          target.kill();
        } catch {
          /* ya murió */
        }
        t.finish(fail(STALLED, startedAt));
      }, turnTimeoutMs);
      try {
        target.stdin.write(buildAgyStdin(text));
      } catch {
        if (proc === target) proc = null;
        try {
          target.kill();
        } catch {
          /* ya murió */
        }
        t.finish(fail(STALLED, startedAt));
      }
    });
  }

  return {
    send(text: string, onDelta: (delta: string) => void): Promise<AgyTurnResult> {
      const next = queue.then(() => runTurn(text, onDelta));
      queue = next.catch(() => undefined);
      return next;
    },
    alive(): boolean {
      return proc !== null;
    },
    close(): void {
      closed = true;
      const p = proc;
      if (!p) return;
      proc = null;
      const t = turn;
      if (t) t.finish(fail(STALLED, t.startedAt));
      try {
        p.stdin.end();
      } catch {
        /* ya cerrado */
      }
      let exited = false;
      p.onExit(() => {
        exited = true;
      });
      const timer = setTimeout(() => {
        if (!exited) p.kill();
      }, CLOSE_GRACE_MS);
      timer.unref?.();
    },
  };
}

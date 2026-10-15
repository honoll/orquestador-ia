/**
 * Cliente HTTP del trabajador agy (scripts/agy-worker/worker.mjs) en 127.0.0.1:<puerto>.
 * Devuelve lo mismo que runProcess (stdout = NDJSON de agy) para que parse() lo trate igual que agy local.
 * La llave se lee del archivo en cada llamada y nunca se registra ni viaja en mensajes de error.
 */
import fs from "node:fs";
import type { RunProcessResult } from "../../lib/process-runner.js";

export interface WorkerTarget {
  port: number;
  keyPath: string;
}

export interface WorkerRunBody {
  prompt: string;
  cwd: string;
  model?: string;
  readOnly: boolean;
  timeoutSec: number;
}

export interface WorkerHealth {
  ok: boolean;
  account: string;
  version: string;
  busy: boolean;
}

/** El trabajador no pudo tomar el paso (apagado, ocupado, llave mala, 5xx…): se prueba otra cuenta. */
export class WorkerUnavailableError extends Error {}

export const MAX_WORKER_TIMEOUT_SEC = 1800;

export function readWorkerKey(keyPath: string): string {
  let key = "";
  try { key = fs.readFileSync(keyPath, "utf8").trim(); } catch { /* se informa abajo sin detalles */ }
  if (!/^[0-9a-f]{64}$/.test(key)) throw new WorkerUnavailableError("llave del trabajador ilegible o inválida");
  return key;
}

const url = (port: number, p: string) => `http://127.0.0.1:${port}${p}`;

function unavailable(port: number, err: unknown): WorkerUnavailableError {
  const cause = (err as { cause?: { code?: string } })?.cause?.code ?? (err as Error)?.message ?? String(err);
  return new WorkerUnavailableError(`trabajador agy en el puerto ${port} no responde (${cause})`);
}

export async function workerHealth(t: WorkerTarget, timeoutMs = 3000): Promise<WorkerHealth> {
  const key = readWorkerKey(t.keyPath);
  let res: Response;
  try {
    res = await fetch(url(t.port, "/health"), { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw unavailable(t.port, err);
  }
  if (res.status !== 200) throw new WorkerUnavailableError(`trabajador agy en el puerto ${t.port} respondió ${res.status}`);
  return (await res.json()) as WorkerHealth;
}

/**
 * POST /run en streaming. Rechaza con WorkerUnavailableError si el trabajador no acepta el paso (sin conexión,
 * respuesta ≠ 200). Una conexión que se corta a media respuesta es un fallo del paso (agy pudo haber escrito).
 * kill() y el tope de tiempo llaman /cancel y cortan la conexión (el trabajador mata el árbol de agy).
 */
export function runOnWorker(
  t: WorkerTarget,
  body: WorkerRunBody,
  opts: { onLog: (stream: "stdout" | "stderr", chunk: string) => void; graceSec?: number },
): { promise: Promise<RunProcessResult>; kill: () => void } {
  const ac = new AbortController();
  let key: string | null = null;
  let killed = false;
  let timedOut = false;

  const kill = () => {
    if (killed) return;
    killed = true;
    if (key) {
      fetch(url(t.port, "/cancel"), { method: "POST", headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) })
        .catch(() => { /* el corte de conexión también lo mata */ });
    }
    ac.abort();
  };

  const promise = (async (): Promise<RunProcessResult> => {
    key = readWorkerKey(t.keyPath);
    // El trabajador aplica timeoutSec; este tope es la red de seguridad si no contesta.
    const timer = setTimeout(() => { timedOut = true; kill(); }, (body.timeoutSec + (opts.graceSec ?? 30)) * 1000);
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let workerTimedOut = false;
    let done = false;
    try {
      let res: Response;
      try {
        res = await fetch(url(t.port, "/run"), {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (err) {
        if (killed) return { exitCode: null, signal: "SIGTERM", timedOut, stdout, stderr };
        throw unavailable(t.port, err);
      }
      if (res.status !== 200 || !res.body) {
        const text = await res.text().catch(() => "");
        let msg = "";
        try { msg = String(JSON.parse(text).error ?? ""); } catch { /* sin cuerpo JSON */ }
        throw new WorkerUnavailableError(`trabajador agy en el puerto ${t.port} respondió ${res.status}${msg ? `: ${msg}` : ""}`);
      }

      const handle = (line: string) => {
        if (!line.trim()) return;
        let evt: { event?: string; data?: unknown; exitCode?: number | null; timedOut?: boolean } | null = null;
        try { evt = JSON.parse(line); } catch { /* línea de agy no JSON: va a stdout como en local */ }
        if (evt?.event === "worker:stderr") {
          const data = String(evt.data ?? "");
          stderr += data;
          opts.onLog("stderr", data);
        } else if (evt?.event === "worker:done") {
          exitCode = typeof evt.exitCode === "number" ? evt.exitCode : -1;
          workerTimedOut = evt.timedOut === true;
          done = true;
        } else {
          stdout += line + "\n";
          opts.onLog("stdout", line + "\n");
        }
      };

      const decoder = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            handle(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
          }
        }
      } catch { /* cancelado o conexión cortada: se resuelve abajo */ }
      handle(buf + decoder.decode());

      if (!done) {
        if (killed) return { exitCode: null, signal: "SIGTERM", timedOut, stdout, stderr };
        stderr += (stderr ? "\n" : "") + "se cortó la conexión con el trabajador agy";
        exitCode = -1;
      }
      return { exitCode, signal: null, timedOut: timedOut || workerTimedOut, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  })();

  return { promise, kill };
}

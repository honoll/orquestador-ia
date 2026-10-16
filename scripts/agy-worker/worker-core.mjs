// Lógica pura del trabajador agy (F10). Sin dependencias: corre con Node fuera del tsx del repo.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_TIMEOUT_SEC = 1800;

// Copia de buildAgyArgs/buildAgyStdin (src/adapters/agy/execute.ts); el test exige paridad.
export function buildAgyArgs(model, conversationId, opts = {}) {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--print="];
  if (!opts.readOnly) args.push("--dangerously-skip-permissions");
  if (model) args.push("--model", model);
  if (conversationId) args.push("--conversation", conversationId);
  return args;
}

export function buildAgyStdin(prompt) {
  return JSON.stringify({ event: "user", message: { content: prompt } }) + "\n";
}

// Espejo de withoutOrchestratorSecrets (src/lib/process-runner.ts).
const SECRET_ENV = new Set(["TYPESAFE_API_KEY"]);
export function withoutSecrets(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (SECRET_ENV.has(k.toUpperCase())) delete out[k];
  return out;
}

/** Compara `Authorization: Bearer <llave>` en tiempo constante (hash previo: no filtra el largo). */
export function checkKey(header, key) {
  if (!key || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const h = (s) => crypto.createHash("sha256").update(s).digest();
  return crypto.timingSafeEqual(h(header.slice(7)), h(key));
}

const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

/** Devuelve la ruta real de `cwd` si existe y queda dentro de `root` (sin `..` ni enlaces fuera); si no, null. */
export function resolveCwd(cwd, root) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  if (cwd.split(/[\\/]/).includes("..")) return null;
  let real, realRoot;
  try {
    real = fs.realpathSync.native(cwd);
    realRoot = fs.realpathSync.native(root);
    if (!fs.statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  const rel = path.relative(norm(realRoot), norm(real));
  if (rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))) return real;
  return null;
}

const RUN_ENV_KEYS = new Set(["ORQ_API", "ORQ_TAREA", "ORQ_TOKEN"]);
const ENV_VALUE_RE = /^[ -~]{0,200}$/; // sin NUL ni controles
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

/** Valida el cuerpo de POST /run. readOnly por defecto true (lo seguro). env solo trae las variables del modo equipo. */
export function parseRunBody(b) {
  if (!b || typeof b !== "object") return null;
  const { prompt, cwd, model, readOnly = true, timeoutSec = MAX_TIMEOUT_SEC, env, sessionId } = b;
  if (typeof prompt !== "string" || !prompt || typeof cwd !== "string") return null;
  if (model !== undefined && typeof model !== "string") return null;
  if (typeof readOnly !== "boolean") return null;
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_TIMEOUT_SEC) return null;
  if (sessionId !== undefined && (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId))) return null;
  if (env !== undefined) {
    if (!env || typeof env !== "object" || Array.isArray(env)) return null;
    for (const [k, v] of Object.entries(env)) if (!RUN_ENV_KEYS.has(k) || typeof v !== "string" || !ENV_VALUE_RE.test(v)) return null;
  }
  return { prompt, cwd, model: model || undefined, readOnly, timeoutSec, ...(env ? { env } : {}), ...(sessionId ? { sessionId } : {}) };
}

export function createBusy() {
  let busy = false;
  return {
    tryAcquire() {
      if (busy) return false;
      busy = true;
      return true;
    },
    release() {
      busy = false;
    },
    get busy() {
      return busy;
    },
  };
}

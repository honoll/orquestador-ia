// Trabajador agy por usuario de Windows (F10). Uso: node worker.mjs --account <cuenta> --port <n>
// Solo escucha en 127.0.0.1; toda petición exige `Authorization: Bearer <llave>` (la llave nunca se imprime).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  buildAgyArgs,
  buildAgyStdin,
  checkKey,
  createBusy,
  parseRunBody,
  resolveCwd,
  withoutSecrets,
} from "./worker-core.mjs";

export const WORKER_VERSION = "1";
const MAX_BODY = 1024 * 1024;
export const WORKERS_DIR = "C:\\ProgramData\\orquestador-ia\\workers";

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (tooBig) return; // se descarta el resto para poder contestar 413
      if (size > MAX_BODY) {
        tooBig = true;
        chunks.length = 0;
        reject(Object.assign(new Error("cuerpo demasiado grande"), { status: 413 }));
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Crea el servidor HTTP del trabajador (sin escuchar). `agyPath`/`agyPrefixArgs` se inyectan en tests
 * para usar un agy falso; en producción es `C:\tools\agy\agy.exe` sin prefijo.
 */
export function createWorker({ account, key, root = "C:\\estudio", agyPath = "C:\\tools\\agy\\agy.exe", agyPrefixArgs = [] }) {
  const busy = createBusy();
  let current = null;

  async function handleRun(req, res) {
    let body;
    try {
      body = parseRunBody(JSON.parse(await readBody(req)));
    } catch (err) {
      if (err.status === 413) res.setHeader("Connection", "close");
      return send(res, err.status ?? 400, { error: err.status ? err.message : "JSON inválido" });
    }
    if (!body) return send(res, 400, { error: "cuerpo inválido: prompt, cwd, model?, readOnly?, timeoutSec? (≤ 1800)" });
    const cwd = resolveCwd(body.cwd, root);
    if (!cwd) return send(res, 400, { error: "cwd inválido: debe existir y estar dentro de " + root });
    if (!busy.tryAcquire()) return send(res, 409, { error: "ocupado: un paso a la vez" });

    // El id liga /cancel a ESTA corrida: un cancel viejo de otro plan no puede matar la siguiente.
    const runId = randomUUID();
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "X-Run-Id": runId });
    const write = (o) => res.write(JSON.stringify(o) + "\n");
    let endsWithNewline = true;
    let timedOut = false;
    let finished = false;

    const child = spawn(agyPath, [...agyPrefixArgs, ...buildAgyArgs(body.model, undefined, { readOnly: body.readOnly })], {
      cwd,
      shell: false,
      windowsHide: true,
      env: withoutSecrets(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    current = { child, runId };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, body.timeoutSec * 1000);

    const finish = (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      current = null;
      busy.release();
      if (!endsWithNewline) res.write("\n");
      write({ event: "worker:done", exitCode, timedOut });
      res.end();
    };

    child.stdout.on("data", (c) => {
      endsWithNewline = c[c.length - 1] === 0x0a;
      res.write(c);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => {
      if (!endsWithNewline) res.write("\n");
      endsWithNewline = true;
      write({ event: "worker:stderr", data });
    });
    child.on("error", (err) => {
      write({ event: "worker:stderr", data: `no se pudo correr agy: ${err.message}` });
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
    // Si el orquestador corta la conexión, no dejar agy huérfano ocupando el trabajador.
    res.on("close", () => {
      if (!finished) killTree(child);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(buildAgyStdin(body.prompt));
  }

  return http.createServer((req, res) => {
    if (!checkKey(req.headers.authorization, key)) return send(res, 401, { error: "no autorizado" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, account, version: WORKER_VERSION, busy: busy.busy });
    }
    if (req.method === "POST" && url.pathname === "/run") {
      handleRun(req, res).catch(() => {
        if (!res.headersSent) send(res, 500, { error: "error interno" });
        else res.end();
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/cancel") {
      // Cuerpo opcional { runId }: sin él mata lo que corra (compatibilidad); con él, solo si coincide.
      readBody(req).then((raw) => {
        let runId;
        try { runId = raw ? JSON.parse(raw).runId : undefined; } catch { /* sin JSON = sin id */ }
        if (!current || (runId !== undefined && runId !== current.runId)) return send(res, 200, { cancelled: false });
        killTree(current.child);
        send(res, 200, { cancelled: true });
      }, (err) => send(res, err.status ?? 400, { error: "cuerpo inválido" }));
      return;
    }
    send(res, 404, { error: "no existe" });
  });
}

function main() {
  const { values } = parseArgs({ options: { account: { type: "string" }, port: { type: "string" } } });
  const port = Number(values.port);
  if (!values.account || !/^[a-z0-9-]+$/i.test(values.account) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error("uso: node worker.mjs --account <cuenta> --port <puerto>");
    process.exit(2);
  }
  const key = fs.readFileSync(path.join(WORKERS_DIR, `${values.account}.key`), "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(key)) {
    console.error("llave inválida en el archivo de la cuenta");
    process.exit(2);
  }
  createWorker({ account: values.account, key }).listen(port, "127.0.0.1", () => {
    console.log(`trabajador agy "${values.account}" en 127.0.0.1:${port}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

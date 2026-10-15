import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { runOnWorker, workerHealth, WorkerUnavailableError } from "../../src/adapters/agy/worker-client.js";
import { execute } from "../../src/adapters/agy/execute.js";
import { parse } from "../../src/adapters/agy/parse.js";

const KEY = "a".repeat(64);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wk-"));
const keyPath = path.join(dir, "agy9.key");
fs.writeFileSync(keyPath, KEY + "\n");

const AGY_LINES = [
  { event: "init", conversation_id: "c-1", init: { model: "gemini-3.8-flash-low" } },
  { event: "step_update", step_update: { step_type: "agent_response", text_delta: "hola" } },
  { event: "result", result: { conversation_id: "c-1", status: "SUCCESS", response: "hola", usage: { input_tokens: 120, output_tokens: 8 } } },
].map((o) => JSON.stringify(o) + "\n");

interface Seen { path: string; auth?: string; body?: any }
let mode: "ok" | "quota" | "500" | "409" | "hang" | "cut" = "ok";
const seen: Seen[] = [];
let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const s: Seen = { path: req.url ?? "", auth: req.headers.authorization };
      try { s.body = raw ? JSON.parse(raw) : undefined; } catch { /* nada */ }
      seen.push(s);
      if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); res.end("{}"); return; }
      if (req.url === "/health") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, account: "agy9", version: "1", busy: false })); return; }
      if (req.url === "/cancel") { res.writeHead(200); res.end(JSON.stringify({ cancelled: true })); return; }
      if (mode === "500") { res.writeHead(500); res.end(JSON.stringify({ error: "error interno" })); return; }
      if (mode === "409") { res.writeHead(409); res.end(JSON.stringify({ error: "ocupado" })); return; }
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      if (mode === "hang") { res.write(AGY_LINES[0]); return; }
      if (mode === "cut") { res.write(AGY_LINES[0]); setTimeout(() => res.destroy(), 30); return; }
      if (mode === "quota") {
        res.write(JSON.stringify({ event: "worker:stderr", data: "error: 429 RESOURCE_EXHAUSTED quota exceeded" }) + "\n");
        res.end(JSON.stringify({ event: "worker:done", exitCode: 1, timedOut: false }) + "\n");
        return;
      }
      // Partido a la mitad de una línea para probar el armado por líneas.
      const all = AGY_LINES.join("");
      res.write(all.slice(0, 30));
      setTimeout(() => {
        res.write(all.slice(30));
        res.write(JSON.stringify({ event: "worker:stderr", data: "aviso" }) + "\n");
        res.end(JSON.stringify({ event: "worker:done", exitCode: 0, timedOut: false }) + "\n");
      }, 10);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { mode = "ok"; seen.length = 0; });

const body = { prompt: "di hola", cwd: "C:\\estudio\\x", model: "gemini-3.8-flash-low", readOnly: true, timeoutSec: 60 };

describe("cliente del trabajador agy", () => {
  it("health con la llave", async () => {
    expect(await workerHealth({ port, keyPath })).toEqual({ ok: true, account: "agy9", version: "1", busy: false });
    expect(seen[0].auth).toBe(`Bearer ${KEY}`);
  });

  it("/run: separa NDJSON de agy y stderr del trabajador; parse da lo mismo que agy local", async () => {
    const logs: string[] = [];
    const { promise } = runOnWorker({ port, keyPath }, body, { onLog: (s, c) => logs.push(`${s}:${c}`) });
    const out = await promise;
    expect(out).toMatchObject({ exitCode: 0, timedOut: false, stdout: AGY_LINES.join(""), stderr: "aviso" });
    expect(seen[0].body).toEqual(body);
    const parsed = parse(out);
    const local = parse({ exitCode: 0, signal: null, timedOut: false, stdout: AGY_LINES.join(""), stderr: "aviso" });
    expect(parsed).toEqual(local);
    expect(parsed).toMatchObject({ summary: "hola", inputTokens: 120, outputTokens: 8, sessionId: "c-1", errorFamily: null });
    expect(logs.some((l) => l.startsWith("stderr:aviso"))).toBe(true);
  });

  it("execute con agyWorker va al trabajador y la cuota se clasifica igual", async () => {
    mode = "quota";
    const r = await execute({ runId: "r", prompt: "x", cwd: "C:\\estudio", readOnly: false, agyWorker: { port, keyPath }, onLog: () => {} });
    expect(r.errorFamily).toBe("quota_exhausted");
    expect(seen.find((s) => s.path === "/run")?.body.readOnly).toBe(false);
  });

  it("execute de un paso lector manda readOnly:true al trabajador", async () => {
    await execute({ runId: "r", prompt: "x", cwd: "C:\\estudio", readOnly: true, agyWorker: { port, keyPath }, onLog: () => {} });
    expect(seen.find((s) => s.path === "/run")?.body.readOnly).toBe(true);
  });

  it("5xx, 409 y conexión rechazada → WorkerUnavailableError", async () => {
    mode = "500";
    await expect(runOnWorker({ port, keyPath }, body, { onLog: () => {} }).promise).rejects.toBeInstanceOf(WorkerUnavailableError);
    mode = "409";
    await expect(runOnWorker({ port, keyPath }, body, { onLog: () => {} }).promise).rejects.toBeInstanceOf(WorkerUnavailableError);
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    await expect(runOnWorker({ port: deadPort, keyPath }, body, { onLog: () => {} }).promise).rejects.toBeInstanceOf(WorkerUnavailableError);
  });

  it("llave inválida → no se manda nada y el error no trae su contenido", async () => {
    const bad = path.join(dir, "bad.key");
    fs.writeFileSync(bad, "secreto-no-hex");
    const err = await runOnWorker({ port, keyPath: bad }, body, { onLog: () => {} }).promise.catch((e) => e);
    expect(err).toBeInstanceOf(WorkerUnavailableError);
    expect(String(err.message)).not.toContain("secreto");
    expect(seen).toHaveLength(0);
  });

  it("kill llama /cancel y termina el run", async () => {
    mode = "hang";
    const h = runOnWorker({ port, keyPath }, body, { onLog: () => {} });
    await new Promise((r) => setTimeout(r, 50));
    h.kill();
    const out = await h.promise;
    expect(out.exitCode).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.some((s) => s.path === "/cancel")).toBe(true);
  });

  it("tope de tiempo del cliente: cancela y marca timedOut", async () => {
    mode = "hang";
    const out = await runOnWorker({ port, keyPath }, { ...body, timeoutSec: 0.05 }, { onLog: () => {}, graceSec: 0 }).promise;
    expect(out.timedOut).toBe(true);
    expect(parse(out).errorFamily).toBe("timeout");
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.some((s) => s.path === "/cancel")).toBe(true);
  });

  it("conexión cortada a media respuesta → falla (no 'no disponible')", async () => {
    mode = "cut";
    const out = await runOnWorker({ port, keyPath }, body, { onLog: () => {} }).promise;
    expect(out.exitCode).toBe(-1);
    expect(parse(out).exitCode).not.toBe(0);
  });
});

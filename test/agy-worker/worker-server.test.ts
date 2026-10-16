import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorker } from "../../scripts/agy-worker/worker.mjs";

const KEY = "f".repeat(64);
const FAKE_AGY = path.join(import.meta.dirname, "fake-agy.mjs");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agyw-srv-")));
const server = createWorker({
  account: "prueba",
  key: KEY,
  root,
  agyPath: process.execPath,
  agyPrefixArgs: [FAKE_AGY],
});
let base = "";

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const auth = { Authorization: `Bearer ${KEY}` };

function run(body: unknown, headers: Record<string, string> = auth) {
  return fetch(`${base}/run`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function events(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("trabajador agy", () => {
  it("sin llave o con llave incorrecta → 401 sin datos", async () => {
    const a = await fetch(`${base}/health`);
    expect(a.status).toBe(401);
    expect(await a.text()).not.toContain("prueba");
    const b = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${"0".repeat(64)}` } });
    expect(b.status).toBe(401);
    expect((await run({ prompt: "x", cwd: root }, {})).status).toBe(401);
  });

  it("GET /health con llave", async () => {
    const res = await fetch(`${base}/health`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, account: "prueba", version: expect.any(String) });
  });

  it("POST /run transmite los eventos de agy y termina con worker:done", async () => {
    process.env.TYPESAFE_API_KEY = "secreto";
    try {
      const res = await run({ prompt: "hola", model: "gemini-3.8-flash-low", cwd: root, readOnly: true });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");
      const evs = await events(res);
      expect(evs.map((e) => e.event)).toEqual(["init", "step_update", "result", "worker:done"]);
      expect(evs[0].cwd).toBe(root);
      const result = evs[2];
      expect(result.prompt).toBe("hola");
      expect(result.secretVisible).toBe(false);
      expect(result.args).toEqual([
        "--input-format", "stream-json", "--output-format", "stream-json", "--print=",
        "--model", "gemini-3.8-flash-low",
      ]);
      expect(evs[3]).toEqual({ event: "worker:done", exitCode: 0, timedOut: false });
    } finally {
      delete process.env.TYPESAFE_API_KEY;
    }
  });

  it("readOnly:false agrega --dangerously-skip-permissions y reporta el exitCode", async () => {
    const evs = await events(await run({ prompt: "FALLA", cwd: root, readOnly: false }));
    expect(evs.find((e) => e.event === "result")?.args).toContain("--dangerously-skip-permissions");
    expect(evs.at(-1)).toMatchObject({ event: "worker:done", exitCode: 3 });
  });

  it("cwd fuera de la raíz o cuerpo inválido → 400", async () => {
    expect((await run({ prompt: "x", cwd: os.tmpdir() })).status).toBe(400);
    expect((await run({ prompt: "x", cwd: `${root}${path.sep}..` })).status).toBe(400);
    expect((await run({ cwd: root })).status).toBe(400);
  });

  it("ocupado → 409; /cancel mata el paso y libera", async () => {
    const slow = run({ prompt: "LENTO", cwd: root });
    const first = await slow;
    expect(first.status).toBe(200);
    expect((await run({ prompt: "x", cwd: root })).status).toBe(409);
    const cancel = await fetch(`${base}/cancel`, { method: "POST", headers: auth });
    expect(await cancel.json()).toEqual({ cancelled: true });
    const evs = await events(first);
    expect(evs.at(-1)?.event).toBe("worker:done");
    expect(evs.at(-1)?.exitCode).not.toBe(0);
    const again = await run({ prompt: "x", cwd: root });
    expect(again.status).toBe(200);
    await again.text(); // termina el paso antes del siguiente test
  }, 20_000);

  it("/run da un id de corrida; /cancel con un id viejo no mata la corrida actual, con el suyo sí", async () => {
    const first = await run({ prompt: "LENTO", cwd: root });
    const runId = first.headers.get("x-run-id");
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    const cancel = (b: unknown) => fetch(`${base}/cancel`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
    expect(await cancel({ runId: "00000000-0000-0000-0000-000000000000" })).toEqual({ cancelled: false });
    expect(((await (await fetch(`${base}/health`, { headers: auth })).json()) as { busy: boolean }).busy).toBe(true);
    expect(await cancel({ runId })).toEqual({ cancelled: true });
    const evs = await events(first);
    expect(evs.at(-1)?.event).toBe("worker:done");
  }, 20_000);

  it("timeoutSec mata agy y reporta timedOut", async () => {
    const evs = await events(await run({ prompt: "LENTO", cwd: root, timeoutSec: 1 }));
    expect(evs.at(-1)).toMatchObject({ event: "worker:done", timedOut: true });
  }, 20_000);

  it("cuerpo de más de 1 MB → 413", async () => {
    expect((await run({ prompt: "x".repeat(1_100_000), cwd: root })).status).toBe(413);
  });

  it("ruta desconocida con llave → 404", async () => {
    expect((await fetch(`${base}/otra`, { headers: auth })).status).toBe(404);
  });
});

describe("trabajador agy: spawn que lanza síncrono", () => {
  it("responde worker:done -1 y libera el trabajador", async () => {
    const bad = createWorker({ account: "malo", key: KEY, root, agyPath: "agy\0.exe" });
    await new Promise<void>((r) => bad.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(bad.address() as AddressInfo).port}`;
    try {
      for (let i = 0; i < 2; i++) { // la 2ª no puede dar 409: la 1ª soltó el trabajador
        const res = await fetch(`${url}/run`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "x", cwd: root }) });
        expect(res.status).toBe(200);
        const evs = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
        expect(evs.at(-1)).toEqual({ event: "worker:done", exitCode: -1, timedOut: false });
      }
    } finally {
      await new Promise<void>((r) => bad.close(() => r()));
    }
  });
});

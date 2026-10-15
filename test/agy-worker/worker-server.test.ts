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
    expect((await run({ prompt: "x", cwd: root })).status).toBe(200);
  }, 20_000);

  it("ruta desconocida con llave → 404", async () => {
    expect((await fetch(`${base}/otra`, { headers: auth })).status).toBe(404);
  });
});

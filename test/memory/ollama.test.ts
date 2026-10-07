import { describe, it, expect, vi } from "vitest";
import { createOllamaEmbedder, ollamaHealth } from "../../src/memory/ollama.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("createOllamaEmbedder", () => {
  it("manda {model,input} a /api/embed y devuelve embeddings", async () => {
    const fetchImpl = vi.fn(async () => json({ embeddings: [[1, 2], [3, 4]] }));
    const emb = createOllamaEmbedder({ url: "http://x:1/", model: "m", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await emb(["a", "b"])).toEqual([[1, 2], [3, 4]]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://x:1/api/embed");
    expect(JSON.parse(init.body as string)).toEqual({ model: "m", input: ["a", "b"], keep_alive: "30m" });
  });

  it("error HTTP, JSON sin embeddings, cantidad distinta, excepcion y timeout -> null", async () => {
    const mk = (f: () => Promise<Response>) => createOllamaEmbedder({ fetchImpl: f as unknown as typeof fetch, timeoutMs: 50 });
    expect(await mk(async () => json({}, 500))(["a"])).toBeNull();
    expect(await mk(async () => json({ nada: 1 }))(["a"])).toBeNull();
    expect(await mk(async () => json({ embeddings: [[1], [2]] }))(["a"])).toBeNull();
    expect(await mk(async () => { throw new Error("boom"); })(["a"])).toBeNull();
    expect(await mk(() => new Promise<Response>(() => {}))(["a"])).toBeNull();
  });
});

describe("validacion de vectores", () => {
  const mk = (embeddings: unknown, n = 2) =>
    createOllamaEmbedder({ fetchImpl: (async () => json({ embeddings })) as unknown as typeof fetch })(Array(n).fill("x"));
  it("vacio, no numerico, no finito o de distinta dimension -> null", async () => {
    expect(await mk([[], [1]])).toBeNull();
    expect(await mk([["a"], [1]])).toBeNull();
    expect(await mk([[1, null], [1, 2]])).toBeNull();
    expect(await mk([[1, 2], [1]])).toBeNull();
    expect(await mk([[1, 2], [3, 4]])).toEqual([[1, 2], [3, 4]]);
  });
});

describe("ollamaHealth", () => {
  const f = (body: unknown, status = 200) => (async () => json(body, status)) as unknown as typeof fetch;
  it("detecta bge-m3 y bge-m3:latest", async () => {
    expect(await ollamaHealth({ fetchImpl: f({ models: [{ name: "bge-m3:latest" }] }) })).toEqual({ ok: true, modelAvailable: true });
    expect(await ollamaHealth({ fetchImpl: f({ models: [{ name: "bge-m3" }] }) })).toEqual({ ok: true, modelAvailable: true });
    expect(await ollamaHealth({ fetchImpl: f({ models: [{ name: "llama3" }] }) })).toEqual({ ok: true, modelAvailable: false });
  });
  it("caido o con error -> ok false", async () => {
    expect(await ollamaHealth({ fetchImpl: f({}, 500) })).toEqual({ ok: false, modelAvailable: false });
    const boom = (async () => { throw new Error("x"); }) as unknown as typeof fetch;
    expect(await ollamaHealth({ fetchImpl: boom })).toEqual({ ok: false, modelAvailable: false });
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const h = vi.hoisted(() => ({
  files: [] as string[],
  status: vi.fn(() => "stopped"),
  transcribe: vi.fn(async (_b: Buffer): Promise<string | null> => "hola"),
  toWav: vi.fn(async (_b: Buffer): Promise<Buffer> => Buffer.from("WAV")),
  synth: vi.fn(async (_t: string): Promise<Buffer | null> => Buffer.from("RIFFDATA")),
  dir: "",
  ducker: {
    supported: vi.fn(() => true),
    acquire: vi.fn(async (_r: string, _b: string[]) => ({ supported: true, active: ["mic"] })),
    release: vi.fn(async (_r: string) => ({ supported: true, active: [] })),
  },
}));

vi.mock("../../src/voice/config.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/voice/config.js")>("../../src/voice/config.js");
  return {
    ...actual,
    voiceConfig: () => ({
      ...actual.voiceConfig({}),
      whisperExe: path.join(h.dir, "w.exe"),
      whisperModel: path.join(h.dir, "w.bin"),
      piperExe: path.join(h.dir, "p.exe"),
      voiceModel: path.join(h.dir, "v.onnx"),
      voiceName: "es_MX-test",
    }),
  };
});
vi.mock("../../src/voice/whisper.js", () => ({ whisper: { status: h.status, transcribe: h.transcribe, stop: vi.fn() } }));
vi.mock("../../src/voice/audio.js", () => ({ toWav16k: h.toWav }));
const { AudioTooLongError } = await import("../../src/voice/limits.js");
vi.mock("../../src/voice/duck.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/voice/duck.js")>("../../src/voice/duck.js");
  return { ...actual, getDucker: () => h.ducker };
});
vi.mock("../../src/voice/piper.js", () => ({ synthesize: h.synth }));

h.dir = fs.mkdtempSync(path.join(os.tmpdir(), "voz-route-"));
const { default: voiceRoute, MAX_AUDIO_BYTES, MAX_WAV_BYTES } = await import("../../src/server/routes/voice.js");

const touch = (n: string) => fs.writeFileSync(path.join(h.dir, n), "x");
beforeEach(() => {
  for (const f of fs.readdirSync(h.dir)) fs.rmSync(path.join(h.dir, f));
  h.status.mockReturnValue("stopped");
  h.transcribe.mockReset().mockResolvedValue("hola");
  h.toWav.mockReset().mockResolvedValue(Buffer.from("WAV"));
  h.synth.mockReset().mockResolvedValue(Buffer.from("RIFFDATA"));
});

const post = (p: string, body: string | Uint8Array, type: string) =>
  voiceRoute.request(p, { method: "POST", body, headers: { "Content-Type": type } });

describe("GET /status", () => {
  it("nada instalado -> no disponible", async () => {
    const b = await (await voiceRoute.request("/status")).json();
    expect(b).toEqual({ whisper: { available: false, state: "stopped" }, piper: { available: false, voice: "es_MX-test" }, duck: { supported: true, enabled: true } });
  });
  it("todo instalado -> disponible y refleja el estado", async () => {
    ["w.exe", "w.bin", "p.exe", "v.onnx"].forEach(touch);
    h.status.mockReturnValue("ready");
    const b = await (await voiceRoute.request("/status")).json();
    expect(b).toEqual({ whisper: { available: true, state: "ready" }, piper: { available: true, voice: "es_MX-test" }, duck: { supported: true, enabled: true } });
  });
});

describe("POST /transcribe", () => {
  it("415 si no es audio/*", async () => {
    expect((await post("/transcribe", "x", "application/json")).status).toBe(415);
  });
  it("413 si supera 10 MB", async () => {
    const res = await post("/transcribe", new Uint8Array(MAX_AUDIO_BYTES + 1), "audio/webm");
    expect(res.status).toBe(413);
    expect(h.toWav).not.toHaveBeenCalled();
  });
  it("413 si el WAV resultante supera 120 s", async () => {
    h.toWav.mockResolvedValueOnce(Buffer.alloc(MAX_WAV_BYTES + 1));
    expect((await post("/transcribe", "abc", "audio/webm")).status).toBe(413);
    expect(h.transcribe).not.toHaveBeenCalled();
  });
  it("413 si ffmpeg/toWav16k reporta audio demasiado largo", async () => {
    h.toWav.mockRejectedValueOnce(new AudioTooLongError());
    expect((await post("/transcribe", "abc", "audio/webm")).status).toBe(413);
    expect(h.transcribe).not.toHaveBeenCalled();
  });
  it("413 si el cuerpo real supera 10 MB aunque no declare Content-Length", async () => {
    const big = new Uint8Array(MAX_AUDIO_BYTES + 1);
    const res = await voiceRoute.request("/transcribe", {
      method: "POST",
      headers: { "Content-Type": "audio/webm", "Transfer-Encoding": "chunked" },
      body: new ReadableStream({ start(c) { c.enqueue(big); c.close(); } }),
      duplex: "half",
    });
    expect(res.status).toBe(413);
  });
  it("convierte, transcribe y devuelve { text }", async () => {
    const res = await post("/transcribe", "abc", "audio/webm;codecs=opus");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "hola" });
    expect(h.toWav.mock.calls[0][0].toString()).toBe("abc");
    expect(h.transcribe.mock.calls[0][0].toString()).toBe("WAV");
  });
  it("503 si Whisper devuelve null", async () => {
    h.transcribe.mockResolvedValueOnce(null);
    const res = await post("/transcribe", "abc", "audio/webm");
    expect(res.status).toBe(503);
    expect(await res.json()).toHaveProperty("error");
  });
  it("503 si ffmpeg falla", async () => {
    h.toWav.mockRejectedValueOnce(new Error("ffmpeg"));
    expect((await post("/transcribe", "abc", "audio/webm")).status).toBe(503);
  });
});

describe("POST /speak", () => {
  const speak = (body: unknown) => post("/speak", JSON.stringify(body), "application/json");
  it("devuelve audio/wav con el texto hablable", async () => {
    const res = await speak({ text: "# Hola **mundo**" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("RIFFDATA");
    expect(h.synth).toHaveBeenCalledWith("Hola mundo");
  });
  it("summary=true resume a 3 oraciones", async () => {
    await speak({ text: "Uno. Dos. Tres. Cuatro.", summary: true });
    expect(h.synth).toHaveBeenCalledWith("Uno. Dos. Tres.");
  });
  it("400 si el texto queda vacío o falta", async () => {
    expect((await speak({ text: "   " })).status).toBe(400);
    expect((await speak({ text: "```\ncodigo\n```" })).status).toBe(200); // "(código)"
    expect((await speak({})).status).toBe(400);
    expect((await post("/speak", "no json", "application/json")).status).toBe(400);
  });
  it("413 si el JSON supera 64 KB y recorta el texto antes de procesarlo", async () => {
    expect((await speak({ text: "a".repeat(70 * 1024) })).status).toBe(413);
    expect(h.synth).not.toHaveBeenCalled();
    const t0 = performance.now();
    const ok = await speak({ text: "x".repeat(60 * 1024), summary: true });
    expect(ok.status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
  it("503 si Piper falla", async () => {
    h.synth.mockResolvedValueOnce(null);
    expect((await speak({ text: "hola" })).status).toBe(503);
  });
});

describe("POST /duck", () => {
  const duck = (body: string, ua?: string) =>
    voiceRoute.request("/duck", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json", ...(ua ? { "User-Agent": ua } : {}) },
    });
  it("on:true adquiere con los procesos del navegador del User-Agent", async () => {
    const r = await duck('{"reason":"speak","on":true}', "Mozilla/5.0 Firefox/130.0");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ supported: true, active: ["mic"] });
    expect(h.ducker.acquire).toHaveBeenCalledWith("speak", ["firefox"]);
  });
  it("acepta un Blob JSON como el de navigator.sendBeacon (pagehide)", async () => {
    const r = await voiceRoute.request("/duck", {
      method: "POST",
      body: new Blob(['{"reason":"mic","on":false}'], { type: "application/json" }),
    });
    expect(r.status).toBe(200);
    expect(h.ducker.release).toHaveBeenCalledWith("mic");
  });
  it("on:false libera", async () => {
    const r = await duck('{"reason":"mic","on":false}');
    expect(await r.json()).toEqual({ supported: true, active: [] });
    expect(h.ducker.release).toHaveBeenCalledWith("mic");
  });
  it.each([['{"reason":"x","on":true}'], ['{"reason":"mic","on":"yes"}'], ['{"reason":"mic"}'], ["null"], ["no json"]])(
    "rechaza %s con 400",
    async (b) => {
      expect((await duck(b)).status).toBe(400);
    },
  );
  it("cuerpo enorme -> 413", async () => {
    expect((await duck(JSON.stringify({ reason: "mic", on: true, pad: "x".repeat(5000) }))).status).toBe(413);
  });
});

describe("seguridad: Origin, Content-Type y concurrencia (I4)", () => {
  const send = (p: string, body: string, headers: Record<string, string>) =>
    voiceRoute.request(p, { method: "POST", body, headers });
  const json = { "Content-Type": "application/json" };

  it.each(["http://127.0.0.1:3100", "http://localhost:3100", "http://127.0.0.1:5173", "http://localhost:5173"])(
    "acepta Origin %s",
    async (origin) => {
      expect((await send("/duck", '{"reason":"mic","on":false}', { ...json, Origin: origin })).status).toBe(200);
    },
  );
  it("rechaza Origin ajeno con 403 y no toca el ducker", async () => {
    h.ducker.acquire.mockClear();
    const r = await send("/duck", '{"reason":"mic","on":true}', { ...json, Origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(h.ducker.acquire).not.toHaveBeenCalled();
    expect((await send("/speak", '{"text":"hola"}', { ...json, Origin: "null" })).status).toBe(403);
  });
  it("rechaza Sec-Fetch-Site: cross-site", async () => {
    expect((await send("/duck", '{"reason":"mic","on":false}', { ...json, "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  });
  it("/duck y /speak exigen application/json (415 con text/plain)", async () => {
    expect((await send("/duck", '{"reason":"mic","on":true}', { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await send("/speak", '{"text":"hola"}', { "Content-Type": "text/plain" })).status).toBe(415);
  });
  it("tope de /speak simultáneos -> 429 y se libera al terminar", async () => {
    touch("p.exe");
    const gates: Array<(b: Buffer) => void> = [];
    h.synth.mockImplementation(() => new Promise<Buffer | null>((res) => gates.push(res)));
    const speak = () => send("/speak", '{"text":"hola"}', json);
    const a = speak();
    const b = speak();
    await new Promise((r) => setTimeout(r, 10));
    expect((await speak()).status).toBe(429);
    gates.forEach((g) => g(Buffer.from("RIFF")));
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    h.synth.mockResolvedValue(Buffer.from("RIFF"));
    expect((await speak()).status).toBe(200);
  });
  it("tope de /transcribe simultáneos -> 429", async () => {
    const gates: Array<(t: string) => void> = [];
    h.transcribe.mockImplementation(() => new Promise<string | null>((res) => gates.push(res)));
    const tr = () => send("/transcribe", "audio", { "Content-Type": "audio/webm" });
    const a = tr();
    const b = tr();
    await new Promise((r) => setTimeout(r, 10));
    expect((await tr()).status).toBe(429);
    gates.forEach((g) => g("hola"));
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
  });
});

import { describe, it, expect, vi } from "vitest";
import { buildWhisperServerArgs, createWhisper, silentWav, type WhisperDeps } from "../../src/voice/whisper.js";
import { voiceConfig } from "../../src/voice/config.js";

const cfg = voiceConfig({});

function makeDeps(over: Partial<{ healthyAfter: number; inference: () => Response | Promise<Response> }> = {}) {
  let healthCalls = 0;
  const exitCbs: Array<() => void> = [];
  const kill = vi.fn();
  const spawnServer = vi.fn((_args: string[]) => ({ kill, onExit: (cb: () => void) => { exitCbs.push(cb); } }));
  const inferenceBodies: FormData[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/inference")) {
      inferenceBodies.push(init?.body as FormData);
      return over.inference ? over.inference() : new Response(JSON.stringify({ text: "  hola mundo \n" }), { status: 200 });
    }
    healthCalls++;
    if (healthCalls <= (over.healthyAfter ?? 0)) throw new Error("ECONNREFUSED");
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const wait = vi.fn(async () => {});
  const deps: WhisperDeps = { spawnServer, fetchImpl, wait, exists: () => true };
  return { deps, spawnServer, fetchImpl, wait, kill, exitCbs, inferenceBodies };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("buildWhisperServerArgs", () => {
  it("args exactos, solo 127.0.0.1", () => {
    expect(buildWhisperServerArgs(cfg)).toEqual(["-m", cfg.whisperModel, "--host", "127.0.0.1", "--port", "8091", "-l", "es"]);
  });
});

describe("silentWav", () => {
  it("WAV 16 kHz mono s16 de 1 s", () => {
    const w = silentWav(1);
    expect(w.length).toBe(44 + 32000);
    expect(w.toString("ascii", 0, 4)).toBe("RIFF");
    expect(w.readUInt32LE(24)).toBe(16000);
    expect(w.readUInt16LE(22)).toBe(1);
  });
});

describe("createWhisper", () => {
  it("espera la salud, calienta una vez y queda ready", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const m = makeDeps({
      healthyAfter: 3,
      inference: async () => { await gate; return new Response(JSON.stringify({ text: "" }), { status: 200 }); },
    });
    const w = createWhisper(cfg, m.deps);
    expect(w.status()).toBe("stopped");
    expect(await w.ensureStarted()).toBe(true);
    expect(m.wait).toHaveBeenCalledTimes(3);
    expect(m.spawnServer).toHaveBeenCalledWith(buildWhisperServerArgs(cfg));
    expect(w.status()).toBe("warming");
    release();
    await flush();
    expect(w.status()).toBe("ready");
    expect(m.inferenceBodies).toHaveLength(1); // calentamiento
    await w.ensureStarted();
    expect(m.inferenceBodies).toHaveLength(1);
  });

  it("llamadas concurrentes comparten un solo spawn", async () => {
    const m = makeDeps({ healthyAfter: 1 });
    const w = createWhisper(cfg, m.deps);
    const r = await Promise.all([w.ensureStarted(), w.ensureStarted(), w.transcribe(silentWav(1))]);
    expect(r[0]).toBe(true);
    expect(m.spawnServer).toHaveBeenCalledTimes(1);
  });

  it("exe o modelo faltante -> failed y false, sin lanzar", async () => {
    const m = makeDeps();
    m.deps.exists = (p) => p !== cfg.whisperModel;
    const w = createWhisper(cfg, m.deps);
    expect(await w.ensureStarted()).toBe(false);
    expect(w.status()).toBe("failed");
    expect(m.spawnServer).not.toHaveBeenCalled();
    expect(await w.transcribe(Buffer.alloc(10))).toBeNull();
  });

  it("transcribe: {text} -> texto recortado, con campos del formulario", async () => {
    const m = makeDeps();
    const w = createWhisper(cfg, m.deps);
    expect(await w.transcribe(silentWav(1))).toBe("hola mundo");
    const form = m.inferenceBodies.at(-1)!;
    expect(form.get("response_format")).toBe("json");
    expect(form.get("language")).toBe("es");
    expect((form.get("file") as File).type).toBe("audio/wav");
  });

  it("error HTTP o excepción -> null", async () => {
    const m = makeDeps({ inference: () => new Response("x", { status: 500 }) });
    const w = createWhisper(cfg, m.deps);
    expect(await w.transcribe(silentWav(1))).toBeNull();
    const m2 = makeDeps({ inference: () => { throw new Error("timeout"); } });
    expect(await createWhisper(cfg, m2.deps).transcribe(silentWav(1))).toBeNull();
  });

  it("salud nunca responde -> failed y mata el proceso", async () => {
    const m = makeDeps({ healthyAfter: 10_000 });
    const w = createWhisper(cfg, m.deps);
    expect(await w.ensureStarted()).toBe(false);
    expect(w.status()).toBe("failed");
    expect(m.kill).toHaveBeenCalled();
  });

  it("si el proceso muere vuelve a stopped y relanza en la siguiente llamada", async () => {
    const m = makeDeps();
    const w = createWhisper(cfg, m.deps);
    await w.ensureStarted();
    await flush();
    expect(w.status()).toBe("ready");
    m.exitCbs[0]();
    expect(w.status()).toBe("stopped");
    expect(await w.ensureStarted()).toBe(true);
    expect(m.spawnServer).toHaveBeenCalledTimes(2);
  });

  it("stop() mata el proceso y deja stopped", async () => {
    const m = makeDeps();
    const w = createWhisper(cfg, m.deps);
    await w.ensureStarted();
    w.stop();
    expect(m.kill).toHaveBeenCalledTimes(1);
    expect(w.status()).toBe("stopped");
  });
});
